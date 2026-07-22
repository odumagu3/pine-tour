// Lightweight Web Audio sound engine for Neon Whot!
// Synthesizes all effects at runtime — no binary assets, works offline, CSP-safe.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

const STORAGE_KEY = 'whot_sound_enabled';

export function isSoundEnabled(): boolean {
  // Default ON unless the user explicitly muted.
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

export function setSoundEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  if (enabled) unlockAudio();
}

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  return ctx;
}

// Browsers suspend audio until a user gesture. Call this on first interaction.
export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => {});
  }
}

// Short burst of filtered noise — the physical "flick / snap" of a card.
function playNoiseSnap(opts: {
  duration: number;
  volume: number;
  filterType: BiquadFilterType;
  frequency: number;
  q?: number;
  attack?: number;
  delay?: number;
}): void {
  const c = getCtx();
  if (!c || !master) return;

  const { duration, volume, filterType, frequency, q = 1, attack = 0.002, delay = 0 } = opts;
  const frameCount = Math.floor(c.sampleRate * duration);
  const buffer = c.createBuffer(1, frameCount, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frameCount; i++) {
    // Exponentially decaying white noise
    const decay = Math.pow(1 - i / frameCount, 2.2);
    data[i] = (Math.random() * 2 - 1) * decay;
  }

  const src = c.createBufferSource();
  src.buffer = buffer;

  const filter = c.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = frequency;
  filter.Q.value = q;

  const gain = c.createGain();
  const start = c.currentTime + delay;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  src.connect(filter).connect(gain).connect(master);
  src.start(start);
  src.stop(start + duration);
}

// A whoosh — filtered noise whose band sweeps up then down, like a card
// cutting through the air on its way to the pile.
function playWhoosh(opts: {
  duration: number;
  volume: number;
  startFreq: number;
  peakFreq: number;
  endFreq: number;
}): void {
  const c = getCtx();
  if (!c || !master) return;

  const { duration, volume, startFreq, peakFreq, endFreq } = opts;
  const frameCount = Math.floor(c.sampleRate * duration);
  const buffer = c.createBuffer(1, frameCount, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frameCount; i++) {
    data[i] = Math.random() * 2 - 1; // flat white noise; envelope shaped below
  }

  const src = c.createBufferSource();
  src.buffer = buffer;

  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.4;

  const now = c.currentTime;
  const mid = now + duration * 0.4;
  const end = now + duration;
  filter.frequency.setValueAtTime(startFreq, now);
  filter.frequency.exponentialRampToValueAtTime(peakFreq, mid);
  filter.frequency.exponentialRampToValueAtTime(endFreq, end);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume, now + duration * 0.35); // swell
  gain.gain.exponentialRampToValueAtTime(0.0001, end);              // fade out

  src.connect(filter).connect(gain).connect(master);
  src.start(now);
  src.stop(end);
}

function playTone(opts: {
  freq: number;
  duration: number;
  volume: number;
  type?: OscillatorType;
  delay?: number;
  sweepTo?: number;
}): void {
  const c = getCtx();
  if (!c || !master) return;

  const { freq, duration, volume, type = 'sine', delay = 0, sweepTo } = opts;
  const osc = c.createOscillator();
  const gain = c.createGain();
  const start = c.currentTime + delay;

  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);

  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(gain).connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

// A whoosh as the card flies to the pile, capped by a soft landing snap.
export function playCardSound(): void {
  if (!isSoundEnabled()) return;
  playWhoosh({ duration: 0.34, volume: 0.42, startFreq: 600, peakFreq: 3200, endFreq: 700 });
  // light snap as it lands, delayed until the whoosh has traveled
  playNoiseSnap({ duration: 0.1, volume: 0.28, filterType: 'bandpass', frequency: 1900, q: 0.8, delay: 0.2 });
}

// Softer swoosh for drawing from the market pile.
export function playDrawSound(): void {
  if (!isSoundEnabled()) return;
  playNoiseSnap({ duration: 0.22, volume: 0.28, filterType: 'lowpass', frequency: 1200, attack: 0.04 });
}

// A brighter flourish for special action cards (Pick Two, Whot wild, etc.):
// the same whoosh, capped with a two-note chime.
export function playSpecialSound(): void {
  if (!isSoundEnabled()) return;
  playWhoosh({ duration: 0.34, volume: 0.42, startFreq: 700, peakFreq: 3600, endFreq: 800 });
  playTone({ freq: 660, duration: 0.14, volume: 0.16, type: 'sine', delay: 0.22 });
  playTone({ freq: 990, duration: 0.16, volume: 0.13, type: 'sine', delay: 0.30 });
}

// Ascending arpeggio when a round is won.
export function playWinSound(): void {
  if (!isSoundEnabled()) return;
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((n, i) => {
    playTone({ freq: n, duration: 0.35, volume: 0.18, type: 'triangle', delay: i * 0.1 });
  });
}
