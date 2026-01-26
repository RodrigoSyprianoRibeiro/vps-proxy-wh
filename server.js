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

// FlareSolverr
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";

// Timeouts
const PROXY_TIMEOUT = 30000;
const FLARESOLVERR_TIMEOUT = 60000;

// Headers para CDN (scoreboard/radar) - sem compressao para facilitar substituicao de URLs
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

// Headers para requisicoes da API (lista de jogos)
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

// Middleware para parse JSON
app.use(express.json());

// Contador de requisicoes
const requestStats = {
  cdn: 0,
  api: 0,
  flare: 0,
  ws: 0,
  errors: 0,
};

// Status do FlareSolverr
let flareSolverrOnline = false;
let lastFlareCheck = null;

/**
 * Verifica se FlareSolverr esta online
 */
async function checkFlareSolverr() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(FLARESOLVERR_URL.replace('/v1', '/health'), {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    flareSolverrOnline = response.ok;
    lastFlareCheck = new Date();
    return flareSolverrOnline;
  } catch (error) {
    flareSolverrOnline = false;
    lastFlareCheck = new Date();
    return false;
  }
}

// Verificar FlareSolverr na inicializacao
checkFlareSolverr().then(online => {
  console.log(`[FlareSolverr] Status inicial: ${online ? 'ONLINE' : 'OFFLINE'}`);
});

// Verificar periodicamente (a cada 30 segundos)
setInterval(checkFlareSolverr, 30000);

// Health check endpoint
app.get("/health", async (req, res) => {
  // Verificar FlareSolverr se nao verificou recentemente
  if (!lastFlareCheck || Date.now() - lastFlareCheck.getTime() > 10000) {
    await checkFlareSolverr();
  }

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    flaresolverr: {
      online: flareSolverrOnline,
      url: FLARESOLVERR_URL,
      lastCheck: lastFlareCheck,
    },
  });
});

// Estatisticas endpoint
app.get("/stats", (req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    requests: requestStats,
    flaresolverr: {
      online: flareSolverrOnline,
      lastCheck: lastFlareCheck,
    },
  });
});

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

// ====================================
// ROTA: /flare/* -> FlareSolverr proxy
// Usada para bypass de Cloudflare
// ====================================
app.all("/flare/*", async (req, res) => {
  requestStats.flare++;

  // Extrai o path apos /flare/
  const targetPath = req.url.replace('/flare', '') || '/';
  const targetUrl = TARGET_API + targetPath;

  console.log(`[FLARE] ${req.method} ${targetPath} -> FlareSolverr -> ${targetUrl}`);

  if (!flareSolverrOnline) {
    console.error('[FLARE] FlareSolverr offline');
    requestStats.errors++;
    return res.status(503).json({
      error: "FlareSolverr offline",
      message: "O servico FlareSolverr nao esta disponivel",
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FLARESOLVERR_TIMEOUT);

    const flareResponse = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: targetUrl,
        maxTimeout: FLARESOLVERR_TIMEOUT,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await flareResponse.json();

    if (data.status === 'ok' && data.solution) {
      const solution = data.solution;
      const responseBody = solution.response || '';
      const statusCode = solution.status || 200;

      console.log(`[FLARE] Response: ${statusCode} - ${responseBody.length} bytes`);

      res.status(statusCode);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(responseBody);
    } else {
      console.error(`[FLARE] Error: ${data.message || 'Unknown error'}`);
      requestStats.errors++;
      res.status(500).json({
        error: "FlareSolverr error",
        message: data.message || 'Unknown error',
      });
    }
  } catch (error) {
    console.error(`[FLARE] Exception: ${error.message}`);
    requestStats.errors++;
    res.status(500).json({
      error: "FlareSolverr exception",
      message: error.message,
    });
  }
});

// ====================================
// ROTA: /wh-api/* -> sports.williamhill.com
// Usada pelo crawler para buscar lista de jogos
// Tenta proxy direto primeiro, fallback para FlareSolverr
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
  onProxyRes: async (proxyRes, req, res) => {
    const contentType = proxyRes.headers["content-type"] || "";
    const statusCode = proxyRes.statusCode;

    console.log(`[API] Response: ${statusCode} - ${contentType.substring(0, 50)}`);

    // Se for Cloudflare challenge (403 ou 503), tentar FlareSolverr
    if ((statusCode === 403 || statusCode === 503) && flareSolverrOnline) {
      console.log('[API] Cloudflare detectado, tentando FlareSolverr...');

      try {
        const targetPath = req.url.replace('/wh-api', '') || '/';
        const targetUrl = TARGET_API + targetPath;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FLARESOLVERR_TIMEOUT);

        const flareResponse = await fetch(FLARESOLVERR_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cmd: 'request.get',
            url: targetUrl,
            maxTimeout: FLARESOLVERR_TIMEOUT,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const data = await flareResponse.json();

        if (data.status === 'ok' && data.solution) {
          const solution = data.solution;
          const responseBody = solution.response || '';
          const flareStatus = solution.status || 200;

          console.log(`[API->FLARE] Fallback sucesso: ${flareStatus}`);

          res.status(flareStatus);
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(responseBody);
          return;
        }
      } catch (flareError) {
        console.error(`[API->FLARE] Fallback falhou: ${flareError.message}`);
      }
    }

    // Resposta normal do proxy
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
╔════════════════════════════════════════════════════════════╗
║     VPS Proxy - Radar Futebol (com FlareSolverr)           ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                 ║
║                                                            ║
║  Routes:                                                   ║
║  - /health      -> Health check (inclui status FlareSolverr)║
║  - /stats       -> Statistics                              ║
║  - /flare/*     -> FlareSolverr bypass (Cloudflare)        ║
║  - /wh-api/*    -> sports.williamhill.com (auto-fallback)  ║
║  - /diffusion   -> WebSocket proxy                         ║
║  - /*           -> sports.whcdn.net (CDN)                  ║
║                                                            ║
║  FlareSolverr: ${FLARESOLVERR_URL.padEnd(36)}   ║
╚════════════════════════════════════════════════════════════╝
  `);
});
