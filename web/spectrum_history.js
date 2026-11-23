// Ring of log spectra over time, as a texture: x = log frequency bin, y = time row.
// Rows are keyed on sensor time so the shader can look up the spectrum at each event's birth.
import { LOG_BINS } from './features.js';

export const ROWS = 128, ROW_S = 2 / ROWS; // covers the 2 s max window

const absRow = (t) => Math.floor(t / ROW_S);
const ring = (n) => ((n % ROWS) + ROWS) % ROWS;

export function rowOf(t) {
  return ring(absRow(t));
}

/** Ring rows for absolute rows (lastAbs, nowAbs]; capped at one full ring. */
export function rowsToFill(lastAbs, nowAbs) {
  if (lastAbs === null) return [ring(nowAbs)];
  const first = Math.max(lastAbs + 1, nowAbs - ROWS + 1);
  const rows = [];
  for (let n = first; n <= nowAbs; n++) rows.push(ring(n));
  return rows;
}

export class SpectrumHistory {
  /** Takes THREE as an argument so the module loads in node tests without three. */
  constructor(THREE) {
    this.texture = new THREE.DataTexture(new Uint8Array(LOG_BINS * ROWS), LOG_BINS, ROWS, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.needsUpdate = true;
    this.lastAbs = null;
  }

  write(nowS, logSpec) {
    const nowAbs = absRow(nowS);
    if (this.lastAbs !== null && nowAbs < this.lastAbs) this.lastAbs = null; // clock went back (wrap, new stream)
    const rows = rowsToFill(this.lastAbs, nowAbs);
    if (!rows.length) return;
    const data = this.texture.image.data;
    for (const r of rows) {
      data.set(logSpec, r * LOG_BINS);
      this.texture.addUpdateRange(r * LOG_BINS, LOG_BINS);
    }
    this.lastAbs = nowAbs;
    this.texture.needsUpdate = true;
  }

  reset() {
    this.texture.image.data.fill(0);
    this.texture.needsUpdate = true;
    this.lastAbs = null;
  }
}
