// public/tv/tv.js — TV screen client
const socket = io();
socket.data = {};

// ── Screen management ──────────────────────────────────────────────────────
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}
function el(id) { return document.getElementById(id); }
function setText(id, val) { const e = el(id); if (e) e.textContent = val; }

// ── QR Code ───────────────────────────────────────────────────────────────
let qrGenerated = false;
function renderQR(url) {
  if (qrGenerated) return;
  el('qrcode').innerHTML = '';
  new QRCode(el('qrcode'), { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  qrGenerated = true;
}

// ── Timer ring ────────────────────────────────────────────────────────────
const RING_CIRC = 2 * Math.PI * 52; // ~326.7
let maxTime = 60;
function updateRing(timeRemaining) {
  const progress = timeRemaining / maxTime;
  const offset = RING_CIRC * (1 - progress);
  const ring = el('ring-progress');
  if (!ring) return;
  ring.style.strokeDashoffset = offset;
  // Color: green → yellow → red
  const hue = Math.round(progress * 120);
  ring.style.stroke = `hsl(${hue}, 100%, 55%)`;
}

// ── Players helpers ───────────────────────────────────────────────────────
function renderPlayerList(players) {
  const list = el('player-list');
  if (!list) return;
  list.innerHTML = players.map(p =>
    `<li>${p.name}</li>`
  ).join('');
  setText('player-count-badge', players.length);
  const btn = el('btn-start');
  if (btn) {
    btn.disabled = players.length < 2;
    setText('start-hint', players.length < 2 ? 'Need at least 2 players' : `${players.length} players ready — let's go!`);
  }
}

function renderTapRow(players) {
  const row = el('ac-player-tap-row');
  if (!row) return;
  row.innerHTML = players.map(p => {
    const dots = Array.from({ length: p.bsTapsRemaining + (p.bsTapsRemaining < 3 ? 3 - p.bsTapsRemaining : 0) }, (_, i) => {
      return `<span class="tap-dot${i >= p.bsTapsRemaining ? ' used' : ''}"></span>`;
    }).join('');
    return `<div class="tap-chip">${p.name} ${dots}</div>`;
  }).join('');
}

// ── Tier helpers ──────────────────────────────────────────────────────────
const tierLabel = { common: 'COMMON', niche: 'NICHE', deep_dive: 'DEEP DIVE' };
function setTierBadge(id, tier) {
  const e = el(id);
  if (!e) return;
  e.textContent = tierLabel[tier] || tier;
  e.className = `tier-badge-large ${tier}`;
}
function setTierBadgeSmall(id, tier) {
  const e = el(id);
  if (!e) return;
  e.textContent = tierLabel[tier] || tier;
  e.className = `tier-badge-small ${tier}`;
}

// ── Vote bar ─────────────────────────────────────────────────────────────
function updateVoteBar(real, fake) {
  const total = real + fake || 1;
  const rp = Math.round((real / total) * 100);
  const fp = 100 - rp;
  el('ch-real-bar').style.width = rp + '%';
  el('ch-fake-bar').style.width = fp + '%';
  el('ch-real-pct').textContent = rp;
  el('ch-fake-pct').textContent = fp;
}

// ── Leaderboard renderer ──────────────────────────────────────────────────
function renderLeaderboard(lb) {
  const list = el('lb-list');
  if (!list) return;
  list.innerHTML = lb.map((p, i) =>
    `<li class="lb-item rank-${i + 1}">
      <span class="lb-rank">${i === 0 ? '👑' : i + 1}</span>
      <span class="lb-name">${p.name}</span>
      <span class="lb-score">${p.score}</span>
    </li>`
  ).join('');
}

// ── Delta renderer ────────────────────────────────────────────────────────
function renderDeltas(deltas, players) {
  const playerMap = {};
  if (players) players.forEach(p => playerMap[p.id] = p.name);

  return Object.entries(deltas).map(([pid, delta]) => {
    const name = playerMap[pid] || pid;
    const cls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
    const sign = delta > 0 ? '+' : '';
    return `<div class="delta-item ${cls}">${name}: ${sign}${delta} pts</div>`;
  }).join('');
}

// ── Challenge timer bar ───────────────────────────────────────────────────
function startChallengeTimer(durationS) {
  const bar = el('ch-timer-bar');
  if (!bar) return;
  bar.style.transition = 'none';
  bar.style.width = '100%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.transition = `width ${durationS}s linear`;
      bar.style.width = '0%';
    });
  });
}

