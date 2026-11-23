import * as THREE from 'three';

// Effect weights uW[i] follow scenes.js EFFECTS: 0 jitter, 1 fountain, 2 palette, 3 background (CPU),
// 4 camera (CPU), 5 pump, 6 shockwave, 7 twist.
const vertexShader = /* glsl */ `
  attribute float aT;
  attribute float aP;
  uniform float uNow, uWindow, uDepth, uGamma, uPointSize, uPixelRatio;
  uniform vec2 uSensor;
  uniform float uW[8];
  uniform float uBass, uMid, uTreble, uLastBeatT, uTime;
  uniform sampler2D uSpec;
  varying float vP;
  varying float vLife;

  const float ROW_S = 2.0 / 128.0; // spectrum_history.js

  uint hashU(uint x) {
    x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
    return x;
  }
  float rnd(uint x) { return float(hashU(x)) / 4294967295.0; }

  void main() {
    float age = uNow - aT;
    if (age < 0.0 || age > uWindow) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-clip
      gl_PointSize = 0.0;
      return;
    }
    float u = age / uWindow;
    vec2 c = vec2((position.x / uSensor.x - 0.5) * (uSensor.x / uSensor.y), 0.5 - position.y / uSensor.y);

    // Effects are skipped at weight 0 (uniform branches): ~4 M vertices on an integrated GPU.
    // twist: rotate around the centre, more with age and mids
    if (uW[7] > 0.0) {
      float ang = uW[7] * (0.5 + 2.0 * uMid) * u * 3.14159265;
      c = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * c;
    }

    // shockwave: events born at the last beat burst outward
    if (uW[6] > 0.0) {
      float b = (aT - uLastBeatT) / 0.03;
      c *= 1.0 + uW[6] * 0.5 * exp(-b * b);
    }

    // fountain: lift by the spectrum at this column, at the event's birth time
    if (uW[1] > 0.0) {
      float row = mod(floor(aT / ROW_S), 128.0);
      c.y += uW[1] * 0.8 * texture2D(uSpec, vec2(position.x / uSensor.x, (row + 0.5) / 128.0)).r;
    }

    // time pump: depth breathes with the bass
    float depth = uDepth * (1.0 + uW[5] * 0.6 * uBass);
    vec3 p = vec3(c, -depth * pow(u, uGamma));

    // jitter: per-event random offset, new 30 times a second, bigger with treble
    if (uW[0] > 0.0) {
      uint seed = uint(gl_VertexID) * 3u + uint(floor(uTime * 30.0)) * 0x9E3779B9u;
      vec3 j = vec3(rnd(seed), rnd(seed + 1u), rnd(seed + 2u)) - 0.5;
      p += j * 2.0 * uW[0] * (0.003 + 0.02 * uTreble);
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPointSize * uPixelRatio * (2.0 / max(0.3, -mv.z));
    vP = aP;
    vLife = 1.0 - u;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uOnColor, uOffColor;
  uniform float uK, uIntensity;
  uniform float uW[8];
  uniform float uBeat, uHue;
  varying float vP;
  varying float vLife;

  // Hue rotation: rotate RGB around the grey axis.
  vec3 hueRotate(vec3 col, float turns) {
    float a = turns * 6.2831853;
    vec3 k = vec3(0.57735);
    return col * cos(a) + cross(k, col) * sin(a) + k * dot(k, col) * (1.0 - cos(a));
  }

  void main() {
    float r = length(gl_PointCoord - vec2(0.5));
    if (r > 0.5) discard;
    float core = 1.0 - smoothstep(0.04, 0.28, r);
    float glow = exp(-r * r * 20.0);
    float a = uIntensity * (core + glow * 0.42) * pow(vLife, uK);
    vec3 col = mix(uOffColor, uOnColor, vP);
    // palette: slow hue drift, white flash on beats
    // blend, not gate: fading the weight to 0 returns continuously to the base colours
    if (uW[2] > 0.0) col = mix(col, hueRotate(col, uHue), min(1.0, 3.0 * uW[2]));
    col = mix(col, vec3(1.0), uW[2] * uBeat * 0.6);
    gl_FragColor = vec4(max(col, 0.0) * a, a);
  }
`;

