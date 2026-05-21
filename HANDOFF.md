# LieQ — Project Handoff Document
*Last updated: May 2026 · Version: post-feature-sprint · Repo: `joncorral-Hills/lieq`*

---

## 1. What Is LieQ?

LieQ is a **real-time digital party game** played on one shared TV screen + players' own smartphones. No app download is required — players join via QR code or a short URL.

**The core loop:** One player is the Speaker. They receive a topic privately, then explain it to the room for 60 or 120 seconds. The jury decides if the speaker actually knows what they're talking about — or is completely bluffing. Anyone can interrupt mid-speech with a **BS! challenge**. If the jury agrees it's fake, the challenger earns points. If the speaker survives, they score.

**Format:** Kahoot-style infrastructure (one host TV + phones) with Bluff-Your-Way-In social dynamics.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────┐
│              Node.js Server                 │
│  Express (static files) + Socket.IO         │
│                                             │
│  ┌─────────────┐   ┌──────────────────┐    │
│  │ roomManager │   │   gameEngine.js  │    │
│  │ (in-memory) │   │ (pure state FSM) │    │
│  └─────────────┘   └──────────────────┘    │
│         ↕                   ↕              │
│         └──── index.js (orchestrator) ─────┘
│                      ↕
│           Socket.IO event bus
└─────────────────┬──────────────┬────────────┘
                  │              │
         ┌────────┘              └─────────┐
         ▼                                ▼
   TV Browser                      Phone Browsers
   /tv/index.html                  /phone/index.html
   tv.js + tv.css                  phone.js + phone.css
   (display only)                  (interactive)
         │                                │
         └────── /shared/sounds.js ───────┘
                 (Web Audio engine)
```

**Key design principles:**
- `gameEngine.js` is **pure logic** — no I/O, no sockets, no timers. It only mutates the game state object and returns event payloads.
- `index.js` owns all Socket.IO wiring, timers, and side effects.
- The TV screen is **display-only**; it never directly drives game state — the host buttons (`host:start`, `host:createRoom`) are the only TV→server calls.
- Rooms are stored **in memory** with auto-expiry (no database).

---

## 3. File Structure

```
lieq/
├── server/
│   ├── index.js              # Socket.IO orchestrator, all event wiring, timers
│   ├── gameEngine.js         # Pure game state machine — no side effects
│   ├── roomManager.js        # In-memory room store with auto-expiry
│   └── topics/
│       ├── topics.json       # 314 topics across 3 tiers
│       └── topicService.js   # Random topic picker, deduplication
│
├── public/
│   ├── tv/
│   │   ├── index.html        # TV screen markup (10 screen divs)
│   │   ├── tv.js             # TV socket client + all rendering
│   │   └── tv.css            # TV styles
│   ├── phone/
│   │   ├── index.html        # Phone client markup (12 screen divs)
│   │   ├── phone.js          # Phone socket client + all interaction
│   │   └── phone.css         # Phone styles
│   └── shared/
│       └── sounds.js         # Web Audio API sound engine (SoundEngine)
│
├── package.json
├── .env.example
├── sellsheet.html            # Licensing one-pager (standalone HTML)
└── .gitignore
```

---

## 4. Game State Machine

The game progresses through these states in order. Each state is a string constant in `STATES` (exported from `gameEngine.js`).

```
LOBBY
  └─→ TIER_SELECT          (host starts game, speaker picks Common/Niche/Deep Dive)
        └─→ DURATION_SELECT (speaker picks 60s or 120s)
              └─→ SPEAKER_PRIVATE   (speaker sees topic privately for 5s)
                    └─→ PUBLIC_REVEAL     (topic shown to all for 3s)
                          └─→ ROUND_ACTIVE     (timer running)
                                ├─→ BS_CHALLENGE    (if player taps BS)
                                │     └─→ CHALLENGE_RESULT → ROUND_ACTIVE (if fails)
                                │                           → ROUND_END    (if succeeds)
                                └─→ ROUND_END         (timer hits 0)
                                      └─→ LEADERBOARD
                                            └─→ TIER_SELECT (next round)
                                                  └─→ GAME_END (after maxRounds)
