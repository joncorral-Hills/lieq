// public/phone/phone.js — Phone client
const socket = io();

let myId = null, myName = '', myRole = 'jury';
let bsTapsRemaining = 0, currentTopic = '', currentTier = '';
let speakerName = '', roundActive = false, bsCooldown = false;
let predictionMade = false;
let predTimer = null;

// ── Helpers ────────────────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}
function el(id) { return document.getElementById(id); }
function setText(id, v) { const e = el(id); if (e) e.textContent = v; }

function renderTapDots(count, max) {
  const wrap = el('ja-taps'); if (!wrap) return;
  const total = Math.max(count, max);
  wrap.innerHTML = Array.from({ length: total }, (_, i) =>
    `<div class="tap-dot-phone${i >= count ? ' used' : ''}"></div>`
  ).join('');
}

function setTierPill(id, tier) {
  const e = el(id); if (!e) return;
  const labels = { common: 'COMMON ×1', niche: 'NICHE ×2', deep_dive: 'DEEP DIVE ×3' };
  e.textContent = labels[tier] || tier;
  e.className = `tier-pill ${tier}`;
}
function setTierPillSmall(id, tier) {
  const e = el(id); if (!e) return;
  const labels = { common: 'COMMON', niche: 'NICHE', deep_dive: 'DEEP DIVE' };
  e.textContent = labels[tier] || tier;
  e.className = `tier-pill-small ${tier}`;
}
function startChallengeTimerBar(durationS) {
  const bar = el('cv-timer-bar'); if (!bar) return;
  bar.style.transition = 'none'; bar.style.width = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.style.transition = `width ${durationS}s linear`;
    bar.style.width = '0%';
  }));
}

// ── Auto-fill room code from URL ──────────────────────────────────────────
window.addEventListener('load', () => {
  const code = new URLSearchParams(window.location.search).get('code');
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
    myId = res.playerId; myName = res.name;
    setText('lw-name', myName);
    show('screen-lobby-wait');
  });
});
el('code-input').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

// ── Lobby ──────────────────────────────────────────────────────────────────
socket.on('lobby:update', ({ players }) => {
  setText('lw-player-count', `${players.length} player${players.length !== 1 ? 's' : ''}`);
});

// ── Round start ────────────────────────────────────────────────────────────
socket.on('round:new', ({ speakerId, tapsPerPlayer, players }) => {
  myRole = speakerId === myId ? 'speaker' : 'jury';
  bsTapsRemaining = tapsPerPlayer;
  roundActive = false; bsCooldown = false; predictionMade = false;
  const me = players.find(p => p.id === myId);
  if (me) bsTapsRemaining = me.bsTapsRemaining;
  // Reset hot zone
  const hz = el('ja-hot-zone'); if (hz) hz.style.display = 'none';
  el('btn-bs')?.classList.remove('hot-zone');
});

// ── Speaker: tier ──────────────────────────────────────────────────────────
socket.on('speaker:selectTier', () => show('screen-tier-select'));
document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', () => socket.emit('speaker:tierSelect', { tier: btn.dataset.tier }));
});

// ── Speaker: duration ─────────────────────────────────────────────────────
const tierLabels = { common: 'Common ×1', niche: 'Niche ×2', deep_dive: 'Deep Dive ×3' };
socket.on('speaker:selectDuration', ({ tier }) => {
  const e = el('ds-tier-context');
  if (e) e.textContent = `Tier chosen: ${tierLabels[tier] || tier} — pick your time:`;
  show('screen-duration-select');
});
document.querySelectorAll('.duration-btn').forEach(btn => {
  btn.addEventListener('click', () => socket.emit('speaker:durationSelect', { seconds: parseInt(btn.dataset.seconds, 10) }));
});

// ── Speaker: topic ────────────────────────────────────────────────────────
socket.on('speaker:topic', ({ topic, tier, durationSeconds }) => {
  currentTopic = topic; currentTier = tier;
  setText('st-topic', topic);
  setTierPill('st-tier-badge', tier);
  const dur = el('st-duration');
  if (dur) dur.textContent = durationSeconds === 120 ? '2 minutes' : '1 minute';
  show('screen-speaker-topic');
});

