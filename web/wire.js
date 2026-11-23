// Binary event message from the server: u32 count, then count × { u16 x | p<<15, u16 y, u32 t_us }, LE.
export const EVENT_SIZE = 8;

export function parseEvents(buf) {
  const v = new DataView(buf);
  const count = Math.min(v.getUint32(0, true), Math.floor((buf.byteLength - 4) / EVENT_SIZE));
  const x = new Uint16Array(count);
  const y = new Uint16Array(count);
  const p = new Uint8Array(count);
  const tUs = new Uint32Array(count);
  for (let i = 0, o = 4; i < count; i++, o += EVENT_SIZE) {
    const xp = v.getUint16(o, true);
    x[i] = xp & 0x7fff;
    p[i] = xp >> 15;
    y[i] = v.getUint16(o + 2, true);
    tUs[i] = v.getUint32(o + 4, true);
  }
  return { count, x, y, p, tUs };
}
