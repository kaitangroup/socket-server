// src/index.ts
import http from "http";
import express, { Request, Response } from "express";
import cors from "cors";
import { Server } from "socket.io";

// ---- Config ----
const RAW_ORIGINS = process.env.CORS_ORIGIN ?? "";
const ALLOWED_ORIGINS = RAW_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Fallbacks useful for local dev:
if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push(
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    'http://192.168.0.197:3000',
    'https://192.168.0.197:3000'
    // add your LAN IP if needed: `http://192.168.0.197:3000`
  );
}

const app = express();
app.disable("x-powered-by");
app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "OPTIONS"],
  }),
);

// Simple health & root routes (handy for Railway)
app.get("/", (_req: Request, res: Response) => {
  res.type("text/plain").send("OK");
});
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---- HTTP server + Socket.IO ----
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] },
  path: "/socket.io",
});

// ---- Socket.IO logic ----
io.on("connection", (socket) => {
  const displayName: string = typeof socket.handshake.auth?.name === "string"
    ? socket.handshake.auth.name
    : "Guest";

  socket.on("join", ({ room }: { room: string }) => {
    if (typeof room !== "string" || !room.trim()) return;
    socket.join(room);

    // Ask others to offer to the newcomer
    socket.to(room).emit("need-offer", { targetId: socket.id });

    // Broadcast participants
    const roomSet = io.sockets.adapter.rooms.get(room) ?? new Set<string>();
    const list = [...roomSet].map((sid) => {
      const s = io.sockets.sockets.get(sid);
      const nm = typeof s?.handshake?.auth?.name === "string" ? s!.handshake.auth.name : "Guest";
      return { id: sid, name: nm };
    });
    io.to(room).emit("participants", { participants: list });
  });

  socket.on("offer", ({ to, sdp }: { to: string; sdp: RTCSessionDescriptionInit }) => {
    if (typeof to === "string" && sdp) io.to(to).emit("offer", { from: socket.id, sdp });
  });

  socket.on("answer", ({ to, sdp }: { to: string; sdp: RTCSessionDescriptionInit }) => {
    if (typeof to === "string" && sdp) io.to(to).emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ to, candidate }: { to: string; candidate: RTCIceCandidateInit }) => {
    if (typeof to === "string" && candidate) {
      io.to(to).emit("ice-candidate", { from: socket.id, candidate });
    }
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room === socket.id) continue;
      const ids = [...(io.sockets.adapter.rooms.get(room) ?? new Set<string>())].filter(
        (id) => id !== socket.id,
      );
      const list = ids.map((sid) => {
        const s = io.sockets.sockets.get(sid);
        const nm = typeof s?.handshake?.auth?.name === "string" ? s!.handshake.auth.name : "Guest";
        return { id: sid, name: nm };
      });
      io.to(room).emit("participants", { participants: list });
    }
  });
});

// ---- Listen (TS-safe) ----
const port = Number(process.env.PORT ?? 3001);
if (!Number.isFinite(port)) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`Socket.IO server listening on :${port}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});

// Graceful shutdown (Railway/containers)
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server...");
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
});
