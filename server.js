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

// ====================================
// ROTA: /wh-api/* -> sports.williamhill.com
// Usada pelo crawler para buscar lista de jogos
// ====================================
app.use("/wh-api", createProxyMiddleware({
  target: TARGET_API,
  changeOrigin: true,
  selfHandleResponse: true,
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
      let body = Buffer.concat(chunks).toString("utf8");
      res.status(proxyRes.statusCode);
      res.setHeader("Content-Length", Buffer.byteLength(body));
      res.end(body);
    });
  },
  onError: (err, req, res) => {
    console.error(`[API ERROR] ${err.message}`);
    res.status(502).json({ error: "Proxy error", message: err.message });
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
  onProxyReq: (proxyReq, req) => {
    requestStats.cdn++;
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
      let body = Buffer.concat(chunks).toString("utf8");

      if (contentType.includes("html") || contentType.includes("javascript") || contentType.includes("css")) {
        body = replaceUrls(body, host);
      }

      res.status(proxyRes.statusCode);
      res.setHeader("Content-Length", Buffer.byteLength(body));
      res.end(body);
    });
  },
  onError: (err, req, res) => {
    console.error(`[CDN ERROR] ${err.message}`);
    res.status(502).json({ error: "Proxy error", message: err.message });
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
