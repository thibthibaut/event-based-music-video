import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { parseEvents } from './wire.js';
import { nextOffset } from './clock.js';
import { XytVolume } from './xyt_volume.js';
import { Panel } from './panel.js';
import { AudioPlayer } from './audio.js';
import { Features } from './features.js';
import { SpectrumHistory } from './spectrum_history.js';
import { advanceHue, keyAllowed, loadScenes, sceneForKey, SceneMixer } from './scenes.js';
import { approach, dollyDistance, fitHalfHeight, flatDistance, nextFov } from './view.js';

const MAX_WINDOW_S = 2; // panel window slider maximum

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0F0F19');
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const volume = new XytVolume(scene, { capacity: 2e6 * MAX_WINDOW_S }); // resized from status.max_rate

const audio = new AudioPlayer();
const features = new Features({ sampleRate: audio.sampleRate, fftSize: audio.fftSize });
const ZERO_BINS = new Uint8Array(audio.fftSize / 2);
const history = new SpectrumHistory(THREE);
volume.uniforms.uSpec.value = history.texture;

const DEFAULT_FOV = 40;
controls.autoRotateSpeed = 1; // R: about one turn per minute

// Camera glide for M (flat view) and P/O (dolly zoom): eased toward a goal each frame.
let glide = null, flatSaved = null;
controls.addEventListener('start', () => { glide = null; }); // the user grabbed the view

function defaultView() {
  glide = null;
  flatSaved = null;
  camera.fov = DEFAULT_FOV;
  camera.updateProjectionMatrix();
  camera.position.set(1.3, 0.55, 2.1);
  controls.target.set(0, 0, -volume.uniforms.uDepth.value / 2);
  controls.update();
}

/** Where the camera is heading: the glide goal if gliding, else where it is. */
const viewGoal = () => glide ?? { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov };

/** M: glide onto the t axis so the now-plane fills the screen; again: glide back. */
function toggleFlat() {
  if (flatSaved) {
    glide = flatSaved;
    flatSaved = null;
    return;
  }
  const g = viewGoal();
  flatSaved = g;
  const s = volume.uniforms.uSensor.value;
  const d = flatDistance(g.fov, fitHalfHeight(s.x / s.y, camera.aspect));
  glide = { pos: new THREE.Vector3(0, 0, d), target: new THREE.Vector3(0, 0, 0), fov: g.fov };
  controls.autoRotate = false;
}

/** P (+1) / O (-1): change fov and distance together so the target keeps its size (dolly zoom). */
function dolly(dir) {
  const g = viewGoal();
  const fov = nextFov(g.fov, dir);
  const off = g.pos.clone().sub(g.target);
  off.setLength(dollyDistance(off.length(), g.fov, fov));
  glide = { pos: g.target.clone().add(off), target: g.target.clone(), fov };
}

function stepGlide(dt) {
  if (!glide) return;
  const a = 1 - Math.exp(-dt / 0.25);
  camera.position.lerp(glide.pos, a);
  controls.target.lerp(glide.target, a);
  camera.fov = approach(camera.fov, glide.fov, dt, 0.25);
  camera.updateProjectionMatrix();
  if (camera.position.distanceTo(glide.pos) < 1e-4 && Math.abs(camera.fov - glide.fov) < 0.01) glide = null;
}
defaultView();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.3, 0.15);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// Live clock: newest event time, advanced by wall time between batches, smoothed.
let offset = null;
let source = null, width = 0;
const statusEl = document.getElementById('status');

function resetStream() {
  offset = null;
  volume.clear();
  history.reset();
}

function showStatus(s) {
  const mev = (r) => (r / 1e6).toFixed(2);
  statusEl.classList.toggle('error', !!s.error);
  statusEl.textContent = s.error ? `⚠ ${s.error}` :
    `${s.sensor} · in ${mev(s.rate_in)} Mev/s · kept ${mev(s.rate_kept)} Mev/s · USB drops ${s.dropped_usb}` +
    (s.recording ? ` · ● REC ${s.recording}` : '') + (s.message ? `\n${s.message}` : '');
}

function onJson(msg) {
  if (msg.type === 'status') {
    if (msg.max_rate) volume.setCapacity(Math.ceil(msg.max_rate * MAX_WINDOW_S));
    if (msg.source !== source || msg.width !== width) {
      source = msg.source;
      width = msg.width;
      if (msg.width) volume.setSensor(msg.width, msg.height);
      resetStream();
    }
    showStatus(msg);
  } else if (msg.type === 'error') {
    statusEl.classList.add('error');
    statusEl.textContent = `⚠ ${msg.error}`;
  }
  panel.onMessage(msg);
}

