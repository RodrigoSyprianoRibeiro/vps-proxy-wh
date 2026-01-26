const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");

const app = express();
const PORT = 3000;

// Targets
const TARGET_CDN = "https://sports.whcdn.net";
const TARGET_API = "https://sports.williamhill.com";
const WS_HOST = "scoreboards-push.williamhill.com";

// Timeouts
const PROXY_TIMEOUT = 30000;

// Headers para CDN (scoreboard/radar) - sem compressão para facilitar substituição de URLs
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-GB,en;q=0.9,en-US;q=0.8",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Referer": "https://sports.williamhill.com/",
  "Origin": "https://sports.williamhill.com",
};

// Headers para requisições da API (lista de jogos)
const API_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9,en-US;q=0.8",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Referer": "https://sports.williamhill.com/betting/en-gb",
  "Origin": "https://sports.williamhill.com",
  "Cookie": "country=GB; language=en-gb; oddsFormat=fractional; OptanonAlertBoxClosed=2024-01-01T00:00:00.000Z",
};

// Middleware CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// Estatísticas endpoint
app.get("/stats", (req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    requests: requestStats,
  });
});

// Contador de requisições
const requestStats = {
  cdn: 0,
  api: 0,
  ws: 0,
  errors: 0,
};

function isBinary(contentType) {
  if (!contentType) return false;
  return contentType.includes("font") ||
         contentType.includes("image") ||
         contentType.includes("octet-stream") ||
         contentType.includes("woff");
}

function replaceUrls(content, host) {
  let result = content;
  result = result.replace(/sports\.whcdn\.net/g, host);
  result = result.replace(/scoreboards-push\.williamhill\.com/g, host);
  result = result.replace(/streaming\.williamhill\.\{TLD\}/g, host);
  result = result.replace(/streaming\.williamhill\.com/g, host);
  return result;
}

// Script injetado no HTML para detectar eventos e notificar janela pai
// IMPORTANTE: Tem flag de inicializacao para ignorar eventos existentes no carregamento
const SOUND_NOTIFICATION_SCRIPT = `
<script>
(function() {
  // Flag para ignorar eventos durante inicializacao
  let isInitialized = false;

  // Armazena estado anterior para detectar mudancas
  let lastState = {
    homeGoals: null,
    awayGoals: null,
    homeCorners: null,
    awayCorners: null,
    homeDanger: null,
    awayDanger: null,
    incidents: new Set()
  };

  // Envia mensagem para janela pai (apenas apos inicializacao)
  function notifyParent(eventType, data) {
    // Ignora notificacoes durante inicializacao
    if (!isInitialized) return;

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          source: 'williamhill-scoreboard',
          type: eventType,
          data: data
        }, '*');
      }
    } catch (e) {}
  }

  // Detecta eventos no DOM
  function checkForEvents() {
    try {
      // Detecta gols pelo placar
      const scoreElements = document.querySelectorAll('[class*="score"], [class*="Score"]');
      scoreElements.forEach(el => {
        const text = el.textContent.trim();
        const match = text.match(/^(\\d+)\\s*[-:]\\s*(\\d+)$/);
        if (match) {
          const homeGoals = parseInt(match[1]);
          const awayGoals = parseInt(match[2]);
          if (lastState.homeGoals !== null && (homeGoals > lastState.homeGoals || awayGoals > lastState.awayGoals)) {
            notifyParent('goal', { home: homeGoals, away: awayGoals });
          }
          lastState.homeGoals = homeGoals;
          lastState.awayGoals = awayGoals;
        }
      });

      // Detecta incidentes na timeline
      const incidents = document.querySelectorAll('[class*="incident"], [class*="Incident"], [class*="event"], [class*="Event"]');
      incidents.forEach(el => {
        const id = el.id || el.textContent.substring(0, 50);
        if (!lastState.incidents.has(id)) {
          lastState.incidents.add(id);
          const classes = el.className.toLowerCase();
          const text = el.textContent.toLowerCase();

          // Detecta tipo de evento (notifica apenas se ja inicializado)
          if (classes.includes('goal') || text.includes('goal')) {
            notifyParent('goal', {});
          } else if (classes.includes('corner') || text.includes('corner')) {
            notifyParent('corner', {});
          } else if (classes.includes('danger') || text.includes('danger')) {
            notifyParent('dangerattack', {});
          } else if (classes.includes('penalty') || text.includes('penalty')) {
            notifyParent('penaltymissed', {});
          } else if (classes.includes('red') || text.includes('red card')) {
            notifyParent('redcard', {});
          }
        }
      });

      // Detecta dangerous attacks pelo contador
      const dangerElements = document.querySelectorAll('[class*="danger"], [class*="Danger"]');
      dangerElements.forEach(el => {
        const num = parseInt(el.textContent);
        if (!isNaN(num) && num > 0) {
          const isHome = el.closest('[class*="home"], [class*="Home"]');
          if (isHome && lastState.homeDanger !== null && num > lastState.homeDanger) {
            notifyParent('dangerattack', { team: 'home' });
          } else if (!isHome && lastState.awayDanger !== null && num > lastState.awayDanger) {
            notifyParent('dangerattack', { team: 'away' });
          }
          if (isHome) lastState.homeDanger = num;
          else lastState.awayDanger = num;
        }
      });

    } catch (e) {}
  }

  // Observa mudancas no DOM
  const observer = new MutationObserver(function(mutations) {
    checkForEvents();
  });

  // Inicia observacao quando DOM estiver pronto
  function init() {
    // Faz primeira varredura para registrar estado inicial (sem notificar)
    checkForEvents();

    // Inicia observacao
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Verifica periodicamente tambem
    setInterval(checkForEvents, 2000);

    // Apos 3 segundos, ativa notificacoes (ignora eventos existentes)
    setTimeout(function() {
      isInitialized = true;
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
`;

