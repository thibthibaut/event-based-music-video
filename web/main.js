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

function defaultView() {
  camera.position.set(1.3, 0.55, 2.1);
  controls.target.set(0, 0, -volume.uniforms.uDepth.value / 2);
  controls.update();
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
connect();

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('clean');
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});

renderer.setAnimationLoop(() => {
  if (offset !== null) volume.setNow(performance.now() / 1000 + offset);
  controls.update();
  composer.render();
});