let ws = null;
function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { source = null; resetStream(); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return onJson(JSON.parse(e.data));
    const ev = parseEvents(e.data);
    if (!ev.count) return;
    volume.push(ev);
    const target = ev.tUs[ev.count - 1] / 1e6 - performance.now() / 1000;
    offset = nextOffset(offset, target, volume.uniforms.uWindow.value);
  };
  ws.onclose = () => {
    statusEl.textContent = 'disconnected — retrying…';
    setTimeout(connect, 1000);
  };
}
const panel = new Panel({ volume, bloom, scene, camera, controls, send, defaultView });
panel.addAudio(audio);

const SCENES_KEY = 'emv.scenes';
let stored = null;
try { stored = localStorage.getItem(SCENES_KEY); } catch { /* private mode */ }
const scenes = loadScenes(stored);
const mixer = new SceneMixer(scenes);
const sceneUi = panel.addScenes(mixer, () => {
  try { localStorage.setItem(SCENES_KEY, JSON.stringify(scenes)); } catch { /* not persisted */ }
});
window.emv = { audio, features, volume, history, mixer, scenes, camera, controls }; // for the devtools console

const labelEl = document.getElementById('scene-label');
let labelTimer = 0;
function selectScene(i) {
  mixer.select(i);
  sceneUi.refresh();
  labelEl.textContent = `${i} · ${scenes[i].name}`;
  labelEl.classList.add('show');
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => labelEl.classList.remove('show'), 1000);
}
connect();

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'p' || k === 'o') { // held P/O keeps zooming
    if (keyAllowed(e, true)) dolly(k === 'p' ? 1 : -1);
    return;
  }
  if (!keyAllowed(e)) return;
  if (k === 'r') controls.autoRotate = !controls.autoRotate;
  if (k === 'm') toggleFlat();
  if (e.key === ' ') { e.preventDefault(); audio.toggle(); }
  const n = sceneForKey(e.key);
  if (n !== null) selectScene(n);
  if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('clean');
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});

const meters = ['bass', 'mid', 'treble'].map((k) => [k, document.getElementById(`m-${k}`)]);
let lastFrame = performance.now();

/** Per frame: audio features, spectrum history, then the shader's audio uniforms. */
function updateAudio(now, dt, streaming) {
  const u = volume.uniforms;
  features.update(audio.bins() ?? ZERO_BINS, dt, now);
  if (streaming) history.write(now, features.logSpec); // rows are keyed on sensor time
  u.uBass.value = features.bass; u.uTreble.value = features.treble;
  u.uMid.value = approach(u.uMid.value, features.mid, dt, 0.1); // smoothed: twist turns the old tail a lot
  u.uLastBeatT.value = features.lastBeatT;
  u.uTime.value += dt;
  for (const [k, el] of meters) el.style.height = `${Math.round(features[k] * 40)}px`;
}

// CPU effects: background drift (weight 3) and camera shake/drift (weight 4).
const bgBase = new THREE.Color(), bgAccent = new THREE.Color();
let bgPhase = 0;
const shake = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
let shakeBeatT = null;

function cpuEffects(w, dt) {
  bgBase.set(panel.look.background);
  const u = volume.uniforms;
  u.uHue.value = advanceHue(u.uHue.value, w[2], dt);
  // Background: a slow colour drift, never driven by audio (pulses washed out every other effect).
  bgPhase = (bgPhase + 0.015 * dt) % 1;
  bgAccent.set(panel.look.on).offsetHSL(bgPhase, 0, 0).multiplyScalar(0.05); // linear colour: 0.05 ≈ 25 % on screen
  scene.background.copy(bgBase).lerp(bgAccent, 0.6 * w[3]);

  if (features.lastBeatT !== shakeBeatT) { // new beat: random kick
    shakeBeatT = features.lastBeatT;
    shake.randomDirection().multiplyScalar(0.06 * w[4]);
  }
  shake.multiplyScalar(Math.exp(-dt / 0.2));
  if (w[4] > 0) camera.position.sub(controls.target).applyAxisAngle(up, w[4] * 0.1 * dt).add(controls.target);
}

renderer.setAnimationLoop(() => {
  const t = performance.now();
  const dt = Math.min(0.1, (t - lastFrame) / 1000); // clamp hitches and backgrounded tabs
  lastFrame = t;
  // Sensor time when streaming; wall time otherwise, so the meters work without a camera.
  const now = offset !== null ? t / 1000 + offset : t / 1000;
  if (offset !== null) volume.setNow(now);
  updateAudio(now, dt, offset !== null);
  const w = mixer.step(dt, sceneUi.fade);
  for (let i = 0; i < w.length; i++) volume.uniforms.uW.value[i] = w[i];
  cpuEffects(w, dt);
  stepGlide(dt);
  controls.update(dt);
  camera.position.add(shake); // removed after render so OrbitControls never accumulates it
  composer.render();
  camera.position.sub(shake);
});
