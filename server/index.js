// server/index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

// Get the machine's LAN IP so phones on the same WiFi can reach the QR URL
function getLanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
const LAN_IP = getLanIP();

const rm = require('./roomManager');
const engine = require('./gameEngine');
const { STATES, TIMINGS, SCORING } = engine;

// Per-room suspicion values: roomCode → { playerId → 0-100 }
const suspicionMap = {};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve TV screen at /
app.use('/tv', express.static(path.join(__dirname, '../public/tv')));
// Serve phone screen at /join
app.use('/phone', express.static(path.join(__dirname, '../public/phone')));

app.get('/', (req, res) => res.redirect('/tv'));
app.get('/join', (req, res) => res.redirect('/phone'));
app.get('/join/:code', (req, res) => res.redirect(`/phone?code=${req.params.code}`));

// ─── Helpers ────────────────────────────────────────────────────────────────

function roomSockets(roomCode) {
  return io.sockets.adapter.rooms.get(roomCode) || new Set();
}

function emitToRoom(roomCode, event, data) {
  io.to(roomCode).emit(event, data);
}

function emitToTV(roomCode, event, data) {
  const tvId = rm.getTvSocketId(roomCode);
  if (tvId) io.to(tvId).emit(event, data);
}

function emitToPlayer(socketId, event, data) {
  io.to(socketId).emit(event, data);
}

function lobbyPayload(game) {
  return {
    roomCode: game.roomCode,
    players: Object.values(game.players).map(p => ({ id: p.id, name: p.name, score: p.score })),
    playerCount: engine.playerCount(game),
  };
}

// ─── Timer management ────────────────────────────────────────────────────────

function clearTimer(game, name) {
  if (game.timers[name]) {
    clearTimeout(game.timers[name]);
    clearInterval(game.timers[name]);
    delete game.timers[name];
  }
}

function clearAllTimers(game) {
  Object.keys(game.timers).forEach(name => clearTimer(game, name));
}

// ─── Round ticker ────────────────────────────────────────────────────────────

function startRoundTicker(game) {
  clearTimer(game, 'tick');
  clearTimer(game, 'roundEnd');
  let hotZoneFired = false;

  game.timers.tick = setInterval(() => {
    if (game.state !== STATES.ROUND_ACTIVE) return;
    game.currentRound.timeRemaining--;
    const t = game.currentRound.timeRemaining;
    emitToRoom(game.roomCode, 'round:tick', { timeRemaining: t });

    // Hot Zone: fire once when timer hits threshold
    if (t <= SCORING.HOT_ZONE_THRESHOLD && !hotZoneFired) {
      hotZoneFired = true;
      engine.enterHotZone(game);
      emitToRoom(game.roomCode, 'round:hotZone', { timeRemaining: t });
    }

    if (t <= 0) finishRoundNaturally(game);
  }, 1000);
}

function pauseRoundTicker(game) {
  clearTimer(game, 'tick');
}

function resumeRoundTicker(game) {
  startRoundTicker(game);
}

// ─── Round flow helpers ───────────────────────────────────────────────────────

function finishRoundNaturally(game) {
  pauseRoundTicker(game);
  // Clear suspicion for this room
  delete suspicionMap[game.roomCode];

  const { speakerId, delta, predictionResults } = engine.endRound(game);
  const lb = engine.buildLeaderboard(game);

  emitToRoom(game.roomCode, 'round:end', {
    speakerId,
    speakerName: game.players[speakerId]?.name,
    pointDeltas: game.currentRound.pointDeltas,
    predictionResults,
    leaderboard: lb,
    players: Object.values(game.players).map(p => ({ id: p.id, name: p.name, score: p.score })),
  });

  game.timers.leaderboard = setTimeout(() => showLeaderboard(game), TIMINGS.ROUND_END_S * 1000);
}

