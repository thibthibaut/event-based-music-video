import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvents } from '../wire.js';

test('parses layout and polarity bit (same bytes as Rust encode test)', () => {
  const buf = new ArrayBuffer(4 + 2 * 8);
  const v = new DataView(buf);
  v.setUint32(0, 2, true);
  v.setUint16(4, 1279 | 0x8000, true);
  v.setUint16(6, 719, true);
  v.setUint32(8, 123, true);
  v.setUint16(12, 3, true);
  v.setUint16(14, 4, true);
  v.setUint32(16, 200, true);
  const ev = parseEvents(buf);
  assert.equal(ev.count, 2);
  assert.deepEqual([...ev.x], [1279, 3]);
  assert.deepEqual([...ev.y], [719, 4]);
  assert.deepEqual([...ev.p], [1, 0]);
  assert.deepEqual([...ev.tUs], [123, 200]);
});

test('truncated message keeps only whole events', () => {
  const buf = new ArrayBuffer(4 + 8 + 3);
  new DataView(buf).setUint32(0, 5, true);
  assert.equal(parseEvents(buf).count, 1);
});