// ── Countdown for public reveal ───────────────────────────────────────────
function runCountdown(seconds, onDone) {
  let t = seconds;
  setText('rv-countdown', t);
  const iv = setInterval(() => {
    t--;
    setText('rv-countdown', t);
    if (t <= 0) { clearInterval(iv); onDone?.(); }
  }, 1000);
}

// ── Socket events ─────────────────────────────────────────────────────────

// Create room on load
window.addEventListener('load', () => {
  show('screen-splash');
});

el('btn-create-room').addEventListener('click', () => {
  socket.emit('host:createRoom', {}, ({ roomCode, joinUrl }) => {
    setText('room-code-display', roomCode);
    setText('join-url-display', new URL(joinUrl).host + '/join');
    renderQR(joinUrl);
    show('screen-lobby');
  });
});

el('btn-start').addEventListener('click', () => {
  socket.emit('host:start');
});

el('btn-play-again')?.addEventListener('click', () => {
  location.reload();
});

socket.on('lobby:update', ({ players }) => {
  renderPlayerList(players);
});

socket.on('round:new', ({ roundNumber, speakerName, tapsPerPlayer, players }) => {
  maxTime = 60;
  setText('rn-round-number', roundNumber);
  setText('rn-speaker-name', speakerName);
  show('screen-round-new');
  renderTapRow(players);
});

socket.on('round:speakerReading', ({ speakerName, tier, durationSeconds }) => {
  setText('sr-speaker-name', speakerName);
  setTierBadge('sr-tier-badge', tier);
  const dur = durationSeconds === 120 ? '2 MINUTES' : '1 MINUTE';
  setText('sr-duration', dur);
  setText('sr-subtitle', 'is reading their topic...');
  show('screen-speaker-reading');
});

socket.on('round:tierChosen', ({ speakerName, tier }) => {
  // Speaker locked in tier, now choosing duration — update the round-new subtitle
  setText('rn-speaker-name', speakerName);
  const tierNames = { common: 'Common', niche: 'Niche', deep_dive: 'Deep Dive' };
  const sub = document.querySelector('#screen-round-new .subtitle');
  if (sub) sub.textContent = `chose ${tierNames[tier] || tier} — picking duration...`;
});

socket.on('round:publicReveal', ({ topic, tier, speakerName, countdown }) => {
  el('rv-topic').textContent = topic;
  setTierBadge('rv-tier-badge', tier);
  setText('rv-speaker-name', speakerName);
  show('screen-reveal');
  runCountdown(countdown);
});

socket.on('round:active', ({ timeRemaining }) => {
  maxTime = timeRemaining; // set from server (60 or 120)
  setText('ac-timer', timeRemaining);
  updateRing(timeRemaining);
  const topic = el('rv-topic')?.textContent;
  el('ac-topic').textContent = topic;
  const tier = el('rv-tier-badge')?.className.replace('tier-badge-large ', '');
  setTierBadgeSmall('ac-tier-badge', tier);
  setText('ac-speaker-name', el('rv-speaker-name')?.textContent);
  // Reset hot zone
  const hzo = el('hot-zone-overlay'); if (hzo) hzo.style.display = 'none';
  el('screen-active')?.classList.remove('hot-zone');
  // Reset suspicion needle to center
  const needle = el('suspicion-needle'); if (needle) needle.style.left = '50%';
  // Reset prediction count
  const pc = el('pred-count-tv'); if (pc) pc.style.display = 'none';
  show('screen-active');
});