function showLeaderboard(game) {
  const lb = engine.buildLeaderboard(game);
  game.state = STATES.LEADERBOARD;
  emitToRoom(game.roomCode, 'leaderboard:show', { leaderboard: lb });

  if (engine.isGameOver(game)) {
    game.timers.gameEnd = setTimeout(() => {
      const result = engine.endGame(game);
      emitToRoom(game.roomCode, 'game:end', result);
    }, TIMINGS.LEADERBOARD_S * 1000);
  } else {
    // Wait for host to advance — or auto-advance after 10s
    game.timers.autoAdvance = setTimeout(() => {
      if (game.state === STATES.LEADERBOARD) startNextRound(game);
    }, 10000);
  }
}

function startNextRound(game) {
  clearTimer(game, 'autoAdvance');
  const { speakerId, tapsPerPlayer } = engine.beginRound(game);
  const speaker = game.players[speakerId];

  emitToRoom(game.roomCode, 'round:new', {
    roundNumber: game.currentRound.roundNumber,
    speakerId,
    speakerName: speaker?.name,
    tapsPerPlayer,
    players: Object.values(game.players).map(p => ({
      id: p.id, name: p.name, score: p.score, bsTapsRemaining: p.bsTapsRemaining,
    })),
  });

  // Send tier-select prompt to speaker only
  emitToPlayer(speakerId, 'speaker:selectTier', {
    options: [
      { tier: 'common', label: 'Common', multiplier: 1, description: 'Everyday knowledge' },
      { tier: 'niche', label: 'Niche', multiplier: 2, description: 'You better know your stuff' },
      { tier: 'deep_dive', label: 'Deep Dive', multiplier: 3, description: 'For the brave & bold' },
    ],
  });

  // Timeout if speaker doesn't select within 20s
  game.timers.tierTimeout = setTimeout(() => {
    if (game.state === STATES.TIER_SELECT) handleTierSelect(game, speakerId, 'common');
  }, 20000);
}

function handleTierSelect(game, speakerId, tier) {
  if (game.state !== STATES.TIER_SELECT) return;
  if (game.currentRound.speakerId !== speakerId) return;
  clearTimer(game, 'tierTimeout');

  engine.selectTier(game, tier);

  // Prompt speaker to choose duration (they still haven't seen the topic)
  emitToPlayer(speakerId, 'speaker:selectDuration', {
    tier,
    options: [
      { seconds: 60, label: '1 Minute', description: 'Quick & sharp' },
      { seconds: 120, label: '2 Minutes', description: 'Go deep, earn more' },
    ],
  });

  // Let the TV know tier is locked, speaker is now choosing duration
  emitToTV(game.roomCode, 'round:tierChosen', {
    speakerName: game.players[speakerId]?.name,
    tier,
  });

  // Auto-default to 60s if speaker doesn't pick within 15s
  game.timers.durationTimeout = setTimeout(() => {
    if (game.state === STATES.DURATION_SELECT) handleDurationSelect(game, speakerId, 60);
  }, 15000);
}

function handleDurationSelect(game, speakerId, durationSeconds) {
  if (game.state !== STATES.DURATION_SELECT) return;
  if (game.currentRound.speakerId !== speakerId) return;
  clearTimer(game, 'durationTimeout');

  const { topic, tier } = engine.selectDuration(game, durationSeconds);

  // Speaker gets the topic privately
  emitToPlayer(speakerId, 'speaker:topic', { topic, tier, durationSeconds });

  // TV shows reading state with duration visible
  emitToTV(game.roomCode, 'round:speakerReading', {
    speakerName: game.players[speakerId]?.name,
    tier,
    durationSeconds,
  });

  // Non-speaker phones show waiting state
  Object.keys(game.players).forEach(pid => {
    if (pid !== speakerId) {
      emitToPlayer(pid, 'jury:waiting', { speakerName: game.players[speakerId]?.name });
    }
  });

  // After private reveal window, show topic to everyone
  game.timers.publicReveal = setTimeout(() => doPublicReveal(game), TIMINGS.SPEAKER_PRIVATE_S * 1000);
}

