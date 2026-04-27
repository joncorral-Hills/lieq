// server/gameEngine.js
const { getRandomTopic } = require('./topics/topicService');

const STATES = {
  LOBBY: 'LOBBY', TIER_SELECT: 'TIER_SELECT', DURATION_SELECT: 'DURATION_SELECT',
  SPEAKER_PRIVATE: 'SPEAKER_PRIVATE', PUBLIC_REVEAL: 'PUBLIC_REVEAL',
  ROUND_ACTIVE: 'ROUND_ACTIVE', BS_CHALLENGE: 'BS_CHALLENGE',
  CHALLENGE_RESULT: 'CHALLENGE_RESULT', ROUND_END: 'ROUND_END',
  LEADERBOARD: 'LEADERBOARD', GAME_END: 'GAME_END',
};

const SCORING = {
  BASE: 100,
  TIER_MULT: { common: 1, niche: 2, deep_dive: 3 },
  VOTER_BONUS: 25,
  FAIL_PENALTY: -50,
  FAIL_SPEAKER_BONUS: 25,
  PREDICTION_BONUS: 15,
  HOT_ZONE_MULT: 1.5,  // multiplier applied inside final 10s
  HOT_ZONE_THRESHOLD: 10,
};

const TIMINGS = {
  ROUND_DURATION_S: 60, SPEAKER_PRIVATE_S: 5, PUBLIC_REVEAL_S: 3,
  CHALLENGE_VOTE_S: 5, CHALLENGE_RESULT_S: 3, ROUND_END_S: 4,
  LEADERBOARD_S: 5, BS_COOLDOWN_MS: 5000,
};

function createGame(roomCode) {
  return {
    roomCode, state: STATES.LOBBY,
    players: {}, speakerOrder: [], speakerIndex: 0,
    currentRound: null, usedTopicIds: [],
    roundCount: 0, maxRounds: 10, lastBsTime: null, timers: {},
  };
}

function addPlayer(game, socketId, name) {
  game.players[socketId] = {
    id: socketId, name, score: 0,
    bsTapsRemaining: 0, isSpeaker: false,
    // Stats for badges
    successfulBsCalls: 0, roundsSpoken: 0,
    bsCallsAttempted: 0, predictionsCorrect: 0,
    survivedUnderPressure: false,
  };
  if (!game.speakerOrder.includes(socketId)) game.speakerOrder.push(socketId);
}

function removePlayer(game, socketId) {
  delete game.players[socketId];
  game.speakerOrder = game.speakerOrder.filter(id => id !== socketId);
  if (game.speakerIndex >= game.speakerOrder.length) game.speakerIndex = 0;
}

function playerCount(game) { return Object.keys(game.players).length; }
function getTapsPerPlayer(count) { return count >= 7 ? 3 : 2; }

function beginRound(game) {
  const count = playerCount(game);
  const taps = getTapsPerPlayer(count);
  Object.values(game.players).forEach(p => { p.bsTapsRemaining = taps; p.isSpeaker = false; });

  const speakerId = game.speakerOrder[game.speakerIndex % game.speakerOrder.length];
  game.speakerIndex = (game.speakerIndex + 1) % game.speakerOrder.length;
  game.roundCount++;

  game.players[speakerId].isSpeaker = true;
  game.players[speakerId].bsTapsRemaining = 0;
  game.players[speakerId].roundsSpoken++;

  game.currentRound = {
    roundNumber: game.roundCount, speakerId,
    tier: null, topic: null, topicId: null,
    timeRemaining: TIMINGS.ROUND_DURATION_S,
    inHotZone: false,
    challenge: null, pointDeltas: {},
    predictions: {},  // playerId → 'real'|'fake'
  };

  game.lastBsTime = null;
  game.state = STATES.TIER_SELECT;
  return { speakerId, tapsPerPlayer: taps };
}

function selectTier(game, tier) {
  game.currentRound.tier = tier;
  game.state = STATES.DURATION_SELECT;
  return { tier };
}

function selectDuration(game, durationSeconds) {
  const { tier } = game.currentRound;
  const topic = getRandomTopic(tier, game.usedTopicIds);
  game.currentRound.topic = topic.text;
  game.currentRound.topicId = topic.id;
  game.currentRound.timeRemaining = durationSeconds;
  game.usedTopicIds.push(topic.id);
  game.state = STATES.SPEAKER_PRIVATE;
  return { topic: topic.text, topicId: topic.id, tier, durationSeconds };
}

function beginPublicReveal(game) { game.state = STATES.PUBLIC_REVEAL; }
function beginRoundActive(game) { game.state = STATES.ROUND_ACTIVE; }

