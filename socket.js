let io;
const activeRefs = {};

function init(server) {
  const { Server } = require("socket.io");

  io = new Server(server, {
    cors: { origin: "*" }
  });

  io.on("connection", (socket) => {

    // 🔐 REGISTER USER
    socket.on("register", (user) => {
      if (!user || !user.id) return;

      socket.user = user;

      // remove from all refs (reconnect safety)
      Object.keys(activeRefs).forEach(ref => {
        activeRefs[ref] = activeRefs[ref].filter(u => u.id !== user.id);
      });

      socket.join(user.username);

      console.log("👤 joined:", user.username);
    });

    // 👀 FOCUS REF
    socket.on("focus-ref", ({ ref }) => {
      const user = socket.user;
      if (!user || !user.id) return;

      if (!activeRefs[ref]) activeRefs[ref] = [];

      if (!activeRefs[ref].some(u => u.id === user.id)) {
        activeRefs[ref].push(user);
      }

      io.emit("ref-users", { ref, users: activeRefs[ref] });
    });

    // 🚪 LEAVE REF
    socket.on("leave-ref", ({ ref }) => {
      const user = socket.user;
      if (!user || !activeRefs[ref]) return;

      activeRefs[ref] = activeRefs[ref].filter(u => u.id !== user.id);

      io.emit("ref-users", { ref, users: activeRefs[ref] });
    });

    // 🧠 CLAIM REF (SAFE)
    socket.on("claim-ref", ({ ref }) => {
      const user = socket.user;
      if (!user) return;

      io.emit("ref-claimed", { ref, user });
    });

    // ✅ CONFIRM REF (SAFE)
    socket.on("confirm-ref", ({ ref, decision }) => {
      const user = socket.user;
      if (!user) return;

      io.emit("ref-confirmed", { ref, user, decision });
    });

    // 🔥 CLEAN ON DISCONNECT
    socket.on("disconnect", () => {
      const user = socket.user;
      if (!user) return;

      Object.keys(activeRefs).forEach(ref => {
        const before = activeRefs[ref].length;

        activeRefs[ref] = activeRefs[ref].filter(u => u.id !== user.id);

        // only emit if changed
        if (activeRefs[ref].length !== before) {
          io.emit("ref-users", { ref, users: activeRefs[ref] });
        }
      });

      console.log("❌ disconnected:", user.username);
    });

  });
}

function getIO() {
  return io;
}

module.exports = { init, getIO };