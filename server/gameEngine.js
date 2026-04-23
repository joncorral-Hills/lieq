// server/gameEngine.js
// Pure game logic — no I/O. All state mutations return the new state or event payload.

const { getRandomTopic } = require('./topics/topicService');

const STATES = {
  LOBBY: 'LOBBY',
  TIER_SELECT: 'TIER_SELECT',
  SPEAKER_PRIVATE: 'SPEAKER_PRIVATE',
  PUBLIC_REVEAL: 'PUBLIC_REVEAL',
  ROUND_ACTIVE: 'ROUND_ACTIVE',
  BS_CHALLENGE: 'BS_CHALLENGE',
  CHALLENGE_RESULT: 'CHALLENGE_RESULT',
  ROUND_END: 'ROUND_END',
  LEADERBOARD: 'LEADERBOARD',
  GAME_END: 'GAME_END',
};

const SCORING = {
  BASE: 100,
  TIER_MULT: { common: 1, niche: 2, deep_dive: 3 },
  VOTER_BONUS: 25,         // jurors who voted with majority
  FAIL_PENALTY: -50,       // challenger penalty on failed BS
  FAIL_SPEAKER_BONUS: 25,  // speaker bonus for surviving a BS call
};

const TIMINGS = {
  ROUND_DURATION_S: 60,
  SPEAKER_PRIVATE_S: 5,
  PUBLIC_REVEAL_S: 3,
  CHALLENGE_VOTE_S: 5,
  CHALLENGE_RESULT_S: 3,
  ROUND_END_S: 4,
  LEADERBOARD_S: 5,
  BS_COOLDOWN_MS: 5000,
};

function createGame(roomCode) {
  return {
    roomCode,
    state: STATES.LOBBY,
    players: {},        // socketId → PlayerObject
    speakerOrder: [],   // ordered array of socketIds
    speakerIndex: 0,
    currentRound: null,
    usedTopicIds: [],
    roundCount: 0,
    maxRounds: 10,
    lastBsTime: null,
    timers: {},         // named timers for cleanup
  };
}

function addPlayer(game, socketId, name) {
  game.players[socketId] = {
    id: socketId,
    name,
    score: 0,
    bsTapsRemaining: 0,
    isSpeaker: false,
    successfulBsCalls: 0,
    roundsSpoken: 0,
  };
  if (!game.speakerOrder.includes(socketId)) {
    game.speakerOrder.push(socketId);
  }
}

function removePlayer(game, socketId) {
  delete game.players[socketId];
  game.speakerOrder = game.speakerOrder.filter(id => id !== socketId);
  if (game.speakerIndex >= game.speakerOrder.length) game.speakerIndex = 0;
}

function playerCount(game) {
  return Object.keys(game.players).length;
}

function getTapsPerPlayer(count) {
  return count >= 7 ? 3 : 2;
}

// Called when host starts the game or advances to next round
function beginRound(game) {
  const count = playerCount(game);
  const taps = getTapsPerPlayer(count);

  // Reset all players' taps and speaker flag
  Object.values(game.players).forEach(p => {
    p.bsTapsRemaining = taps;
    p.isSpeaker = false;
  });

  // Advance speaker rotation
  const speakerId = game.speakerOrder[game.speakerIndex % game.speakerOrder.length];
  game.speakerIndex = (game.speakerIndex + 1) % game.speakerOrder.length;
  game.roundCount++;

  game.players[speakerId].isSpeaker = true;
  game.players[speakerId].bsTapsRemaining = 0; // speaker can't BS
  game.players[speakerId].roundsSpoken++;

  game.currentRound = {
    roundNumber: game.roundCount,
    speakerId,
    tier: null,
    topic: null,
    topicId: null,
    timeRemaining: TIMINGS.ROUND_DURATION_S,
    challenge: null,
    pointDeltas: {},
  };

  game.lastBsTime = null;
  game.state = STATES.TIER_SELECT;

  return { speakerId, tapsPerPlayer: taps };
}

// Speaker picks their tier — fetch topic and move to private reveal
function selectTier(game, tier) {
  const topic = getRandomTopic(tier, game.usedTopicIds);
  game.currentRound.tier = tier;
  game.currentRound.topic = topic.text;
  game.currentRound.topicId = topic.id;
  game.usedTopicIds.push(topic.id);
  game.state = STATES.SPEAKER_PRIVATE;
  return { topic: topic.text, topicId: topic.id, tier };
}

function beginPublicReveal(game) {
  game.state = STATES.PUBLIC_REVEAL;
}

function beginRoundActive(game) {
  game.state = STATES.ROUND_ACTIVE;
}

