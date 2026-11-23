import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Features, binRange, LOG_BINS } from '../features.js';

const SR = 48000, N = 2048, DT = 1 / 60;

/** Analyser-like bins with `level` in [fLo, fHi) Hz. */
function spectrum(ranges) {
  const b = new Uint8Array(N / 2);
  for (const [fLo, fHi, level] of ranges) {
    const [i0, i1] = binRange(fLo, fHi, SR, N);
    b.fill(level, i0, i1);
  }
  return b;
}

function run(f, frames, bins, t0 = 0) {
  let t = t0;
  for (let i = 0; i < frames; i++) { t += DT; f.update(typeof bins === 'function' ? bins(t) : bins, DT, t); }
  return t;
}

/** Count rising edges to beat === 1. */
function countBeats(f, frames, binsAt) {
  let n = 0, prevT = f.lastBeatT, t = 0;
  for (let i = 0; i < frames; i++) {
    t += DT;
    f.update(binsAt(t), DT, t);
    if (f.lastBeatT !== prevT) { n++; prevT = f.lastBeatT; }
  }
  return n;
}

const kick = (period) => (t) => spectrum([[20, 150, (t % period) < 3 * DT ? 220 : 20]]);

test('bass_only_spectrum_reads_bass', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  run(f, 30, spectrum([[20, 150, 200]]));
  assert.ok(f.bass > 0.9, `bass ${f.bass}`);
  assert.ok(f.mid < 0.05 && f.treble < 0.05, `mid ${f.mid} treble ${f.treble}`);
});

test('silence_stays_zero', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  run(f, 120, new Uint8Array(N / 2));
  for (const k of ['bass', 'mid', 'treble', 'beat']) {
    assert.ok(Number.isFinite(f[k]), k);
    assert.equal(f[k], 0, k);
  }
});

test('auto_gain_follows_quieter_track', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  const t = run(f, 120, spectrum([[20, 150, 200]]));
  run(f, 600, spectrum([[20, 150, 50]]), t);
  assert.ok(f.bass > 0.8, `bass ${f.bass}`);
});

test('beats_on_kick_train', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  const n = countBeats(f, 240, kick(0.5));
  assert.ok(n >= 7 && n <= 8, `beats ${n}`);
});

test('no_beats_on_constant_level', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  assert.equal(countBeats(f, 240, () => spectrum([[20, 150, 150]])), 0);
});

test('refractory_blocks_double_beats', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  assert.ok(countBeats(f, 120, kick(0.1)) <= 8);
});

test('beat_sets_last_beat_time', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  let t = 0, seen = false;
  for (let i = 0; i < 120; i++) {
    t += DT;
    const before = f.lastBeatT;
    f.update(kick(0.5)(t), DT, t);
    if (f.lastBeatT !== before) { assert.equal(f.lastBeatT, t); assert.equal(f.beat, 1); seen = true; }
  }
  assert.ok(seen);
});

test('log_spectrum_covers_range', () => {
  const f = new Features({ sampleRate: SR, fftSize: N });
  f.update(spectrum([[30, 40, 200]]), DT, 0);
  assert.ok(f.logSpec[0] > 0, 'low edge');
  assert.equal(f.logSpec.length, LOG_BINS);
  f.update(spectrum([[15000, 16000, 200]]), DT, DT);
  assert.ok(f.logSpec[255] > 0, 'high edge');
  assert.equal(f.logSpec[0], 0);
});