```

**State is stored on `game.state`** — always a string from `STATES`. The server uses this to gate all incoming player events.

---

## 5. Scoring System

All constants live in `SCORING` in `gameEngine.js`:

| Event | Points |
|---|---|
| Speaker survives full round | `BASE × TIER_MULT` |
| Challenger succeeds (BS correct) | `BASE × TIER_MULT` |
| Voter who sided with majority | `+25` |
| Challenger fails (BS wrong) | `-50` |
| Speaker survives failed BS | `+25` |
| Correct pre-round prediction | `+15` |
| Any BS event in Hot Zone (last 10s) | All above × 1.5 |

**Tier multipliers:** Common ×1 · Niche ×2 · Deep Dive ×3

Scores never go below 0 (`Math.max(0, score + delta)`).

---

## 6. Feature Reference — The 5 Major Features

### 6.1 Secret Pre-Round Prediction
- **When:** Triggered on `round:active`. An overlay appears on jury phones for **8 seconds**.
- **Phone:** Shows REAL/FAKE buttons + animated timer bar. Skip button available.
- **Server:** `player:prediction` socket event → `engine.submitPrediction()`. Stores in `game.currentRound.predictions`.
- **Scoring:** `resolvePredictions()` called at round end (natural or BS). Correct predictors get +15 pts. Results sent in `round:end` and `challenge:result` payloads as `predictionResults`.
- **TV:** Shows `🔮 X/Y predicted` count badge as predictions come in.

### 6.2 Sound Design
- **File:** `public/shared/sounds.js` — loaded on both TV and phone.
- **API:** `SoundEngine.bs()`, `.challenge()`, `.fakeVerdict()`, `.realVerdict()`, `.tick()`, `.hotZone()`, `.prediction()`, `.winner()`
- **Implementation:** Web Audio API only — no files, no network requests, zero latency. All sounds are procedurally synthesized using oscillators.
- **AudioContext:** Created lazily on first call; resumed if suspended (required by browser autoplay policy — first user interaction must precede sound).

### 6.3 Final 10-Second Hot Zone
- **Server:** When `timeRemaining` hits `SCORING.HOT_ZONE_THRESHOLD` (10), `engine.enterHotZone()` is called and `round:hotZone` is emitted.
- **Scoring:** `ch.inHotZone` flag on the challenge object — `resolveChallenge()` applies `HOT_ZONE_MULT` (1.5) to all payouts AND penalties.
- **TV:** `🔥 HOT ZONE ×1.5` banner appears, screen gets orange glow.
- **Phone:** BS button turns orange, `hot-zone-label` appears.

### 6.4 Suspicion Meter
- **Phone:** Two tap zones on jury-active screen (`👍 Believin' it` / `🤔 Something's off`). Tapping emits `player:suspicion` with value 0 or 100.
- **Server:** `suspicionMap[roomCode][socketId]` stores each player's value. Averages all values and emits `room:suspicion { avg }` to the TV immediately on each tap.
- **TV:** Gold needle on a horizontal track moves based on `avg`. Pure display — no gameplay impact.
- **Cleanup:** `suspicionMap[roomCode]` deleted on round end.

### 6.5 Personality Badges
- **Calculated:** `calculateBadges(game)` in `gameEngine.js` at `endGame()`.
- **Stats tracked per player:** `bsCallsAttempted`, `successfulBsCalls`, `predictionsCorrect`, `survivedUnderPressure`, `roundsSpoken`
- **Six badges:**

| Badge | Label | Condition |
|---|---|---|
| `most_convincing` | 🎭 Most Convincing | Spoke ≥1 round, zero successful BS calls against them |
| `trigger_happy` | 🚨 Trigger Happy | Most BS taps attempted |
| `oracle` | 🧠 The Oracle | Most correct predictions |
| `sharpshooter` | 🎯 Sharpshooter | Best BS success rate (min 2 attempts) |
| `ice_cold` | 💎 Ice Cold | Survived a BS call with ≤15s remaining |
| `overconfident` | 😬 Overconfident | Most failed BS calls |

- **Payload:** `badges[]` array on `game:end`. Each item: `{ playerId, playerName, badge, label, desc }`.
- **TV:** Badge cards rendered with staggered animation. **Phone:** Each player sees their own badge on the game-end screen.

---

## 7. Socket Event Protocol

### Server → All Clients (`emitToRoom`)
| Event | Payload | When |
|---|---|---|
| `lobby:update` | `{ players[] }` | Player joins/leaves |
| `round:new` | `{ roundNumber, speakerId, speakerName, tapsPerPlayer, players[] }` | Round begins |
| `round:publicReveal` | `{ topic, tier, speakerName, countdown }` | Topic revealed to all |
| `round:active` | `{ timeRemaining }` | Speaking begins |
| `round:tick` | `{ timeRemaining }` | Every second |
| `round:hotZone` | `{ timeRemaining }` | When ≤10s remain |
| `round:resumed` | `{ timeRemaining }` | After failed BS |
| `round:end` | `{ speakerId, pointDeltas, predictionResults, leaderboard, players[], endedByChallenge? }` | Round over |
| `challenge:start` | `{ challengerName, timeLimit }` | BS tapped |
| `challenge:voteUpdate` | `{ total, eligible }` | Vote count update |
| `challenge:result` | `{ challengeSucceeds, deltas, fakeVotes, realVotes, inHotZone, predictionResults, leaderboard, players[] }` | Vote resolved |
| `leaderboard:show` | `{ leaderboard[] }` | Post-round leaderboard |
| `game:end` | `{ winner, leaderboard[], stats, badges[] }` | Game over |

### Server → TV Only (`emitToTV`)
| Event | Payload |
|---|---|
| `round:tierChosen` | `{ speakerName, tier }` — subtitle update while picking duration |
| `round:speakerReading` | `{ speakerName, tier, durationSeconds }` — speaker reading screen |
| `prediction:count` | `{ total, eligible }` |
| `room:suspicion` | `{ avg, count }` |

### Server → Individual Phone
| Event | Payload |
|---|---|
| `speaker:selectTier` | `{}` |
| `speaker:selectDuration` | `{ tier }` |
| `speaker:topic` | `{ topic, tier, durationSeconds }` |
| `jury:waiting` | `{ speakerName }` |
| `challenge:votePrompt` | `{ challengerName, speakerName, timeLimit }` |
| `player:kicked` | `{}` |

### Phone → Server
| Event | Payload |
|---|---|
| `player:join` | `{ roomCode, name }` → cb `{ ok, playerId, name }` |
| `player:bs` | `{}` |
| `player:vote` | `{ vote: 'real'|'fake' }` |
| `player:prediction` | `{ prediction: 'real'|'fake' }` |
| `player:suspicion` | `{ value: 0–100 }` |

### TV → Server
| Event | Payload |
|---|---|
| `host:createRoom` | `{}` → cb `{ roomCode, joinUrl }` |
| `host:start` | `{}` |
| `speaker:tierSelect` | `{ tier }` |
| `speaker:durationSelect` | `{ seconds: 60|120 }` |

---

## 8. Room & Session Management

- **`roomManager.js`** maintains an in-memory `Map` of `roomCode → { game, hostSocketId, createdAt }`.
- Room codes are 4 uppercase letters, randomly generated.
- Rooms auto-expire after **2 hours** (configurable in `roomManager.js`).
- If the host disconnects, `host:disconnected` is emitted to all players in the room.
- Players who disconnect mid-game are removed from the speaker rotation but their score persists until room expiry.
- **No persistence** — a server restart wipes all rooms.

---

## 9. Topic System

- **314 base topics** in `server/topics/topics.json`.
- Three tiers: `common` (141 topics) · `niche` (~100) · `deep_dive` (~73).
- `topicService.js` `getRandomTopic(tier, usedIds)` picks randomly, excluding already-used IDs for the session.
- Topics are tracked in `game.usedTopicIds[]` and reset only on room expiry (not between rounds).
- **Adding topics:** Edit `topics.json` — each entry needs `{ "id": "uniqueId", "text": "Topic text", "tier": "common|niche|deep_dive" }`.

---

## 10. Setup & Running Locally

### Prerequisites
- Node.js ≥18 (via nvm recommended)
- All phones and TV must be on the **same Wi-Fi network**

### Install & Run
```bash
cd /Users/JonCorral/Documents/PACE/lieq
npm install
npm start             # production
npm run dev           # with nodemon hot-reload
```

### Environment
Copy `.env.example` → `.env`. Currently no required variables — the file is reserved for future API keys (e.g. topic CMS, analytics).

### Access
```
TV Screen:   http://localhost:3000/tv
Phone Join:  http://<LAN-IP>:3000/join
             (LAN IP auto-detected and logged on startup)
