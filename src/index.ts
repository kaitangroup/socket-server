import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") ?? ["*"] }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN?.split(",") ?? ["*"], methods: ["GET","POST"] },
  path: "/socket.io",
});

io.on("connection", (socket) => {
  const name = socket.handshake.auth?.name ?? "Guest";

  socket.on("join", ({ room }) => {
    socket.join(room);

    // ask others in the room to create offers for the newcomer
    socket.to(room).emit("need-offer", { targetId: socket.id });

    // broadcast participant list
    const ids = [...(io.sockets.adapter.rooms.get(room) ?? new Set())];
    const list = ids.map((sid) => {
      const s = io.sockets.sockets.get(sid);
      return { id: sid, name: s?.handshake?.auth?.name ?? "Guest" };
    });
    io.to(room).emit("participants", { participants: list });
  });

  socket.on("offer",  ({ to, sdp })        => io.to(to).emit("offer",  { from: socket.id, sdp }));
  socket.on("answer", ({ to, sdp })        => io.to(to).emit("answer", { from: socket.id, sdp }));
  socket.on("ice-candidate", ({ to, candidate }) =>
    io.to(to).emit("ice-candidate", { from: socket.id, candidate })
  );

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) if (room !== socket.id) {
      const ids = [...(io.sockets.adapter.rooms.get(room) ?? new Set())].filter((id) => id !== socket.id);
      const list = ids.map((sid) => {
        const s = io.sockets.sockets.get(sid);
        return { id: sid, name: s?.handshake?.auth?.name ?? "Guest" };
      });
      io.to(room).emit("participants", { participants: list });
    }
  });
});

const port = process.env.PORT || 3001;
server.listen(port, () => console.log("Socket.IO server on :" + port));
