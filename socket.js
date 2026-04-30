let io;
const activeRefs = {};

function init(server) {
  const { Server } = require("socket.io");

  io = new Server(server, {
    cors: { origin: "*" }
  });

  io.on("connection", (socket) => {

    socket.on("focus-ref", ({ ref, user }) => {
      if (!activeRefs[ref]) activeRefs[ref] = [];

      if (!activeRefs[ref].some(u => u.id === user.id)) {
        activeRefs[ref].push(user);
      }

      io.emit("ref-users", { ref, users: activeRefs[ref] });
    });

    socket.on("leave-ref", ({ ref, user }) => {
      if (!activeRefs[ref]) return;

      activeRefs[ref] = activeRefs[ref].filter(u => u.id !== user.id);

      io.emit("ref-users", { ref, users: activeRefs[ref] });
    });

    socket.on("claim-ref", ({ ref, user }) => {
      io.emit("ref-claimed", { ref, user });
    });

    socket.on("confirm-ref", ({ ref, user, decision }) => {
      io.emit("ref-confirmed", { ref, user, decision });
    });
  });
}

function getIO() {
  return io;
}

module.exports = { init, getIO };