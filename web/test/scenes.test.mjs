import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTS, defaultScenes, loadScenes, sceneForKey, SceneMixer } from '../scenes.js';

const DT = 1 / 60, FADE = 0.4;

test('default_scenes_shape', () => {
  const s = defaultScenes();
  assert.equal(s.length, 10);
  assert.ok(s[0].w.every((x) => x === 0));
  for (const sc of s) {
    assert.equal(sc.w.length, EFFECTS.length);
    assert.ok(sc.w.every((x) => x >= 0 && x <= 1), sc.name);
  }
});

test('key_mapping', () => {
  assert.equal(sceneForKey('3'), 3);
  assert.equal(sceneForKey('0'), 0);
  assert.equal(sceneForKey('a'), null);
  assert.equal(sceneForKey(' '), null);
});

test('fade_converges_monotonically', () => {
  const m = new SceneMixer(defaultScenes());
  m.select(2);
  const target = defaultScenes()[2].w;
  let prev = Array.from(m.current);
  for (let i = 0; i < 120; i++) { // 2 s = 5 τ
    const cur = Array.from(m.step(DT, FADE));
    cur.forEach((x, k) => assert.ok(Math.abs(target[k] - x) <= Math.abs(target[k] - prev[k]) + 1e-6));
    prev = cur;
  }
  prev.forEach((x, k) => assert.ok(Math.abs(target[k] - x) < 0.02, `w${k} ${x} vs ${target[k]}`));
});

test('retarget_mid_fade_is_continuous', () => {
  const scenes = defaultScenes();
  const m = new SceneMixer(scenes);
  m.select(2);
  for (let i = 0; i < 10; i++) m.step(DT, FADE);
  const before = Array.from(m.current);
  m.select(5);
  const after = Array.from(m.step(DT, FADE));
  const a = 1 - Math.exp(-DT / FADE);
  after.forEach((x, k) => assert.ok(Math.abs(x - before[k]) <= a * Math.abs(scenes[5].w[k] - before[k]) + 1e-6));
});

test('zero_fade_snaps_safely', () => {
  const m = new SceneMixer(defaultScenes());
  m.select(7);
  const w = Array.from(m.step(DT, 0));
  assert.deepEqual(w.map((x) => Math.round(x * 1e6) / 1e6), defaultScenes()[7].w.map((x) => Math.round(x * 1e6) / 1e6));
  assert.ok(w.every(Number.isFinite));
});

test('load_rejects_bad_shapes', () => {
  const d = JSON.stringify(defaultScenes());
  for (const bad of [null, 'nope', '[]', '{}']) assert.deepEqual(loadScenes(bad), defaultScenes(), String(bad));
  const short = defaultScenes(); short[3].w = short[3].w.slice(0, 7);
  assert.deepEqual(loadScenes(JSON.stringify(short)), defaultScenes());
  const str = defaultScenes(); str[4].w[0] = 'x';
  assert.deepEqual(loadScenes(JSON.stringify(str)), defaultScenes());
  const big = defaultScenes(); big[4].w[0] = 2;
  assert.deepEqual(loadScenes(JSON.stringify(big)), defaultScenes());
  const ok = JSON.parse(d); ok[1].w[0] = 0.42;
  assert.equal(loadScenes(JSON.stringify(ok))[1].w[0], 0.42);
});