// Injeta script de notificacao de som no HTML
function injectSoundScript(content) {
  // Injeta antes do </body>
  if (content.includes('</body>')) {
    return content.replace('</body>', SOUND_NOTIFICATION_SCRIPT + '</body>');
  }
  // Ou antes do </html>
  if (content.includes('</html>')) {
    return content.replace('</html>', SOUND_NOTIFICATION_SCRIPT + '</html>');
  }
  // Ou no final
  return content + SOUND_NOTIFICATION_SCRIPT;
}

// ====================================
// ROTA: /wh-api/* -> sports.williamhill.com
// Usada pelo crawler para buscar lista de jogos
// ====================================
app.use("/wh-api", createProxyMiddleware({
  target: TARGET_API,
  changeOrigin: true,
  selfHandleResponse: true,
  proxyTimeout: PROXY_TIMEOUT,
  timeout: PROXY_TIMEOUT,
  followRedirects: true,
  pathRewrite: {
    "^/wh-api": "",
  },
  onProxyReq: (proxyReq, req) => {
    requestStats.api++;

    // Remove headers que podem revelar o proxy
    proxyReq.removeHeader('x-forwarded-for');
    proxyReq.removeHeader('x-forwarded-host');
    proxyReq.removeHeader('x-forwarded-proto');
    proxyReq.removeHeader('x-real-ip');
    proxyReq.removeHeader('via');

    // Aplica headers do navegador
    Object.entries(API_HEADERS).forEach(([k, v]) => proxyReq.setHeader(k, v));

    // Host correto
    proxyReq.setHeader('Host', 'sports.williamhill.com');

    const targetPath = req.url.replace('/wh-api', '') || '/';
    console.log(`[API] ${req.method} ${targetPath} -> ${TARGET_API}${targetPath}`);
  },
  onProxyRes: (proxyRes, req, res) => {
    const contentType = proxyRes.headers["content-type"] || "";

    console.log(`[API] Response: ${proxyRes.statusCode} - ${contentType.substring(0, 50)}`);

    // Copiar headers (exceto os problemáticos)
    Object.keys(proxyRes.headers).forEach(key => {
      if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy'].includes(key)) {
        res.setHeader(key, proxyRes.headers[key]);
      }
    });
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (isBinary(contentType)) {
      proxyRes.pipe(res);
      return;
    }

    const chunks = [];
    proxyRes.on("data", chunk => chunks.push(chunk));
    proxyRes.on("end", () => {
      try {
        let body = Buffer.concat(chunks).toString("utf8");
        res.status(proxyRes.statusCode);
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
      } catch (e) {
        console.error(`[API PARSE ERROR] ${e.message}`);
        requestStats.errors++;
        if (!res.headersSent) {
          res.status(500).json({ error: "Parse error", message: e.message });
        }
      }
    });
    proxyRes.on("error", (e) => {
      console.error(`[API RESPONSE ERROR] ${e.message}`);
      requestStats.errors++;
      if (!res.headersSent) {
        res.status(500).json({ error: "Response error", message: e.message });
      }
    });
  },
  onError: (err, req, res) => {
    console.error(`[API ERROR] ${err.message}`);
    requestStats.errors++;
    if (!res.headersSent) {
      res.status(502).json({ error: "Proxy error", message: err.message });
    }
  },
}));

