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

/* Remove o fundo original do estádio */
.background-image,
[style*="football_background"],
[style*="background-image"] {
  background-image: none !important;
}

/* Container principal - aplica o tema */
body,
.scoreboard,
.scoreboard-container,
.main-container,
#app,
[class*="scoreboard"] {
  background: ${isDark
    ? 'linear-gradient(135deg, #0a1628 0%, #1a2d4a 50%, #0d1f35 100%)'
    : 'linear-gradient(135deg, #e8f4fc 0%, #d1e9f6 50%, #c5dff0 100%)'} !important;
}

/* Logo Radar Futebol como marca d'água */
body::before {
  content: '';
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 300px;
  height: 300px;
  background-image: url('https://www.radarfutebol.com/images/logo-white.svg');
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: ${isDark ? '0.05' : '0.08'};
  pointer-events: none;
  z-index: 0;
}

/* Garante que o conteúdo fique acima da marca d'água */
body > * {
  position: relative;
  z-index: 1;
}

/* Ajusta cores de texto para o tema */
${isDark ? `
/* TEMA ESCURO */
.team-name,
.score,
.time,
.period,
[class*="team"],
[class*="score"],
[class*="stat"] {
  color: #ffffff !important;
}

.stat-label,
.stat-value,
[class*="label"] {
  color: #b8c5d6 !important;
}

/* Painéis e cards */
.panel,
.card,
.stat-container,
[class*="panel"],
[class*="card"] {
  background: rgba(15, 35, 60, 0.85) !important;
  border-color: rgba(100, 150, 200, 0.3) !important;
}

/* Timeline e barras */
.timeline,
.progress-bar,
[class*="timeline"],
[class*="progress"] {
  background: rgba(20, 45, 75, 0.9) !important;
}

/* Destaques em azul */
.highlight,
.active,
[class*="highlight"],
[class*="active"] {
  background: rgba(30, 90, 150, 0.7) !important;
}
` : `
/* TEMA CLARO */
.team-name,
.score,
.time,
.period,
[class*="team"],
[class*="score"],
[class*="stat"] {
  color: #1a2d4a !important;
}

.stat-label,
.stat-value,
[class*="label"] {
  color: #4a6080 !important;
}

/* Painéis e cards */
.panel,
.card,
.stat-container,
[class*="panel"],
[class*="card"] {
  background: rgba(255, 255, 255, 0.9) !important;
  border-color: rgba(100, 150, 200, 0.4) !important;
  box-shadow: 0 2px 8px rgba(0, 50, 100, 0.1) !important;
}

/* Timeline e barras */
.timeline,
.progress-bar,
[class*="timeline"],
[class*="progress"] {
  background: rgba(200, 220, 240, 0.9) !important;
}

/* Destaques em azul */
.highlight,
.active,
[class*="highlight"],
[class*="active"] {
  background: rgba(100, 160, 220, 0.5) !important;
}
`}

/* Remove qualquer referência ao background original */
[style*="football_background.jpg"],
[style*="background.jpg"],
[style*="stadium"] {
  background-image: none !important;
}

/* Ajustes gerais */
* {
  transition: background-color 0.3s ease, color 0.3s ease;
}
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
