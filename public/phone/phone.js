// public/phone/phone.js — Phone client
const socket = io();

let myId = null;
let myName = '';
let myRole = 'jury'; // 'speaker' | 'jury'
let bsTapsRemaining = 0;
let currentTopic = '';
let currentTier = '';
let speakerName = '';
let roundActive = false;
let bsCooldown = false;

// ── Helpers ──────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}
function el(id) { return document.getElementById(id); }
function setText(id, v) { const e = el(id); if (e) e.textContent = v; }

function renderTapDots(count, max) {
  const wrap = el('ja-taps');
  if (!wrap) return;
  const total = Math.max(count, max);
  wrap.innerHTML = Array.from({ length: total }, (_, i) =>
    `<div class="tap-dot-phone${i >= count ? ' used' : ''}"></div>`
  ).join('');
}

function setTierPill(id, tier) {
  const e = el(id);
  if (!e) return;
  const labels = { common: 'COMMON ×1', niche: 'NICHE ×2', deep_dive: 'DEEP DIVE ×3' };
  e.textContent = labels[tier] || tier;
  e.className = `tier-pill ${tier}`;
}

function setTierPillSmall(id, tier) {
  const e = el(id);
  if (!e) return;
  const labels = { common: 'COMMON', niche: 'NICHE', deep_dive: 'DEEP DIVE' };
  e.textContent = labels[tier] || tier;
  e.className = `tier-pill-small ${tier}`;
}