// ====================================
// ROTA: /* -> sports.whcdn.net (CDN)
// Usada para scoreboard/radar
// ====================================
app.use("/", createProxyMiddleware({
  target: TARGET_CDN,
  changeOrigin: true,
  selfHandleResponse: true,
  proxyTimeout: PROXY_TIMEOUT,
  timeout: PROXY_TIMEOUT,
  onProxyReq: (proxyReq, req) => {
    requestStats.cdn++;
    console.log(`[CDN] ${req.method} ${req.url}`);
    Object.entries(BROWSER_HEADERS).forEach(([k, v]) => proxyReq.setHeader(k, v));
  },
  onProxyRes: (proxyRes, req, res) => {
    const contentType = proxyRes.headers["content-type"] || "";
    const host = req.headers.host || "radarfutebol.xyz";

    Object.keys(proxyRes.headers).forEach(key => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key)) {
        res.setHeader(key, proxyRes.headers[key]);
      }
    });
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (isBinary(contentType)) {
      proxyRes.pipe(res);
      return;
    }

    const chunks = [];
    proxyRes.on("data", chunk => chunks.push(chunk));
    proxyRes.on("end", () => {
      try {
        let body = Buffer.concat(chunks).toString("utf8");

        if (contentType.includes("html") || contentType.includes("javascript") || contentType.includes("css")) {
          body = replaceUrls(body, host);
        }

        // Injeta script de notificacao de som no HTML do scoreboard
        if (contentType.includes("html") && req.url.includes("/scoreboards/")) {
          body = injectSoundScript(body);
        }

        res.status(proxyRes.statusCode);
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
      } catch (e) {
        console.error(`[CDN PARSE ERROR] ${e.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: "Parse error", message: e.message });
        }
      }
    });
    proxyRes.on("error", (e) => {
      console.error(`[CDN RESPONSE ERROR] ${e.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Response error", message: e.message });
      }
    });
  },
  onError: (err, req, res) => {
    console.error(`[CDN ERROR] ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: "Proxy error", message: err.message });
    }
  },
}));

const server = http.createServer(app);

// ====================================
// WebSocket Proxy para /diffusion
// ====================================
const wss = new WebSocketServer({ server, path: "/diffusion" });
wss.on("connection", (clientWs, req) => {
  requestStats.ws++;
  const qs = req.url.includes("?") ? req.url.split("?")[1] : "";
  const wsUrl = "wss://" + WS_HOST + "/diffusion" + (qs ? "?" + qs : "");
  console.log("[WS] Connecting to:", wsUrl);

  const targetWs = new WebSocket(wsUrl, {
    headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], "Origin": "https://sports.whcdn.net" }
  });

  targetWs.on("open", () => console.log("[WS] Connected"));
  targetWs.on("message", d => clientWs.readyState === 1 && clientWs.send(d));
  clientWs.on("message", d => targetWs.readyState === 1 && targetWs.send(d));
  targetWs.on("close", (c, r) => { try { clientWs.close(c, r); } catch(e){} });
  clientWs.on("close", (c, r) => { try { targetWs.close(c, r); } catch(e){} });
  targetWs.on("error", (e) => { console.error("[WS ERROR]", e.message); try { clientWs.close(); } catch(e){} });
  clientWs.on("error", () => { try { targetWs.close(); } catch(e){} });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║     VPS Proxy - Radar Futebol (Improved)           ║
╠════════════════════════════════════════════════════╣
║  Port: ${PORT}                                         ║
║                                                    ║
║  Routes:                                           ║
║  - /health     -> Health check                     ║
║  - /stats      -> Statistics                       ║
║  - /wh-api/*   -> sports.williamhill.com           ║
║  - /diffusion  -> WebSocket proxy                  ║
║  - /*          -> sports.whcdn.net (CDN)           ║
╚════════════════════════════════════════════════════╝
  `);
});