function enterHotZone(game) {
  game.currentRound.inHotZone = true;
}

// ── Prediction ────────────────────────────────────────────────────────────────
function submitPrediction(game, playerId, prediction) {
  if (!game.currentRound) return false;
  if (playerId === game.currentRound.speakerId) return false;
  game.currentRound.predictions[playerId] = prediction;
  return true;
}

function resolvePredictions(game, outcome, deltas) {
  // outcome: 'real' (speaker survived) | 'fake' (speaker busted)
  const results = {};
  Object.entries(game.currentRound.predictions).forEach(([pid, pred]) => {
    const correct = pred === outcome;
    results[pid] = { pred, correct };
    if (correct && game.players[pid]) {
      game.players[pid].score += SCORING.PREDICTION_BONUS;
      game.players[pid].predictionsCorrect++;
      deltas[pid] = (deltas[pid] || 0) + SCORING.PREDICTION_BONUS;
    }
  });
  return results;
}

// ── BS trigger ────────────────────────────────────────────────────────────────
function triggerBS(game, challengerId) {
  const p = game.players[challengerId];
  if (!p || p.isSpeaker || p.bsTapsRemaining <= 0) return null;
  if (game.state !== STATES.ROUND_ACTIVE) return null;
  if (game.lastBsTime && Date.now() - game.lastBsTime < TIMINGS.BS_COOLDOWN_MS) return null;

  p.bsTapsRemaining--;
  p.bsCallsAttempted++;
  game.lastBsTime = Date.now();
  game.state = STATES.BS_CHALLENGE;

  game.currentRound.challenge = {
    challengerId,
    votes: {},
    deadline: Date.now() + TIMINGS.CHALLENGE_VOTE_S * 1000,
    inHotZone: game.currentRound.inHotZone,
  };
  return { challengerId, challengerName: p.name, inHotZone: game.currentRound.inHotZone };
}

function submitVote(game, voterId, vote) {
  const ch = game.currentRound?.challenge;
  if (!ch) return false;
  if (voterId === game.currentRound.speakerId) return false;
  if (voterId === ch.challengerId) return false;
  ch.votes[voterId] = vote;
  return true;
}

function resolveChallenge(game) {
  const ch = game.currentRound.challenge;
  const { speakerId, tier } = game.currentRound;
  const baseMult = SCORING.TIER_MULT[tier] || 1;
  const hotMult = ch.inHotZone ? SCORING.HOT_ZONE_MULT : 1;

  const votes = Object.values(ch.votes);
  const fakeVotes = votes.filter(v => v === 'fake').length;
  const realVotes = votes.filter(v => v === 'real').length;
  const challengeSucceeds = fakeVotes > realVotes;

  const deltas = {};

  if (challengeSucceeds) {
    deltas[ch.challengerId] = Math.round(SCORING.BASE * baseMult * hotMult);
    deltas[speakerId] = 0;
    Object.entries(ch.votes).forEach(([pid, v]) => {
      if (v === 'fake' && pid !== ch.challengerId)
        deltas[pid] = (deltas[pid] || 0) + SCORING.VOTER_BONUS;
    });
    game.players[ch.challengerId].successfulBsCalls++;
  } else {
    deltas[ch.challengerId] = Math.round(SCORING.FAIL_PENALTY * hotMult);
    deltas[speakerId] = (deltas[speakerId] || 0) + SCORING.FAIL_SPEAKER_BONUS;
    Object.entries(ch.votes).forEach(([pid, v]) => {
      if (v === 'real' && pid !== ch.challengerId)
        deltas[pid] = (deltas[pid] || 0) + SCORING.VOTER_BONUS;
    });
    // Ice Cold badge: survived with <= 15s left
    if (game.currentRound.timeRemaining <= 15 && game.players[speakerId]) {
      game.players[speakerId].survivedUnderPressure = true;
    }
  }

  // Apply base deltas first, then resolve predictions separately (resolvePredictions mutates scores directly)
  Object.entries(deltas).forEach(([pid, delta]) => {
    if (game.players[pid]) game.players[pid].score = Math.max(0, game.players[pid].score + delta);
  });

  const outcome = challengeSucceeds ? 'fake' : 'real';
  const predictionResults = resolvePredictions(game, outcome, deltas);

  game.currentRound.pointDeltas = deltas;
  game.currentRound.challenge = null;
  game.state = STATES.CHALLENGE_RESULT;

  return { challengeSucceeds, deltas, fakeVotes, realVotes, predictionResults, inHotZone: ch.inHotZone };
}

