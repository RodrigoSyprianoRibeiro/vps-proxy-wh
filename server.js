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

// Script injetado no scoreboard para detectar incidentes e notificar o Radar (janela pai)
// Abordagem: observa mudancas no placar (gols) e nas estatisticas (corners, ataques, etc.)
// O #box_commentaries so e populado quando a aba Commentary esta ativa, entao usamos stats
const SOUND_NOTIFICATION_SCRIPT = `
<script>
(function() {
    var inicializado = false;
    var incidentesNotificados = {};
    var DEBOUNCE_MS = 10000;
    var statsAnteriores = {};

    // Aguarda 10s para ignorar estado inicial do jogo (dados carregados via WebSocket)
    setTimeout(function() { inicializado = true; }, 10000);

    function notificar(tipoSom) {
        if (!inicializado) return;
        var agora = Date.now();
        if (incidentesNotificados[tipoSom] && (agora - incidentesNotificados[tipoSom]) < DEBOUNCE_MS) return;
        incidentesNotificados[tipoSom] = agora;
        try {
            window.parent.postMessage({ tipo: 'eventoWH', evento: tipoSom }, '*');
        } catch(e) {}
    }

    // Observa mudanca no placar para detectar gols
    function observarPlacar() {
        var placar = document.querySelector('[data-push="score"]');
        if (!placar) { setTimeout(observarPlacar, 2000); return; }
        var valorAnterior = placar.textContent.trim();
        new MutationObserver(function() {
            var valorAtual = placar.textContent.trim();
            if (valorAtual !== valorAnterior && valorAnterior !== '') {
                valorAnterior = valorAtual;
                notificar('goal');
            }
        }).observe(placar, { childList: true, subtree: true, characterData: true });
    }

    // Le o valor total (casa + fora) de uma estatistica
    function lerStat(nomeStat) {
        var el = document.querySelector('[data-stat="' + nomeStat + '"]');
        if (!el) return -1;
        var home = el.querySelector('.home');
        var away = el.querySelector('.away');
        if (!home || !away) return -1;
        return (parseInt(home.textContent) || 0) + (parseInt(away.textContent) || 0);
    }

    // Verifica mudancas nas estatisticas a cada 3 segundos
    // Mais confiavel que MutationObserver para dados de WebSocket
    function verificarStats() {
        var mapa = {
            'corners': 'corner',
            'dangerousAttacks': 'dangerattack',
            'penalties': 'penalty'
        };

        for (var stat in mapa) {
            var valor = lerStat(stat);
            if (valor < 0) continue;
            if (statsAnteriores[stat] !== undefined && valor > statsAnteriores[stat]) {
                notificar(mapa[stat]);
            }
            statsAnteriores[stat] = valor;
        }
    }

    // Observa timeline de cartoes para detectar cartoes vermelhos
    function observarCartoes() {
        var timelineCards = document.querySelector('.timeline__cards');
        if (!timelineCards) { setTimeout(observarCartoes, 2000); return; }
        var htmlAnterior = timelineCards.innerHTML;
        new MutationObserver(function() {
            var htmlAtual = timelineCards.innerHTML;
            if (htmlAtual !== htmlAnterior) {
                // Verifica se apareceu cartao vermelho (icone _redcard no HTML novo)
                if (htmlAtual.indexOf('_redcard') > -1 && htmlAnterior.indexOf('_redcard') === -1) {
                    notificar('redcard');
                } else {
                    // Compara quantidade de _redcard
                    var antes = (htmlAnterior.match(/_redcard/g) || []).length;
                    var agora = (htmlAtual.match(/_redcard/g) || []).length;
                    if (agora > antes) notificar('redcard');
                }
                htmlAnterior = htmlAtual;
            }
        }).observe(timelineCards, { childList: true, subtree: true });
    }

    // Observa commentaries como backup (funciona quando aba esta ativa)
    function observarComentarios() {
        var container = document.getElementById('box_commentaries');
        if (!container) { setTimeout(observarComentarios, 3000); return; }
        new MutationObserver(function() {
            if (!container.firstElementChild) return;
            var icone = container.firstElementChild.querySelector('[class*="_"]');
            if (!icone) return;
            var match = (icone.className || '').match(/_([a-z]+)/);
            if (!match) return;
            var mapa = {
                'goal': 'goal', 'corner': 'corner',
                'homedanger': 'dangerattack', 'awaydanger': 'dangerattack',
                'penalty': 'penalty', 'redcard': 'redcard'
            };
            if (mapa[match[1]]) notificar(mapa[match[1]]);
        }).observe(container, { childList: true, subtree: true });
    }

    function iniciar() {
        observarPlacar();
        observarCartoes();
        observarComentarios();
        // Polling de stats a cada 3s (mais confiavel que MutationObserver para WebSocket data)
        setInterval(verificarStats, 3000);
        verificarStats();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
</script>
`;

// Injeta script antes do </body> (apos DOM estar construido)
function injectSoundScript(content) {
  if (content.includes('</body>')) {
    return content.replace('</body>', SOUND_NOTIFICATION_SCRIPT + '</body>');
  }
  if (content.includes('</html>')) {
    return content.replace('</html>', SOUND_NOTIFICATION_SCRIPT + '</html>');
  }
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
      if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'content-security-policy-report-only'].includes(key)) {
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
  targetWs.on("close", (c, r) => { try { if (clientWs.readyState <= 1) clientWs.close(c, r); } catch(e){} });
  clientWs.on("close", (c, r) => { try { if (targetWs.readyState <= 1) targetWs.close(c, r); } catch(e){} });
  targetWs.on("error", (e) => {
    // Ignora erro esperado de race condition (cliente desconecta antes do WH responder)
    if (!e.message || !e.message.includes("before the connection was established")) {
      console.error("[WS ERROR]", e.message);
    }
    try { if (clientWs.readyState <= 1) clientWs.close(); } catch(e){}
  });
  clientWs.on("error", (e) => {
    try { if (targetWs.readyState <= 1) targetWs.close(); } catch(e){}
  });
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
