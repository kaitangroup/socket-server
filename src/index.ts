// src/index.ts
import http from "http";
import express, { Request, Response } from "express";
import cors from "cors";
import { Server } from "socket.io";

// ---------------- CONFIG ----------------
const RAW_ORIGINS = process.env.CORS_ORIGIN ?? "";
const ALLOWED_ORIGINS = RAW_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push(
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://192.168.0.197:3000",
    "https://192.168.0.197:3000"
  );
}

const app = express();
app.disable("x-powered-by");
app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "OPTIONS"],
  })
);

// ---------------- ROOM STATE ----------------
interface RoomState {
  startedAt: number | null; // timestamp
  duration: number; // minutes
}

const rooms: Record<string, RoomState> = {}; // persistent per-room timer

// ---------------- BASIC ROUTES ----------------
app.get("/", (_req: Request, res: Response) => res.send("OK"));
app.get("/healthz", (_req: Request, res: Response) =>
  res.json({ ok: true, ts: Date.now() })
);

// ---------------- SOCKET.IO ----------------
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
  path: "/socket.io",
});

io.on("connection", (socket) => {
  const displayName: string =
    typeof socket.handshake.auth?.name === "string"
      ? socket.handshake.auth.name
      : "Guest";

  // -------------- CHAT --------------
  socket.on("chat", ({ room, text }) => {
    if (!room || typeof room !== "string") return;
    const msg = String(text ?? "").trim();
    if (!msg) return;

    io.to(room).emit("chat", {
      name: displayName,
      from: socket.id,
      text: msg,
    });
  });

  // -------------- JOIN ROOM --------------
  socket.on("join", ({ room }) => {
    if (!room || typeof room !== "string") return;

    socket.join(room);

    // Initialize room state if missing
    if (!rooms[room]) {
      rooms[room] = {
        startedAt: null,
        duration: 60, // default meeting duration
      };
    }

    const roomState = rooms[room];

    // Number of participants
    const count = io.sockets.adapter.rooms.get(room)?.size ?? 0;

    // Start timer only once when 2 participants present
    if (count >= 2 && !roomState.startedAt) {
      roomState.startedAt = Date.now();
      io.to(room).emit("timer-start", {
        startedAt: roomState.startedAt,
        duration: roomState.duration,
      });
    }

    // Always send current timer state to newly joined user
    socket.emit("timer-state", {
      startedAt: roomState.startedAt,
      duration: roomState.duration,
    });

    // Ask peers to offer
    socket.to(room).emit("need-offer", { targetId: socket.id });

    // Broadcast updated participants
    broadcastParticipants(room);
  });

  // -------------- WEBRTC SIGNALING --------------
  socket.on("offer", ({ to, sdp }) => {
    if (to && sdp) io.to(to).emit("offer", { from: socket.id, sdp });
  });

  socket.on("answer", ({ to, sdp }) => {
    if (to && sdp) io.to(to).emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    if (to && candidate)
      io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  });

  // -------------- DISCONNECTING --------------
  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room === socket.id) continue;
      broadcastParticipants(room);

      // If room empty → reset timer
      const size = io.sockets.adapter.rooms.get(room)?.size ?? 0;
      if (size === 0) delete rooms[room];
    }
  });
});

// -------------- HELPERS --------------
function broadcastParticipants(room: string) {
  const roomSet = io.sockets.adapter.rooms.get(room) ?? new Set<string>();
  const list = [...roomSet].map((sid) => {
    const s = io.sockets.sockets.get(sid);
    const nm =
      typeof s?.handshake?.auth?.name === "string"
        ? s!.handshake.auth.name
        : "Guest";
    return { id: sid, name: nm };
  });

  io.to(room).emit("participants", { participants: list });
}

// ---------------- START SERVER ----------------
const port = Number(process.env.PORT ?? 3001);
server.listen(port, "0.0.0.0", () => {
  console.log(`Socket.IO server running on ${port}`);
  console.log(`Allowed origins → ${ALLOWED_ORIGINS.join(", ")}`);
});

// ---------------- GRACEFUL SHUTDOWN ----------------
process.on("SIGTERM", () => {
  console.log("SIGTERM received → shutting down...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});