function doPublicReveal(game) {
  engine.beginPublicReveal(game);
  const { topic, tier, speakerId } = game.currentRound;

  emitToRoom(game.roomCode, 'round:publicReveal', {
    topic,
    tier,
    speakerId,
    speakerName: game.players[speakerId]?.name,
    countdown: TIMINGS.PUBLIC_REVEAL_S,
  });

  game.timers.startActive = setTimeout(() => {
    engine.beginRoundActive(game);
    emitToRoom(game.roomCode, 'round:active', {
      timeRemaining: game.currentRound.timeRemaining,
    });
    startRoundTicker(game);
  }, TIMINGS.PUBLIC_REVEAL_S * 1000);
}

function handleBS(game, challengerId) {
  const result = engine.triggerBS(game, challengerId);
  if (!result) return; // invalid tap

  pauseRoundTicker(game);

  emitToRoom(game.roomCode, 'challenge:start', {
    challengerId: result.challengerId,
    challengerName: result.challengerName,
    timeLimit: TIMINGS.CHALLENGE_VOTE_S,
    timeRemaining: game.currentRound.timeRemaining,
  });

  // Send vote UI to all jurors (not speaker, not challenger)
  Object.keys(game.players).forEach(pid => {
    if (pid !== game.currentRound.speakerId && pid !== challengerId) {
      emitToPlayer(pid, 'challenge:votePrompt', {
        challengerName: result.challengerName,
        timeLimit: TIMINGS.CHALLENGE_VOTE_S,
      });
    }
  });

  // Auto-resolve after vote window
  game.timers.challengeVote = setTimeout(() => resolveBS(game), TIMINGS.CHALLENGE_VOTE_S * 1000);
}

