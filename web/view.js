// Camera maths for the flat view (M) and the dolly zoom (P / O).
export const FOV_MIN = 6, FOV_MAX = 110, FOV_STEP = 1.12;
const rad = (deg) => (deg * Math.PI) / 180;

/** Half-height of the now-plane (height 1, width planeAspect) that just fits a screen of screenAspect. */
export function fitHalfHeight(planeAspect, screenAspect) {
  return Math.max(0.5, planeAspect / 2 / screenAspect);
}

/** Camera distance at which a vertical half-extent of halfHeight fills the view. */
export function flatDistance(fovDeg, halfHeight) {
  return halfHeight / Math.tan(rad(fovDeg) / 2);
}

/** New distance to the target after changing fov, so the target keeps its size on screen. */
export function dollyDistance(d, fovDeg, newFovDeg) {
  return (d * Math.tan(rad(fovDeg) / 2)) / Math.tan(rad(newFovDeg) / 2);
}

/** One P (+1) or O (-1) step of field of view, clamped. */
export function nextFov(fovDeg, dir) {
  return Math.min(FOV_MAX, Math.max(FOV_MIN, fovDeg * FOV_STEP ** dir));
}

/** One-pole glide of x toward goal with time constant tau. */
export function approach(x, goal, dt, tau) {
  return x + (goal - x) * (1 - Math.exp(-dt / tau));
}
