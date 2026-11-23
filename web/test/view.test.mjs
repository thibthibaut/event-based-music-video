import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitHalfHeight, flatDistance, dollyDistance, nextFov, FOV_MIN, FOV_MAX, approach } from '../view.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('fit_uses_the_tighter_axis', () => {
  close(fitHalfHeight(16 / 9, 16 / 9), 0.5);          // same aspect: height fits
  close(fitHalfHeight(16 / 9, 1.6), (16 / 9) / 2 / 1.6); // narrower screen: width limits
  close(fitHalfHeight(4 / 3, 16 / 9), 0.5);            // wider screen: height limits
});

test('flat_distance_fills_the_view', () => {
  // at that distance the vertical half-extent seen is exactly halfHeight
  const d = flatDistance(40, 0.5);
  close(d * Math.tan((40 / 2) * Math.PI / 180), 0.5);
});

test('dolly_keeps_target_size', () => {
  const d2 = dollyDistance(2, 40, 80);
  close(d2 * Math.tan(40 * Math.PI / 180), 2 * Math.tan(20 * Math.PI / 180));
  assert.ok(d2 < 2, 'wider fov moves closer');
});

test('next_fov_steps_and_clamps', () => {
  assert.ok(nextFov(40, +1) > 40);
  assert.ok(nextFov(40, -1) < 40);
  assert.equal(nextFov(FOV_MAX, +1), FOV_MAX);
  assert.equal(nextFov(FOV_MIN, -1), FOV_MIN);
});

test('approach_is_smooth_and_converges', () => {
  let x = 0;
  const a1 = approach(x, 1, 1 / 60, 0.25);
  assert.ok(a1 > 0 && a1 < 0.1);
  for (let i = 0; i < 120; i++) x = approach(x, 1, 1 / 60, 0.25);
  close(x, 1, 1e-3);
});
