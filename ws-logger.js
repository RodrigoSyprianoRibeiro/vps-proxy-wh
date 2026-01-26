const WebSocket = require("ws");

const WS_HOST = "scoreboards-push.williamhill.com";
const eventId = process.argv[2] || "15213937"; // Default event ID

const wsUrl = `wss://${WS_HOST}/diffusion?ty=WB&v=18&ca=8&r=300000&sp=%7B%22src%22%3A%22traf_sb_football%22%7D`;

console.log("Connecting to:", wsUrl);
console.log("Event ID:", eventId);
console.log("Listening for messages (Ctrl+C to stop)...\n");

const ws = new WebSocket(wsUrl, {
  headers: { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin": "https://sports.whcdn.net"
  }
});

ws.on("open", () => {
  console.log("[CONNECTED]\n");
});

ws.on("message", (data) => {
  const msg = data.toString();
  // Filter for messages related to our event or interesting patterns
  if (msg.includes(eventId) || msg.includes("goal") || msg.includes("corner") || 
      msg.includes("danger") || msg.includes("attack") || msg.includes("card") ||
      msg.includes("penalty") || msg.includes("incident")) {
    console.log("=".repeat(80));
    console.log("[", new Date().toISOString(), "]");
    console.log(msg.substring(0, 2000)); // Limit output
    console.log("");
  }
});

ws.on("error", (e) => console.error("[ERROR]", e.message));
ws.on("close", () => console.log("[DISCONNECTED]"));
