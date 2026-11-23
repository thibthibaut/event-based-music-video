import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOffset } from '../clock.js';

test('first batch sets the offset', () => {
  assert.equal(nextOffset(null, 12.5, 1), 12.5);
});

test('small jitter is smoothed', () => {
  assert.equal(nextOffset(10, 10.2, 1), 10 + 0.05 * 0.2);
});

test('a jump larger than the window snaps (u32 µs wrap at 71.6 min)', () => {
  assert.equal(nextOffset(4290, 4290 - 4294.967296, 1), 4290 - 4294.967296);
});