```

### macOS Menu Bar Launcher
A `.command` launch script lives at:
```
~/.local/share/antigravity/launch-lieq.command
```
This script kills any process on port 3000, then starts the server using nvm-managed Node. The **🎮 LieQ** entry in the menubar app (`menubar_app.py`) calls this script.

---

## 11. Deployment Notes

- The server currently serves static files directly from `public/` via Express.
- For production, consider:
  - Moving static assets to a CDN
  - Adding SSL (required for Web Audio on iOS in some network configs)
  - Using PM2 or a process manager for uptime
  - Deploying to a Cloud Run instance (see the `cloudrun` MCP tool)
- The QR code URL is auto-detected from the server's LAN IP — this must be updated if deploying to a public host (set `BASE_URL` in `.env`).

---

## 12. Known Limitations & Technical Debt

| Issue | Severity | Notes |
|---|---|---|
| In-memory rooms | Medium | Server restart = all rooms lost. Fine for local/event use. |
| No topic deduplication within a tier across multiple games | Low | `usedTopicIds` resets on new room, not between sessions |
| `c111` duplicates `c079` ("What a mutual fund is") in topics.json | Low | Harmless but should be cleaned |
| Web Audio autoplay policy | Low | SoundEngine requires at least one user interaction before first sound. TV "Create Room" click satisfies this. |
| No moderation on player names | Medium | Names are sliced to 20 chars but not sanitized against profanity |
| Speaker socket disconnect mid-round | Medium | Round timer continues. No auto-skip implemented yet. |
| BS cooldown is server-side time-based | Low | A player who disconnects and reconnects gets a fresh tap count |

---

## 13. Roadmap — Next Build Priorities

### Tier 1 (Highest Impact)
- [ ] **Reconnect resilience** — rejoin a room mid-game with same playerId
- [ ] **Host controls panel** — skip round, kick player, extend timer (+30s button)
- [ ] **Sound toggle** — mute button on TV and phone

### Tier 2 (Gameplay Depth)
- [ ] **Custom topic packs** — host uploads a CSV of topics at room creation
- [ ] **Team mode** — 2 teams, shared speaker rotation, team leaderboard
- [ ] **Audience mode** — observers can follow on TV without playing (scannable join link)

### Tier 3 (Monetization Ready)
- [ ] **Pack system** — lock certain topic tiers behind a room access code
- [ ] **Analytics dashboard** — round duration, BS success rate, most-bluffed topics
- [ ] **Dynamic topic library** — pull from a Google Sheet or CMS instead of static JSON

---

## 14. Repository

**GitHub:** `https://github.com/joncorral-Hills/lieq`
**Branch:** `main`
**Last commit:** `feat: add 5 game design features — predictions, sounds, hot zone, suspicion meter, badges`