// ── Jury: waiting ─────────────────────────────────────────────────────────
socket.on('jury:waiting', ({ speakerName: sn }) => {
  speakerName = sn;
  setText('jw-speaker-name', sn);
  show('screen-jury-wait');
});

// ── Public reveal → show topic on jury screen ─────────────────────────────
socket.on('round:publicReveal', ({ topic, tier, speakerName: sn }) => {
  currentTopic = topic; currentTier = tier; speakerName = sn;
  if (myRole === 'jury') {
    setText('ja-topic', topic);
    setTierPillSmall('ja-tier', tier);
  }
});

// ── Round active: show jury screen + prediction overlay ───────────────────
socket.on('round:active', ({ timeRemaining }) => {
  roundActive = true;
  if (myRole === 'jury') {
    setText('ja-timer', timeRemaining);
    renderTapDots(bsTapsRemaining, 3);
    el('btn-bs').disabled = true; // disabled until prediction resolved
    show('screen-jury-active');

    // Prediction overlay: 8 seconds
    predictionMade = false;
    const overlay = el('prediction-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      SoundEngine.prediction();
      // Animate the timer bar
      const bar = el('pred-timer-bar');
      if (bar) {
        bar.style.transition = 'none'; bar.style.width = '100%';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          bar.style.transition = 'width 8s linear';
          bar.style.width = '0%';
        }));
      }
      predTimer = setTimeout(() => hidePredictionOverlay(true), 8000);
    }
  }
});

function hidePredictionOverlay(enableBs = true) {
  clearTimeout(predTimer);
  const overlay = el('prediction-overlay');
  if (overlay) overlay.style.display = 'none';
  if (enableBs && roundActive && bsTapsRemaining > 0) el('btn-bs').disabled = false;
}

function submitPrediction(prediction) {
  if (predictionMade) return;
  predictionMade = true;
  socket.emit('player:prediction', { prediction });
  SoundEngine.prediction();
  hidePredictionOverlay(true);
}

el('btn-predict-real')?.addEventListener('click', () => submitPrediction('real'));
el('btn-predict-fake')?.addEventListener('click', () => submitPrediction('fake'));
el('btn-pred-skip')?.addEventListener('click', () => hidePredictionOverlay(true));

// ── Suspicion zone ────────────────────────────────────────────────────────
let suspicionActive = null;
document.querySelectorAll('.sus-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = parseInt(btn.dataset.val, 10);
    suspicionActive = val;
    // Update active state
    document.querySelectorAll('.sus-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    socket.emit('player:suspicion', { value: val });
  });
});

// ── Tick ──────────────────────────────────────────────────────────────────
socket.on('round:tick', ({ timeRemaining }) => {
  setText('ja-timer', timeRemaining);
  const t = el('ja-timer');
  if (t) t.className = 'jury-timer' + (timeRemaining <= 10 ? ' danger' : timeRemaining <= 20 ? ' warn' : '');
  if (myRole === 'jury' && timeRemaining <= 10) SoundEngine.tick();
});

// ── Hot Zone ──────────────────────────────────────────────────────────────
socket.on('round:hotZone', () => {
  SoundEngine.hotZone();
  const hz = el('ja-hot-zone');
  if (hz) hz.style.display = 'block';
  el('btn-bs')?.classList.add('hot-zone');
});

// ── BS tap ────────────────────────────────────────────────────────────────
el('btn-bs').addEventListener('click', () => {
  if (!roundActive || bsTapsRemaining <= 0 || bsCooldown) return;
  SoundEngine.bs();
  socket.emit('player:bs');
  bsTapsRemaining--;
  bsCooldown = true;
  el('btn-bs').disabled = true;
  el('ja-cooldown').style.display = 'block';
  setTimeout(() => {
    bsCooldown = false;
    el('ja-cooldown').style.display = 'none';
    if (roundActive && bsTapsRemaining > 0) el('btn-bs').disabled = false;
  }, 5000);
  renderTapDots(bsTapsRemaining, 3);
});

