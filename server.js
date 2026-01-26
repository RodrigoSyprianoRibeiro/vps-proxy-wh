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
const PROXY_TIMEOUT = 30000; // 30 segundos

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "identity",
  "Referer": "https://sports.williamhill.com/",
  "Origin": "https://sports.williamhill.com",
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

// CSS personalizado para o Radar Futebol
function getCustomCSS(theme = 'dark') {
  const isDark = theme === 'dark';

  return `
<style id="radar-custom-css">
/* ========================================
   RADAR FUTEBOL - CSS PERSONALIZADO
   Tema: ${isDark ? 'Escuro' : 'Claro'}
   ======================================== */

/* Remove APENAS o fundo do estádio (football_background.jpg) */
.box_court {
  background-image: none !important;
  background-color: ${isDark ? '#0a1628' : '#e8f4fc'} !important;
}

/* Cor de fundo do body */
body {
  background-color: ${isDark ? '#00143c' : '#d1e9f6'} !important;
}

/* Container principal */
#scoreboard {
  background-color: ${isDark ? '#00143c' : '#e8f4fc'} !important;
}

/* Logo Radar Futebol como marca d'água no campo */
.box_court::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 200px;
  height: 200px;
  background-image: url('https://www.radarfutebol.com/images/logo-white.svg');
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: ${isDark ? '0.08' : '0.12'};
  pointer-events: none;
  z-index: 0;
}

/* Garante que o conteúdo do campo fique visível */
.box_court > * {
  position: relative;
  z-index: 1;
}

/* Área de estatísticas */
.box_statistics,
.statisticsWrapper,
#stats {
  background-color: ${isDark ? 'rgba(0, 20, 60, 0.95)' : 'rgba(220, 235, 250, 0.95)'} !important;
}

/* Cabeçalho com times e placar */
#topContainer,
header {
  background-color: ${isDark ? 'rgba(0, 20, 60, 0.9)' : 'rgba(200, 220, 240, 0.9)'} !important;
}

/* Barra inferior */
#bottomContainer {
  background-color: ${isDark ? 'rgba(0, 15, 45, 0.95)' : 'rgba(210, 225, 245, 0.95)'} !important;
}

${isDark ? `
/* TEMA ESCURO - Textos */
.team_name,
.teamName,
.topScore,
.clockWrapper span {
  color: #ffffff !important;
}

.stat-label span,
.stat-wrapper span {
  color: #e0e8f0 !important;
}

/* Timeline */
.timeline {
  background-color: rgba(0, 30, 70, 0.8) !important;
}

/* Abas de período */
#pick_statistics_box li {
  color: #b0c0d0 !important;
}
#pick_statistics_box li.current {
  color: #ffffff !important;
  background-color: rgba(30, 80, 140, 0.6) !important;
}
` : `
/* TEMA CLARO - Textos */
.team_name,
.teamName,
.topScore,
.clockWrapper span {
  color: #1a2d4a !important;
}

.stat-label span,
.stat-wrapper span {
  color: #2a4060 !important;
}

/* Timeline */
.timeline {
  background-color: rgba(180, 200, 230, 0.8) !important;
}

/* Abas de período */
#pick_statistics_box li {
  color: #4a6080 !important;
}
#pick_statistics_box li.current {
  color: #1a2d4a !important;
  background-color: rgba(150, 190, 230, 0.6) !important;
}

/* Ajuste do placar para tema claro */
.mainScoreBox {
  background-color: rgba(30, 60, 100, 0.9) !important;
}
`}
</style>
`;
}

// Extrai o tema da query string
function getThemeFromUrl(url) {
  const match = url.match(/[?&]theme=(light|dark)/i);
  return match ? match[1].toLowerCase() : 'dark';
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
  pathRewrite: {
    "^/wh-api": "", // Remove /wh-api do path
  },
  onProxyReq: (proxyReq, req) => {
    requestStats.api++;
    Object.entries(HEADERS).forEach(([k, v]) => proxyReq.setHeader(k, v));
    // Log para debug
    console.log(`[API] ${req.method} ${req.url} -> ${TARGET_API}${req.url.replace('/wh-api', '')}`);
  },
  onProxyRes: (proxyRes, req, res) => {
    const contentType = proxyRes.headers["content-type"] || "";

    // Copiar headers (exceto os problemáticos)
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
        res.status(proxyRes.statusCode);
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
      } catch (e) {
        console.error(`[API PARSE ERROR] ${e.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: "Parse error", message: e.message });
        }
      }
    });
    proxyRes.on("error", (e) => {
      console.error(`[API RESPONSE ERROR] ${e.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Response error", message: e.message });
      }
    });
  },
  onError: (err, req, res) => {
    console.error(`[API ERROR] ${err.message}`);
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
    Object.entries(HEADERS).forEach(([k, v]) => proxyReq.setHeader(k, v));
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

        // Injeta CSS personalizado em páginas HTML
        if (contentType.includes("html")) {
          const theme = getThemeFromUrl(req.url);
          const customCSS = getCustomCSS(theme);

          // Injeta antes do </head> ou no início do <body>
          if (body.includes("</head>")) {
            body = body.replace("</head>", customCSS + "</head>");
          } else if (body.includes("<body")) {
            body = body.replace(/<body([^>]*)>/, "<body$1>" + customCSS);
          } else {
            body = customCSS + body;
          }

          console.log(`[CDN] Injected custom CSS (theme: ${theme}) for ${req.url}`);
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
    headers: { "User-Agent": HEADERS["User-Agent"], "Origin": "https://sports.whcdn.net" }
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
║     VPS Proxy - Radar Futebol                      ║
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