socket.on('round:tick', ({ timeRemaining }) => {
  setText('ac-timer', timeRemaining);
  updateRing(timeRemaining);
});

socket.on('round:hotZone', () => {
  SoundEngine.hotZone();
  const hzo = el('hot-zone-overlay');
  if (hzo) hzo.style.display = 'block';
  el('screen-active')?.classList.add('hot-zone');
});

socket.on('room:suspicion', ({ avg }) => {
  const needle = el('suspicion-needle');
  if (needle) needle.style.left = `${avg}%`;
});

socket.on('prediction:count', ({ total, eligible }) => {
  const pc = el('pred-count-tv');
  if (pc) {
    pc.style.display = 'block';
    pc.textContent = `🔮 ${total}/${eligible} predicted`;
  }
});

socket.on('challenge:start', ({ challengerName, timeLimit, inHotZone }) => {
  SoundEngine.challenge();
  setText('ch-challenger', challengerName);
  updateVoteBar(0, 0);
  setText('ch-vote-count', 'Waiting for votes...');
  startChallengeTimer(timeLimit);
  show('screen-challenge');
});

socket.on('challenge:voteUpdate', ({ total, eligible }) => {
  setText('ch-vote-count', `${total} of ${eligible} voted`);
});

socket.on('challenge:result', ({ challengeSucceeds, deltas, players, fakeVotes, realVotes, inHotZone }) => {
  if (challengeSucceeds) SoundEngine.fakeVerdict(); else SoundEngine.realVerdict();
  updateVoteBar(realVotes, fakeVotes);
  const verdict = el('cr-verdict');
  verdict.textContent = challengeSucceeds ? '🚨 BUSTED!' : '✅ SURVIVED!';
  verdict.className = `verdict ${challengeSucceeds ? 'busted' : 'survived'}`;
  const detail = challengeSucceeds
    ? (inHotZone ? '🔥 HOT ZONE bust! Extra points!' : 'The jury smelled a lie!')
    : (inHotZone ? '💎 Ice cold under pressure!' : 'The speaker held their ground!');
  setText('cr-detail', detail);
  el('cr-deltas').innerHTML = renderDeltas(deltas, players);
  show('screen-challenge-result');
});

socket.on('round:resumed', ({ timeRemaining }) => {
  setText('ac-timer', timeRemaining);
  updateRing(timeRemaining);
  show('screen-active');
});

socket.on('round:end', ({ pointDeltas, leaderboard, speakerName, players }) => {
  el('re-deltas').innerHTML = renderDeltas(pointDeltas, players || leaderboard);
  show('screen-round-end');
});

socket.on('leaderboard:show', ({ leaderboard }) => {
  renderLeaderboard(leaderboard);
  show('screen-leaderboard');
});

socket.on('game:end', ({ winner, leaderboard, stats, badges }) => {
  SoundEngine.winner();
  setText('ge-winner', winner.name);
  el('ge-stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-card-label">Winner Score</div>
      <div class="stat-card-value">${winner.score}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Rounds Played</div>
      <div class="stat-card-value">${stats.roundsPlayed}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Most BS Calls</div>
      <div class="stat-card-value">${stats.mostBsCalls?.name || '—'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-label">Players</div>
      <div class="stat-card-value">${leaderboard.length}</div>
    </div>
  `;
  // Badges
  const badgesEl = el('ge-badges');
  if (badgesEl && badges?.length) {
    badgesEl.innerHTML = badges.map((b, i) =>
      `<div class="badge-card" style="animation-delay:${i * 0.1}s">
        <div class="badge-label">${b.label}</div>
        <div class="badge-player">${b.playerName}</div>
        <div class="badge-desc">${b.desc}</div>
      </div>`
    ).join('');
  }
  show('screen-game-end');
});

socket.on('host:disconnected', () => {
  alert('Host disconnected. Please refresh.');
});
