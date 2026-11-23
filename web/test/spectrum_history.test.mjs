import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROWS, ROW_S, rowOf, rowsToFill, SpectrumHistory } from '../spectrum_history.js';

test('row_of_wraps', () => {
  assert.equal(rowOf(0), 0);
  assert.equal(rowOf(ROW_S * 128), 0);
  assert.equal(rowOf(ROW_S * 129.5), 1);
});

test('row_of_negative_time', () => {
  assert.equal(rowOf(-ROW_S * 0.5), 127);
});

test('fill_consecutive', () => {
  assert.deepEqual(rowsToFill(10, 13), [11, 12, 13]);
  assert.deepEqual(rowsToFill(126, 129), [127, 0, 1]);
  assert.deepEqual(rowsToFill(null, 130), [2]);
});

test('fill_caps_at_ring_size', () => {
  assert.equal(rowsToFill(0, 10_000).length, ROWS);
});

test('fill_none_backwards', () => {
  assert.deepEqual(rowsToFill(50, 40), []);
});

/** Just enough of three for the history to run in node. */
const FakeTHREE = {
  RedFormat: 'red', UnsignedByteType: 'ubyte', LinearFilter: 'linear', RepeatWrapping: 'repeat',
  DataTexture: class {
    constructor(data, width, height) { this.image = { data, width, height }; this.ranges = []; }
    addUpdateRange(start, count) { this.ranges.push([start, count]); }
  },
};

test('history_write_marks_rows', () => {
  const h = new SpectrumHistory(FakeTHREE);
  const spec = new Uint8Array(256).fill(7);
  h.write(0, new Uint8Array(256));
  h.write(3 * ROW_S + ROW_S / 2, spec);
  const d = h.texture.image.data;
  for (const r of [1, 2, 3]) assert.equal(d[r * 256 + 5], 7, `row ${r}`);
  assert.equal(d[0 * 256 + 5], 0);
  assert.equal(d[4 * 256 + 5], 0);
  assert.equal(h.texture.needsUpdate, true);
});

test('history_restarts_after_time_goes_back', () => {
  const h = new SpectrumHistory(FakeTHREE);
  h.write(100, new Uint8Array(256));
  h.write(1, new Uint8Array(256).fill(9));
  assert.equal(h.texture.image.data[rowOf(1) * 256], 9);
});