```bash
git clone https://github.com/joncorral-Hills/lieq.git
cd lieq && npm install && npm start
```

---

## 15. Key Files Quick Reference

| File | What to touch it for |
|---|---|
| [`server/gameEngine.js`](file:///Users/JonCorral/Documents/PACE/lieq/server/gameEngine.js) | Scoring tweaks, new game mechanics, badge logic |
| [`server/index.js`](file:///Users/JonCorral/Documents/PACE/lieq/server/index.js) | New socket events, timer adjustments, room lifecycle |
| [`server/topics/topics.json`](file:///Users/JonCorral/Documents/PACE/lieq/server/topics/topics.json) | Adding/editing topics |
| [`public/shared/sounds.js`](file:///Users/JonCorral/Documents/PACE/lieq/public/shared/sounds.js) | New sound effects |
| [`public/tv/tv.js`](file:///Users/JonCorral/Documents/PACE/lieq/public/tv/tv.js) | TV rendering, new TV event handlers |
| [`public/phone/phone.js`](file:///Users/JonCorral/Documents/PACE/lieq/public/phone/phone.js) | Phone interaction, new phone event handlers |
| [`sellsheet.html`](file:///Users/JonCorral/Documents/PACE/lieq/sellsheet.html) | Licensing one-pager (open in browser, print to PDF) |
