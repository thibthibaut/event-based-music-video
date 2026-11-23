// Live clock: offset = newest event time - wall time, smoothed so the slide is steady between
// batches. A jump bigger than the window (stream restart, u32 µs wrap at 71.6 min) snaps instead.
export function nextOffset(offset, target, windowS) {
  if (offset === null || Math.abs(target - offset) > windowS) return target;
  return offset + 0.05 * (target - offset);
}
