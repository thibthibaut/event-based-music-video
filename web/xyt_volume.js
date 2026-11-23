import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute float aT;
  attribute float aP;
  uniform float uNow, uWindow, uDepth, uGamma, uPointSize, uPixelRatio;
  uniform vec2 uSensor;
  varying float vP;
  varying float vLife;

  void main() {
    float age = uNow - aT;
    if (age < 0.0 || age > uWindow) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-clip
      gl_PointSize = 0.0;
      return;
    }
    float u = age / uWindow;
    vec3 p = vec3((position.x / uSensor.x - 0.5) * (uSensor.x / uSensor.y),
                  0.5 - position.y / uSensor.y,
                  -uDepth * pow(u, uGamma));
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
  varying float vP;
  varying float vLife;

  void main() {
    float r = length(gl_PointCoord - vec2(0.5));
    if (r > 0.5) discard;
    float core = 1.0 - smoothstep(0.04, 0.28, r);
    float glow = exp(-r * r * 20.0);
    float a = uIntensity * (core + glow * 0.42) * pow(vLife, uK);
    gl_FragColor = vec4(mix(uOffColor, uOnColor, vP) * a, a);
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