function resolveBS(game) {
  clearTimer(game, 'challengeVote');
  const { challengeSucceeds, deltas, fakeVotes, realVotes, predictionResults, inHotZone } = engine.resolveChallenge(game);

  emitToRoom(game.roomCode, 'challenge:result', {
    challengeSucceeds, deltas, fakeVotes, realVotes, inHotZone,
    leaderboard: engine.buildLeaderboard(game),
    players: Object.values(game.players).map(p => ({
      id: p.id, name: p.name, score: p.score, bsTapsRemaining: p.bsTapsRemaining,
    })),
  });

  if (challengeSucceeds) {
    // Round ends — speaker got caught
    delete suspicionMap[game.roomCode];
    game.timers.afterChallenge = setTimeout(() => {
      const lb = engine.buildLeaderboard(game);
      emitToRoom(game.roomCode, 'round:end', {
        speakerId: game.currentRound.speakerId,
        pointDeltas: game.currentRound.pointDeltas,
        predictionResults,
        leaderboard: lb,
        endedByChallenge: true,
        players: Object.values(game.players).map(p => ({ id: p.id, name: p.name, score: p.score })),
      });
      game.timers.leaderboard = setTimeout(() => showLeaderboard(game), TIMINGS.ROUND_END_S * 1000);
    }, TIMINGS.CHALLENGE_RESULT_S * 1000);
  } else {
    // Resume round with remaining time
    game.timers.afterChallenge = setTimeout(() => {
      engine.beginRoundActive(game);
      emitToRoom(game.roomCode, 'round:resumed', {
        timeRemaining: game.currentRound.timeRemaining,
      });
      resumeRoundTicker(game);
    }, TIMINGS.CHALLENGE_RESULT_S * 1000);
  }
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── TV connects and creates a room ──
  socket.on('host:createRoom', (_, cb) => {
    const roomCode = rm.generateCode();
    const game = engine.createGame(roomCode);
    rm.createRoom(game, socket.id);
    socket.join(roomCode);
    socket.data = { clientType: 'tv', roomCode };

    const base = process.env.JOIN_URL || `http://${LAN_IP}:${process.env.PORT || 3000}`;
    const joinUrl = `${base}/join/${roomCode}`;
    cb({ roomCode, joinUrl });
  });

  // ── Player joins room from phone ──
  socket.on('player:join', ({ roomCode, name }, cb) => {
    const room = rm.getRoom(roomCode);
    if (!room) return cb({ error: 'Room not found' });
    if (room.game.state !== STATES.LOBBY) return cb({ error: 'Game already in progress' });

    const cleanName = String(name).trim().slice(0, 20) || 'Player';
    engine.addPlayer(room.game, socket.id, cleanName);
    socket.join(roomCode);
    socket.data = { clientType: 'phone', roomCode, name: cleanName };

    emitToRoom(roomCode, 'lobby:update', lobbyPayload(room.game));
    cb({ ok: true, playerId: socket.id, name: cleanName });
  });

  // ── Host starts the game ──
  socket.on('host:start', () => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room || room.game.state !== STATES.LOBBY) return;
    if (engine.playerCount(room.game) < 2) return;
    startNextRound(room.game);
  });

  // ── Speaker selects tier ──
  socket.on('speaker:tierSelect', ({ tier }) => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room) return;
    handleTierSelect(room.game, socket.id, tier);
  });

  // ── Speaker selects duration ──
  socket.on('speaker:durationSelect', ({ seconds }) => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room) return;
    handleDurationSelect(room.game, socket.id, seconds);
  });

  // ── Player taps BS ──
  socket.on('player:bs', () => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room) return;
    handleBS(room.game, socket.id);
  });

  // ── Player votes during challenge ──
  socket.on('player:vote', ({ vote }) => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room) return;
    const valid = engine.submitVote(room.game, socket.id, vote);
    if (!valid) return;

    const ch = room.game.currentRound?.challenge;
    if (ch) {
      const votes = Object.values(ch.votes);
      emitToRoom(roomCode, 'challenge:voteUpdate', {
        total: votes.length,
        eligible: engine.playerCount(room.game) - 2,
      });
    }
  });

  // ── Player submits pre-round prediction ──
  socket.on('player:prediction', ({ prediction }) => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room) return;
    const ok = engine.submitPrediction(room.game, socket.id, prediction);
    if (!ok) return;
    // Let TV show a prediction count indicator
    const total = Object.keys(room.game.currentRound?.predictions || {}).length;
    const eligible = engine.playerCount(room.game) - 1; // excl speaker
    emitToTV(roomCode, 'prediction:count', { total, eligible });
  });

  // ── Player updates suspicion level (0=real, 100=fake) ──
  socket.on('player:suspicion', ({ value }) => {
    const { roomCode } = socket.data || {};
    if (!roomCode) return;
    if (!suspicionMap[roomCode]) suspicionMap[roomCode] = {};
    suspicionMap[roomCode][socket.id] = Math.max(0, Math.min(100, value));

    // Average all values and broadcast to TV
    const vals = Object.values(suspicionMap[roomCode]);
    const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 50;
    emitToTV(roomCode, 'room:suspicion', { avg, count: vals.length });
  });

  // ── Host advances to next round manually ──
  socket.on('host:nextRound', () => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room || room.game.state !== STATES.LEADERBOARD) return;
    clearTimer(room.game, 'autoAdvance');
    startNextRound(room.game);
  });

  // ── Host kicks a player ──
  socket.on('host:kick', ({ playerId }) => {
    const { roomCode } = socket.data || {};
    const room = rm.getRoom(roomCode);
    if (!room) return;
    engine.removePlayer(room.game, playerId);
    io.sockets.sockets.get(playerId)?.leave(roomCode);
    emitToPlayer(playerId, 'player:kicked', {});
    emitToRoom(roomCode, 'lobby:update', lobbyPayload(room.game));
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const { clientType, roomCode } = socket.data || {};
    if (!roomCode) return;

    const room = rm.getRoom(roomCode);
    if (!room) return;

    if (clientType === 'phone') {
      engine.removePlayer(room.game, socket.id);
      emitToRoom(roomCode, 'lobby:update', lobbyPayload(room.game));
    } else if (clientType === 'tv') {
      // TV disconnected — notify players
      emitToRoom(roomCode, 'host:disconnected', {});
      clearAllTimers(room.game);
      rm.deleteRoom(roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 LieQ server running → http://localhost:${PORT}`);
  console.log(`📺 TV Screen  → http://localhost:${PORT}/tv`);
  console.log(`📱 Phone Join → http://${LAN_IP}:${PORT}/join  ← use this for phones\n`);
});
