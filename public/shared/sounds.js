// public/shared/sounds.js — Web Audio API sound engine for LieQ
const SoundEngine = (() => {
  let ctx = null;
  let enabled = true;

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, type, dur, vol, freqEnd) {
    if (!enabled) return;
    const c = getCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.connect(g); g.connect(c.destination);
    osc.type = type; osc.frequency.value = freq;
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, c.currentTime + dur);
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    osc.start(c.currentTime); osc.stop(c.currentTime + dur);
  }

  function chord(freqs, type, dur, vol, delay = 0) {
    freqs.forEach((f, i) => {
      setTimeout(() => tone(f, type, dur, vol), i * delay * 1000);
    });
  }

  return {
    enable() { enabled = true; },
    disable() { enabled = false; },

    bs() {
      // Low buzzer
      const c = getCtx(); if (!enabled) return;
      const osc = c.createOscillator(); const g = c.createGain();
      osc.connect(g); g.connect(c.destination);
      osc.type = 'sawtooth'; osc.frequency.value = 120;
      osc.frequency.exponentialRampToValueAtTime(55, c.currentTime + 0.45);
      g.gain.setValueAtTime(0.7, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.45);
      osc.start(); osc.stop(c.currentTime + 0.45);
    },

    challenge() {
      // Three rising stabs
      if (!enabled) return;
      [0, 0.12, 0.24].forEach((delay, i) => {
        setTimeout(() => tone(280 + i * 130, 'square', 0.18, 0.4), delay * 1000);
      });
    },

    fakeVerdict() {
      // Descending whomp
      tone(440, 'sawtooth', 0.8, 0.5, 110);
      setTimeout(() => tone(200, 'sawtooth', 0.4, 0.3, 80), 300);
    },

    realVerdict() {
      // Ascending chord pop
      chord([261, 329, 392, 523], 'triangle', 0.5, 0.35, 0.06);
    },

    tick() {
      // Short click for countdown
      tone(880, 'square', 0.06, 0.2);
    },

    hotZone() {
      // Alert pulse
      chord([440, 440], 'square', 0.15, 0.35, 0.15);
    },

    prediction() {
      // Soft chime prompt
      tone(660, 'sine', 0.3, 0.25);
      setTimeout(() => tone(880, 'sine', 0.3, 0.2), 150);
    },

    predictionReveal() {
      // Quick shimmer
      chord([523, 659, 784], 'sine', 0.4, 0.2, 0.04);
    },

    winner() {
      // Fanfare
      const notes = [261, 329, 392, 523, 659, 784];
      notes.forEach((f, i) => setTimeout(() => tone(f, 'triangle', 0.35, 0.4), i * 80));
      setTimeout(() => chord([523, 659, 784], 'triangle', 1.0, 0.3), notes.length * 80);
    },
  };
})();