/** GPU ring buffer of events; age is computed in the shader from uNow, so old events are never rewritten. */
export class XytVolume {
  constructor(scene, { capacity }) {
    this.geometry = this.makeGeometry(capacity);

    this.uniforms = {
      uNow: { value: 0 },
      uWindow: { value: 1.0 },
      uDepth: { value: 3.0 },
      uGamma: { value: 1.6 },
      uK: { value: 1.5 },
      uPointSize: { value: 2.0 },
      uIntensity: { value: 0.12 },
      uPixelRatio: { value: window.devicePixelRatio || 1 },
      uSensor: { value: new THREE.Vector2(1280, 720) },
      uOnColor: { value: new THREE.Color('#F5C2E7') },
      uOffColor: { value: new THREE.Color('#89DCEB') },
      // audio features (main.js) and the spectrum history texture
      uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 }, uBeat: { value: 0 },
      uLastBeatT: { value: -1e9 }, uTime: { value: 0 }, uHue: { value: 0 }, uSpec: { value: null },
      uW: { value: new Array(8).fill(0) }, // scene weights, see EFFECTS in scenes.js
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, // premultiplied additive
      blendDst: THREE.OneFactor,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    this.frame = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x585b70, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.frame.frustumCulled = false;
    scene.add(this.frame);
    this.updateFrame();
  }

  makeGeometry(capacity) {
    this.capacity = capacity;
    this.head = 0;
    const g = new THREE.BufferGeometry();
    this.xy = new THREE.Float32BufferAttribute(new Float32Array(capacity * 2), 2);
    this.t = new THREE.Float32BufferAttribute(new Float32Array(capacity).fill(-1e9), 1);
    this.p = new THREE.Float32BufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.xy, this.t, this.p]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.xy);
    g.setAttribute('aT', this.t);
    g.setAttribute('aP', this.p);
    // Fixed sphere: three would compute one for sorting, and the 2-component position gives NaN.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -2), 10);
    return g;
  }

  /** Reallocate the ring (drops what it holds); sized max_rate × max window by the caller. */
  setCapacity(capacity) {
    if (capacity === this.capacity) return;
    this.geometry.dispose();
    this.geometry = this.points.geometry = this.makeGeometry(capacity);
  }

  setSensor(w, h) {
    this.uniforms.uSensor.value.set(w, h);
    this.updateFrame();
  }

  /** Outline of the now-plane, the back plane and their corner edges. */
  updateFrame() {
    const s = this.uniforms.uSensor.value;
    const hw = (s.x / s.y) / 2, hh = 0.5, d = -this.uniforms.uDepth.value;
    const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    const pts = [];
    for (const z of [0, d]) for (let i = 0; i < 4; i++) pts.push(...c[i], z, ...c[(i + 1) % 4], z);
    for (const [x, y] of c) pts.push(x, y, 0, x, y, d);
    this.frame.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  setNow(sec) {
    this.uniforms.uNow.value = sec;
  }

  clear() {
    this.t.array.fill(-1e9);
    this.t.clearUpdateRanges();
    this.t.needsUpdate = true;
    this.head = 0;
  }

  /** Write parsed events (see wire.js) at the ring head. */
  push(ev) {
    let start = Math.max(0, ev.count - this.capacity); // keep only the newest if oversized
    while (start < ev.count) {
      const n = Math.min(ev.count - start, this.capacity - this.head);
      const h = this.head;
      for (let i = 0; i < n; i++) {
        const j = start + i, k = h + i;
        this.xy.array[2 * k] = ev.x[j];
        this.xy.array[2 * k + 1] = ev.y[j];
        this.t.array[k] = ev.tUs[j] / 1e6;
        this.p.array[k] = ev.p[j];
      }
      this.xy.addUpdateRange(2 * h, 2 * n);
      this.t.addUpdateRange(h, n);
      this.p.addUpdateRange(h, n);
      this.head = (h + n) % this.capacity;
      start += n;
    }
    this.xy.needsUpdate = this.t.needsUpdate = this.p.needsUpdate = true;
  }
}