function startChallengeTimerBar(durationS) {
  const bar = el('cv-timer-bar');
  if (!bar) return;
  bar.style.transition = 'none'; bar.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${durationS}s linear`;
    bar.style.width = '0%';
  }));
}

// ── Auto-fill room code from URL ─────────────────────────────────────────
window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) el('code-input').value = code.toUpperCase();
  show('screen-join');
});

// ── Join flow ─────────────────────────────────────────────────────────────
el('btn-join').addEventListener('click', () => {
  const code = (el('code-input').value || '').trim().toUpperCase();
  const name = (el('name-input').value || '').trim();
  if (!code || code.length !== 4) { setText('join-error', 'Enter a 4-letter room code'); return; }
  if (!name) { setText('join-error', 'Enter your name'); return; }
  setText('join-error', '');

  socket.emit('player:join', { roomCode: code, name }, (res) => {
    if (res.error) { setText('join-error', res.error); return; }
    myId = res.playerId;
    myName = res.name;
    setText('lw-name', myName);
    show('screen-lobby-wait');
  });
});

el('code-input').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

// ── Lobby update ──────────────────────────────────────────────────────────
socket.on('lobby:update', ({ players }) => {
  setText('lw-player-count', `${players.length} player${players.length !== 1 ? 's' : ''}`);
});

// ── Round start: am I speaker? ────────────────────────────────────────────
socket.on('round:new', ({ speakerId, tapsPerPlayer, players }) => {
  myRole = speakerId === myId ? 'speaker' : 'jury';
  bsTapsRemaining = tapsPerPlayer;
  roundActive = false;
  bsCooldown = false;
  // Update my tap count from server
  const me = players.find(p => p.id === myId);
  if (me) bsTapsRemaining = me.bsTapsRemaining;
});

// ── Speaker: choose tier ──────────────────────────────────────────────────
socket.on('speaker:selectTier', () => {
  show('screen-tier-select');
});

document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    socket.emit('speaker:tierSelect', { tier: btn.dataset.tier });
  });
});

// ── Speaker: private topic ────────────────────────────────────────────────
socket.on('speaker:topic', ({ topic, tier }) => {
  currentTopic = topic;
  currentTier = tier;
  setText('st-topic', topic);
  setTierPill('st-tier-badge', tier);
  show('screen-speaker-topic');
});

// ── Jury: waiting for speaker ─────────────────────────────────────────────
socket.on('jury:waiting', ({ speakerName: sn }) => {
  speakerName = sn;
  setText('jw-speaker-name', sn);
  show('screen-jury-wait');
});

// ── Public reveal → jury active ───────────────────────────────────────────
socket.on('round:publicReveal', ({ topic, tier, speakerName: sn }) => {
  currentTopic = topic;
  currentTier = tier;
  speakerName = sn;
  if (myRole === 'jury') {
    setText('ja-topic', topic);
    setTierPillSmall('ja-tier', tier);
  }
});

socket.on('round:active', () => {
  roundActive = true;
  if (myRole === 'jury') {
    renderTapDots(bsTapsRemaining, 3);
    const btn = el('btn-bs');
    btn.disabled = bsTapsRemaining <= 0;
    show('screen-jury-active');
  }
  // Speaker sees their topic card — nothing to change
});

socket.on('round:tick', ({ timeRemaining }) => {
  const t = el('ja-timer');
  if (t) {
    t.textContent = timeRemaining;
    t.className = 'jury-timer' + (timeRemaining <= 10 ? ' danger' : timeRemaining <= 20 ? ' warn' : '');
  }
});

// ── BS tap ────────────────────────────────────────────────────────────────
el('btn-bs').addEventListener('click', () => {
  if (!roundActive || bsTapsRemaining <= 0 || bsCooldown) return;
  socket.emit('player:bs');
  bsTapsRemaining--;
  bsCooldown = true;
  el('btn-bs').disabled = true;
  el('ja-cooldown').style.display = 'block';
  // Allow re-enable after cooldown (server may allow another tap)
  setTimeout(() => {
    bsCooldown = false;
    el('ja-cooldown').style.display = 'none';
    if (roundActive && bsTapsRemaining > 0) el('btn-bs').disabled = false;
  }, 5000);
  renderTapDots(bsTapsRemaining, 3);
});

// ── Challenge: vote prompt ────────────────────────────────────────────────
socket.on('challenge:votePrompt', ({ challengerName, timeLimit }) => {
  setText('cv-challenger', challengerName);
  setText('cv-speaker', speakerName || 'the speaker');
  el('cv-voted').style.display = 'none';
  el('btn-real').disabled = false;
  el('btn-fake').disabled = false;
  startChallengeTimerBar(timeLimit);
  show('screen-challenge-vote');
});

function submitVote(vote) {
  socket.emit('player:vote', { vote });
  el('btn-real').disabled = true;
  el('btn-fake').disabled = true;
  el('cv-voted').style.display = 'block';
}

el('btn-real').addEventListener('click', () => submitVote('real'));
el('btn-fake').addEventListener('click', () => submitVote('fake'));

// ── Challenge resolved ────────────────────────────────────────────────────
socket.on('challenge:result', ({ challengeSucceeds, deltas, players }) => {
  roundActive = !challengeSucceeds;
  const me = players.find(p => p.id === myId);
  if (me) bsTapsRemaining = me.bsTapsRemaining;

  const delta = deltas[myId] || 0;
  const icon = delta > 0 ? '🎉' : delta < 0 ? '😬' : '😐';
  setText('rr-icon', icon);
  const sign = delta > 0 ? '+' : '';
  el('rr-delta').textContent = `${sign}${delta}`;
  el('rr-delta').style.color = delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--muted)';
  if (me) setText('rr-total', `${me.score} pts total`);
  show('screen-round-result');
});

// ── Round resumed after failed challenge ──────────────────────────────────
socket.on('round:resumed', () => {
  roundActive = true;
  if (myRole === 'jury') {
    renderTapDots(bsTapsRemaining, 3);
    el('btn-bs').disabled = bsTapsRemaining <= 0;
    show('screen-jury-active');
  }
});

// ── Round end ─────────────────────────────────────────────────────────────
socket.on('round:end', ({ pointDeltas, leaderboard }) => {
  roundActive = false;
  const delta = pointDeltas?.[myId] || 0;
  const me = leaderboard?.find(p => p.id === myId);
  const sign = delta > 0 ? '+' : '';
  const icon = delta > 0 ? '🎯' : '😶';
  setText('rr-icon', icon);
  el('rr-delta').textContent = `${sign}${delta}`;
  el('rr-delta').style.color = delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--muted)';
  if (me) setText('rr-total', `${me.score} pts total`);
  show('screen-round-result');
});

// ── Game end ──────────────────────────────────────────────────────────────
socket.on('game:end', ({ leaderboard }) => {
  const me = leaderboard.find(p => p.id === myId);
  const rank = me ? leaderboard.indexOf(me) + 1 : '?';
  const icons = ['🥇', '🥈', '🥉'];
  setText('pe-icon', icons[rank - 1] || '🎮');
  setText('pe-rank', `#${rank}`);
  setText('pe-name', myName);
  setText('pe-score', `${me?.score || 0} pts`);
  show('screen-phone-game-end');
});

socket.on('player:kicked', () => {
  alert('You were removed from the game.');
  location.href = '/join';
});

socket.on('host:disconnected', () => {
  alert('The host disconnected. Game over.');
  location.href = '/join';
});
