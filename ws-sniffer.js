const WebSocket = require("ws");
const http = require("http");

// Mini WebSocket proxy that logs all messages
const PORT = 3001;
const WS_HOST = "scoreboards-push.williamhill.com";

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("WS Sniffer running");
});

const wss = new WebSocket.Server({ server, path: "/diffusion" });

wss.on("connection", (clientWs, req) => {
  const qs = req.url.includes("?") ? req.url.split("?")[1] : "";
  const wsUrl = "wss://" + WS_HOST + "/diffusion" + (qs ? "?" + qs : "");
  console.log("[CLIENT CONNECTED]", wsUrl);

  const targetWs = new WebSocket(wsUrl, {
    headers: { "User-Agent": "Mozilla/5.0", "Origin": "https://sports.whcdn.net" }
  });

  targetWs.on("open", () => console.log("[TARGET CONNECTED]"));
  
  targetWs.on("message", (data) => {
    const msg = data.toString();
    // Log interesting messages
    if (msg.length < 500 || msg.includes("incident") || msg.includes("attack") || 
        msg.includes("goal") || msg.includes("corner") || msg.includes("card")) {
      console.log("\n[FROM TARGET]", new Date().toISOString());
      console.log(msg.substring(0, 1000));
    }
    if (clientWs.readyState === 1) clientWs.send(data);
  });

  clientWs.on("message", (data) => {
    const msg = data.toString();
    console.log("\n[FROM CLIENT]", new Date().toISOString());
    console.log(msg.substring(0, 500));
    if (targetWs.readyState === 1) targetWs.send(data);
  });

  targetWs.on("close", () => { try { clientWs.close(); } catch(e){} });
  clientWs.on("close", () => { try { targetWs.close(); } catch(e){} });
  targetWs.on("error", (e) => console.error("[TARGET ERROR]", e.message));
  clientWs.on("error", (e) => console.error("[CLIENT ERROR]", e.message));
});

server.listen(PORT, () => console.log(`WS Sniffer running on port ${PORT}`));
