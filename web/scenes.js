// Scenes are sets of effect weights; keys 0-9 pick one and the mixer crossfades to it.
export const EFFECTS = ['jitter', 'fountain', 'palette', 'background', 'camera', 'pump', 'shockwave', 'twist'];

//                 jitter fountain palette bg   camera pump shock twist
const DEFAULTS = [
  ['plain',          [0,    0,    0,    0,    0,    0,    0,    0]],
  ['jitter sparkle', [1,    0,    0.3,  0,    0,    0,    0,    0]],
  ['fountain',       [0,    1,    0,    0.3,  0,    0,    0,    0]],
  ['palette + bg',   [0,    0,    1,    1,    0,    0,    0,    0]],
  ['shockwave',      [0,    0,    0.3,  0.4,  1,    0,    1,    0]],
  ['twist tunnel',   [0,    0,    0.5,  0,    0,    0,    0,    1]],
  ['pump fountain',  [0,    0.7,  0,    0.3,  0,    1,    0,    0]],
  ['all-in',         [0.5,  0.6,  0.7,  0.6,  0.6,  0.5,  0.6,  0.4]],
  ['calm drift',     [0,    0,    0.6,  0.2,  0.4,  0,    0,    0]],
  ['chaos',          [1,    0,    0.5,  0.5,  0.8,  0,    1,    1]],
];

export function defaultScenes() {
  return DEFAULTS.map(([name, w]) => ({ name, w: [...w] }));
}

const validScene = (s) =>
  s && typeof s.name === 'string' && Array.isArray(s.w) && s.w.length === EFFECTS.length &&
  s.w.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1);

/** Parse stored scenes; anything that is not 10 valid scenes gives the defaults. */
export function loadScenes(json) {
  try {
    const s = JSON.parse(json);
    if (Array.isArray(s) && s.length === DEFAULTS.length && s.every(validScene)) return s;
  } catch { /* fall through */ }
  return defaultScenes();
}

export function sceneForKey(key) {
  return /^[0-9]$/.test(key) ? Number(key) : null;
}

/** Crossfades the current weights toward the active scene; a new pick retargets from the current mix. */
export class SceneMixer {
  constructor(scenes) {
    this.scenes = scenes;
    this.active = 0;
    this.current = new Float32Array(EFFECTS.length);
  }

  select(i) {
    this.active = i;
  }

  step(dt, fadeS) {
    const a = fadeS > 0 ? 1 - Math.exp(-dt / fadeS) : 1;
    const target = this.scenes[this.active].w;
    for (let k = 0; k < this.current.length; k++) this.current[k] += a * (target[k] - this.current[k]);
    return this.current;
  }
}

/** Palette hue phase in turns: accumulated, so a weight change never jumps the colour. */
export function advanceHue(hue, wPalette, dt) {
  return (hue + wPalette * 0.1 * dt) % 1;
}

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'password', 'url', 'tel']);

/** Global keys act unless typing in a text field; ignore auto-repeat and Ctrl/Meta/Alt chords. */
export function keyAllowed(e) {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return false;
  return !(t.tagName === 'INPUT' && TEXT_INPUTS.has(t.type));
}
