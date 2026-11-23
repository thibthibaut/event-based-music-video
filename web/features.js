// Per-frame audio features from an AnalyserNode's byte spectrum: auto-gained bands,
// a beat pulse from bass flux, and a log-spaced spectrum for the history texture.
export const LOG_BINS = 256, LOG_F_LO = 30, LOG_F_HI = 16000;

const BANDS = { bass: [20, 150], mid: [150, 2000], treble: [2000, 12000] };
const GAIN_TAU_S = 3;
// AnalyserNode bytes are dB-scaled (0 = minDecibels). Levels below NOISE_FLOOR (-74 dB with the
// -90..-10 dB range set in audio.js) count as silence, and auto-gain never divides by less than
// GAIN_FLOOR, so hiss in a quiet passage is not lifted to full scale.
const NOISE_FLOOR = 0.2, GAIN_FLOOR = 0.3;
const BEAT_STATS_S = 1, BEAT_K = 1.5, BEAT_MIN_FLUX = 0.02, BEAT_REFRACTORY_S = 0.25, BEAT_TAU_S = 0.15;

/** Half-open analyser bin range for [fLo, fHi) Hz, at least one bin. Floor on both edges so
 *  adjacent bands never share a bin (auto-gain would lift a shared bin to 1). */
export function binRange(fLo, fHi, sampleRate, fftSize) {
  const hz = sampleRate / fftSize, n = fftSize / 2;
  const i0 = Math.min(n - 1, Math.max(0, Math.floor(fLo / hz)));
  const i1 = Math.min(n, Math.max(i0 + 1, Math.floor(fHi / hz)));
  return [i0, i1];
}

function level(bins, [i0, i1]) {
  let s = 0;
  for (let i = i0; i < i1; i++) s += bins[i];
  return Math.max(0, s / (i1 - i0) / 255 - NOISE_FLOOR) / (1 - NOISE_FLOOR);
}

export class Features {
  constructor({ sampleRate, fftSize }) {
    this.ranges = Object.fromEntries(Object.entries(BANDS).map(([k, [lo, hi]]) => [k, binRange(lo, hi, sampleRate, fftSize)]));
    this.logRanges = Array.from({ length: LOG_BINS }, (_, k) => {
      const f = (j) => LOG_F_LO * (LOG_F_HI / LOG_F_LO) ** (j / LOG_BINS);
      return binRange(f(k), f(k + 1), sampleRate, fftSize);
    });
    this.peak = { bass: 0, mid: 0, treble: 0 };
    this.bass = this.mid = this.treble = this.beat = 0;
    this.lastBeatT = -1e9;
    this.lastNow = -Infinity;
    this.prevBass = null; // no flux on the first frame: a track start is not a beat
    this.flux = []; // [t, flux] over the last BEAT_STATS_S
    this.logSpec = new Uint8Array(LOG_BINS);
  }

  /** `now` is sensor seconds, so lastBeatT lines up with event times. */
  update(bins, dt, now) {
    if (now < this.lastNow) { // clock went back (reconnect, wrap, wall→sensor switch)
      this.flux = [];
      this.lastBeatT = -1e9;
    }
    this.lastNow = now;
    const decay = Math.exp(-dt / GAIN_TAU_S);
    let rawBass = 0;
    for (const k of Object.keys(BANDS)) {
      const l = level(bins, this.ranges[k]);
      if (k === 'bass') rawBass = l;
      this.peak[k] = Math.max(l, this.peak[k] * decay);
      this[k] = l / Math.max(this.peak[k], GAIN_FLOOR);
    }

    const flux = this.prevBass === null ? 0 : Math.max(0, rawBass - this.prevBass);
    this.prevBass = rawBass;
    while (this.flux.length && this.flux[0][0] < now - BEAT_STATS_S) this.flux.shift();
    const n = this.flux.length;
    const m = n ? this.flux.reduce((s, [, x]) => s + x, 0) / n : 0;
    const sd = n ? Math.sqrt(this.flux.reduce((s, [, x]) => s + (x - m) ** 2, 0) / n) : 0;
    this.flux.push([now, flux]);
    if (flux > BEAT_MIN_FLUX && flux > m + BEAT_K * sd && now - this.lastBeatT >= BEAT_REFRACTORY_S) {
      this.beat = 1;
      this.lastBeatT = now;
    } else {
      this.beat *= Math.exp(-dt / BEAT_TAU_S);
    }

    for (let k = 0; k < LOG_BINS; k++) {
      const [i0, i1] = this.logRanges[k];
      let mx = 0;
      for (let i = i0; i < i1; i++) if (bins[i] > mx) mx = bins[i];
      this.logSpec[k] = mx;
    }
  }
}