function endRound(game) {
  const { speakerId, tier } = game.currentRound;
  const mult = SCORING.TIER_MULT[tier] || 1;
  const delta = SCORING.BASE * mult;

  if (game.players[speakerId]) game.players[speakerId].score += delta;
  game.currentRound.pointDeltas = { [speakerId]: delta };

  // Resolve predictions — speaker survived (outcome: 'real')
  // resolvePredictions() mutates scores directly and populates deltas[pid] for correct predictors
  const deltas = { [speakerId]: delta };
  const predictionResults = resolvePredictions(game, 'real', deltas);
  game.currentRound.pointDeltas = deltas;
  game.state = STATES.ROUND_END;

  return { speakerId, delta, predictionResults };
}

// ── Badges ────────────────────────────────────────────────────────────────────
function calculateBadges(game) {
  const players = Object.values(game.players);
  if (players.length < 2) return [];
  const badges = [];
  const add = (player, badge, label, desc) => {
    if (player) badges.push({ playerId: player.id, playerName: player.name, badge, label, desc });
  };

  // Most Convincing: spoken ≥1 round and never successfully BS'd
  const convincing = players.filter(p => p.roundsSpoken >= 1 && p.successfulBsCalls === 0)
    .sort((a, b) => b.roundsSpoken - a.roundsSpoken)[0];
  add(convincing, 'most_convincing', '🎭 Most Convincing', 'Never got caught');

  // Trigger Happy: most BS taps attempted
  const triggerHappy = [...players].sort((a, b) => b.bsCallsAttempted - a.bsCallsAttempted)[0];
  if (triggerHappy?.bsCallsAttempted > 0)
    add(triggerHappy, 'trigger_happy', '🚨 Trigger Happy', `${triggerHappy.bsCallsAttempted} BS calls fired`);

  // The Oracle: most correct predictions
  const oracle = [...players].sort((a, b) => b.predictionsCorrect - a.predictionsCorrect)[0];
  if (oracle?.predictionsCorrect > 0)
    add(oracle, 'oracle', '🧠 The Oracle', `${oracle.predictionsCorrect} correct predictions`);

  // Sharpshooter: best BS success rate (min 2 attempts)
  const shooters = players.filter(p => p.bsCallsAttempted >= 2);
  if (shooters.length) {
    const sharp = shooters.sort((a, b) =>
      (b.successfulBsCalls / b.bsCallsAttempted) - (a.successfulBsCalls / a.bsCallsAttempted)
    )[0];
    const pct = Math.round((sharp.successfulBsCalls / sharp.bsCallsAttempted) * 100);
    add(sharp, 'sharpshooter', '🎯 Sharpshooter', `${pct}% BS accuracy`);
  }

  // Ice Cold: survived BS challenge with ≤15s left
  const iceCold = players.find(p => p.survivedUnderPressure);
  add(iceCold, 'ice_cold', '💎 Ice Cold', 'Survived BS with ≤15s left');

  // Overconfident: most failed BS calls
  const overConf = [...players]
    .filter(p => (p.bsCallsAttempted - p.successfulBsCalls) > 0)
    .sort((a, b) => (b.bsCallsAttempted - b.successfulBsCalls) - (a.bsCallsAttempted - a.successfulBsCalls))[0];
  if (overConf) {
    const failed = overConf.bsCallsAttempted - overConf.successfulBsCalls;
    add(overConf, 'overconfident', '😬 Overconfident', `${failed} misfires`);
  }

  return badges;
}

function buildLeaderboard(game) {
  return Object.values(game.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, score: p.score,
      successfulBsCalls: p.successfulBsCalls, roundsSpoken: p.roundsSpoken,
    }));
}

function isGameOver(game) {
  return game.roundCount >= game.maxRounds || game.speakerOrder.length < 2;
}

function endGame(game) {
  game.state = STATES.GAME_END;
  const lb = buildLeaderboard(game);
  const badges = calculateBadges(game);
  return {
    winner: lb[0], leaderboard: lb, badges,
    stats: {
      mostBsCalls: [...Object.values(game.players)].sort((a, b) => b.successfulBsCalls - a.successfulBsCalls)[0],
      roundsPlayed: game.roundCount,
    },
  };
}

module.exports = {
  STATES, TIMINGS, SCORING,
  createGame, addPlayer, removePlayer, playerCount,
  beginRound, selectTier, selectDuration, beginPublicReveal, beginRoundActive,
  enterHotZone, submitPrediction, triggerBS, submitVote, resolveChallenge, endRound,
  buildLeaderboard, isGameOver, endGame,
};
