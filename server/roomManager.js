// server/roomManager.js
// In-memory room store. Rooms auto-expire after 4 hours of inactivity.

const ROOM_TTL_MS = 4 * 60 * 60 * 1000;

const rooms = new Map(); // roomCode → { game, tvSocketId, lastActivity }

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

function createRoom(game, tvSocketId) {
  rooms.set(game.roomCode, { game, tvSocketId, lastActivity: Date.now() });
}

function getRoom(roomCode) {
  const room = rooms.get(roomCode?.toUpperCase());
  if (room) room.lastActivity = Date.now();
  return room || null;
}

function deleteRoom(roomCode) {
  rooms.delete(roomCode?.toUpperCase());
}

function getTvSocketId(roomCode) {
  return rooms.get(roomCode?.toUpperCase())?.tvSocketId || null;
}

// Purge stale rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 30 * 60 * 1000);

module.exports = { generateCode, createRoom, getRoom, deleteRoom, getTvSocketId };
