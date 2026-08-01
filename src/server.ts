import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { bus } from "./bus";
import { startVoiceSession, stopVoiceSession } from "./voice/session";

const app = express();
const server = createServer(app);

// Serve the console UI
app.use(express.static(path.join(__dirname, "../public")));

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  const url = req.url ?? "";

  if (url === "/console") {
    // Browser console UI connection
    console.log("[server] console connected");
    bus.setConsoleSocket(ws);
    ws.on("close", () => console.log("[server] console disconnected"));
    return;
  }

  if (url === "/call") {
    // Mic audio stream from browser
    console.log("[server] call connection opened");
    bus.publish({ type: "call_started" });

    startVoiceSession(ws);

    ws.on("close", () => {
      console.log("[server] call connection closed");
      stopVoiceSession();
      bus.publish({ type: "call_ended" });
    });

    ws.on("error", (err) => {
      console.error("[server] call socket error", err);
      bus.publish({ type: "error", message: err.message });
    });

    return;
  }

  ws.close(1008, "Unknown endpoint");
});

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