// Returns null if tap is invalid (no taps left, is speaker, cooldown, challenge active)
function triggerBS(game, challengerId) {
  const p = game.players[challengerId];
  if (!p) return null;
  if (p.isSpeaker) return null;
  if (p.bsTapsRemaining <= 0) return null;
  if (game.state !== STATES.ROUND_ACTIVE) return null;
  if (game.lastBsTime && Date.now() - game.lastBsTime < TIMINGS.BS_COOLDOWN_MS) return null;

  p.bsTapsRemaining--;
  game.lastBsTime = Date.now();
  game.state = STATES.BS_CHALLENGE;

  game.currentRound.challenge = {
    challengerId,
    votes: {},         // socketId → 'real' | 'fake'
    deadline: Date.now() + TIMINGS.CHALLENGE_VOTE_S * 1000,
  };

  return { challengerId, challengerName: p.name };
}

// Player submits vote during challenge
function submitVote(game, voterId, vote) {
  const ch = game.currentRound?.challenge;
  if (!ch) return false;
  if (voterId === game.currentRound.speakerId) return false; // speaker can't vote
  if (voterId === ch.challengerId) return false; // challenger can't vote on own BS
  ch.votes[voterId] = vote; // 'real' | 'fake'
  return true;
}

// Resolve challenge — returns { outcome, pointDeltas, leaderboard }
function resolveChallenge(game) {
  const ch = game.currentRound.challenge;
  const { speakerId, tier } = game.currentRound;
  const mult = SCORING.TIER_MULT[tier] || 1;

  const votes = Object.values(ch.votes);
  const fakeVotes = votes.filter(v => v === 'fake').length;
  const realVotes = votes.filter(v => v === 'real').length;

  // Tie → challenger loses (speaker-friendly default)
  const challengeSucceeds = fakeVotes > realVotes;

  const deltas = {};

  if (challengeSucceeds) {
    // Challenger wins: speaker gets 0, caller gets full points
    deltas[ch.challengerId] = SCORING.BASE * mult;
    deltas[speakerId] = 0;
    // Bonus to voters who voted FAKE (correct)
    Object.entries(ch.votes).forEach(([pid, v]) => {
      if (v === 'fake' && pid !== ch.challengerId) {
        deltas[pid] = (deltas[pid] || 0) + SCORING.VOTER_BONUS;
      }
    });
    game.players[ch.challengerId].successfulBsCalls++;
  } else {
    // Challenger fails: penalty for challenger, bonus to speaker
    deltas[ch.challengerId] = SCORING.FAIL_PENALTY;
    deltas[speakerId] = (deltas[speakerId] || 0) + SCORING.FAIL_SPEAKER_BONUS;
    // Bonus to voters who voted REAL (correct)
    Object.entries(ch.votes).forEach(([pid, v]) => {
      if (v === 'real' && pid !== ch.challengerId) {
        deltas[pid] = (deltas[pid] || 0) + SCORING.VOTER_BONUS;
      }
    });
  }

  // Apply deltas
  Object.entries(deltas).forEach(([pid, delta]) => {
    if (game.players[pid]) game.players[pid].score = Math.max(0, game.players[pid].score + delta);
  });

  game.currentRound.pointDeltas = deltas;
  game.currentRound.challenge = null;
  game.state = STATES.CHALLENGE_RESULT;

  return { challengeSucceeds, deltas, fakeVotes, realVotes };
}

// Called when timer runs out with no successful BS
function endRound(game) {
  const { speakerId, tier } = game.currentRound;
  const mult = SCORING.TIER_MULT[tier] || 1;
  const delta = SCORING.BASE * mult;

  if (game.players[speakerId]) game.players[speakerId].score += delta;

  game.currentRound.pointDeltas = { [speakerId]: delta };
  game.state = STATES.ROUND_END;

  return { speakerId, delta };
}

function buildLeaderboard(game) {
  return Object.values(game.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      score: p.score,
      successfulBsCalls: p.successfulBsCalls,
      roundsSpoken: p.roundsSpoken,
    }));
}

function isGameOver(game) {
  return game.roundCount >= game.maxRounds || game.speakerOrder.length < 2;
}

function endGame(game) {
  game.state = STATES.GAME_END;
  const lb = buildLeaderboard(game);
  return {
    winner: lb[0],
    leaderboard: lb,
    stats: {
      mostBsCalls: [...Object.values(game.players)].sort((a, b) => b.successfulBsCalls - a.successfulBsCalls)[0],
      roundsPlayed: game.roundCount,
    },
  };
}

module.exports = {
  STATES, TIMINGS, SCORING,
  createGame, addPlayer, removePlayer, playerCount,
  beginRound, selectTier, beginPublicReveal, beginRoundActive,
  triggerBS, submitVote, resolveChallenge, endRound,
  buildLeaderboard, isGameOver, endGame,
};