// ── Challenge vote ────────────────────────────────────────────────────────
socket.on('challenge:votePrompt', ({ challengerName, timeLimit }) => {
  SoundEngine.challenge();
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

// ── Challenge result ──────────────────────────────────────────────────────
socket.on('challenge:result', ({ challengeSucceeds, deltas, players }) => {
  if (challengeSucceeds) SoundEngine.fakeVerdict(); else SoundEngine.realVerdict();
  roundActive = !challengeSucceeds;
  const me = players.find(p => p.id === myId);
  if (me) bsTapsRemaining = me.bsTapsRemaining;
  showRoundResult(deltas[myId] || 0, me?.score || 0, null);
});

// ── Round resumed ─────────────────────────────────────────────────────────
socket.on('round:resumed', () => {
  roundActive = true;
  if (myRole === 'jury') {
    renderTapDots(bsTapsRemaining, 3);
    el('btn-bs').disabled = bsTapsRemaining <= 0;
    show('screen-jury-active');
  }
});

// ── Round end ─────────────────────────────────────────────────────────────
socket.on('round:end', ({ pointDeltas, predictionResults, players }) => {
  roundActive = false;
  suspicionActive = null;
  document.querySelectorAll('.sus-btn').forEach(b => b.classList.remove('active'));

  const delta = pointDeltas?.[myId] || 0;
  const me = players?.find(p => p.id === myId);
  const predResult = predictionResults?.[myId];
  showRoundResult(delta, me?.score || 0, predResult);
});

function showRoundResult(delta, totalScore, predResult) {
  const icon = delta > 0 ? '🎯' : delta < 0 ? '😬' : '😶';
  const sign = delta > 0 ? '+' : '';
  setText('rr-icon', icon);
  el('rr-delta').textContent = `${sign}${delta}`;
  el('rr-delta').style.color = delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--muted)';
  setText('rr-total', `${totalScore} pts total`);

  const predEl = el('rr-prediction');
  if (predEl && predResult) {
    predEl.style.display = 'block';
    predEl.textContent = predResult.correct ? '🔮 +15 Prediction correct!' : `🔮 Prediction wrong (was ${predResult.pred === 'real' ? 'REAL' : 'FAKE'})`;
    predEl.style.color = predResult.correct ? 'var(--gold)' : 'var(--muted)';
    predEl.style.background = predResult.correct ? 'rgba(255,215,0,0.1)' : 'transparent';
    predEl.style.border = predResult.correct ? '1px solid var(--gold)' : '1px solid var(--border)';
  } else if (predEl) {
    predEl.style.display = 'none';
  }
  show('screen-round-result');
}

// ── Game end ──────────────────────────────────────────────────────────────
socket.on('game:end', ({ leaderboard, badges }) => {
  SoundEngine.winner();
  const me = leaderboard.find(p => p.id === myId);
  const rank = me ? leaderboard.indexOf(me) + 1 : '?';
  const icons = ['🥇', '🥈', '🥉'];
  setText('pe-icon', icons[rank - 1] || '🎮');
  setText('pe-rank', `#${rank}`);
  setText('pe-name', myName);
  setText('pe-score', `${me?.score || 0} pts`);

  // Show badge if earned
  const myBadge = badges?.find(b => b.playerId === myId);
  const badgeEl = el('pe-badge');
  if (badgeEl && myBadge) {
    badgeEl.style.display = 'block';
    badgeEl.textContent = `${myBadge.label} — ${myBadge.desc}`;
  } else if (badgeEl) {
    badgeEl.style.display = 'none';
  }
  show('screen-phone-game-end');
});

socket.on('player:kicked', () => { alert('You were removed from the game.'); location.href = '/join'; });
socket.on('host:disconnected', () => { alert('The host disconnected. Game over.'); location.href = '/join'; });
