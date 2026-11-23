import GUI from './vendor/lil-gui.esm.js';
import { EFFECTS, defaultScenes } from './scenes.js';

const LOOK_KEY = 'emv.look';

function load() {
  try { return JSON.parse(localStorage.getItem(LOOK_KEY)) || {}; } catch { return {}; }
}

function save(v) {
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(v)); } catch { /* private mode: not persisted */ }
}

/** lil-gui panel: look settings (persisted) and camera controls (built from the server's bias list). */
export class Panel {
  constructor({ volume, bloom, scene, camera, controls, send, defaultView }) {
    Object.assign(this, { volume, bloom, scene, camera, controls, send, defaultView });
    const u = volume.uniforms;
    const look = {
      window: u.uWindow.value, depth: u.uDepth.value, gamma: u.uGamma.value, k: u.uK.value,
      size: u.uPointSize.value, intensity: u.uIntensity.value,
      bloomStrength: bloom.strength, bloomRadius: bloom.radius, bloomThreshold: bloom.threshold,
      on: '#F5C2E7', off: '#89DCEB', background: '#0F0F19', frame: true,
      ...load(),
    };
    this.look = look;
    const apply = () => {
      u.uWindow.value = look.window; u.uGamma.value = look.gamma; u.uK.value = look.k;
      u.uPointSize.value = look.size; u.uIntensity.value = look.intensity;
      if (u.uDepth.value !== look.depth) { u.uDepth.value = look.depth; volume.updateFrame(); }
      bloom.strength = look.bloomStrength; bloom.radius = look.bloomRadius; bloom.threshold = look.bloomThreshold;
      u.uOnColor.value.set(look.on); u.uOffColor.value.set(look.off);
      scene.background.set(look.background);
      volume.frame.visible = look.frame;
      save(look);
    };

    this.gui = new GUI({ title: 'Event volume' });
    const keys = this.gui.addFolder('Keys');
    const list = document.createElement('div');
    list.className = 'keys-list';
    list.innerHTML = [
      ['H', 'hide / show the UI'], ['F', 'full screen'], ['Space', 'play / pause music'],
      ['1–9', 'scenes'], ['0', 'plain scene'], ['R', 'auto-rotate on / off'],
      ['M', 'flat view on / off'], ['P', 'more perspective (hold)'], ['O', 'less perspective (hold)'],
    ].map(([k, what]) => `<kbd>${k}</kbd><span>${what}</span>`).join('');
    keys.$children.appendChild(list);
    const g = this.gui.addFolder('Look');
    g.add(look, 'window', 0.1, 2, 0.01).name('window (s)');
    g.add(look, 'depth', 0.5, 8, 0.1);
    g.add(look, 'gamma', 0.5, 3, 0.01).name('speed ramp γ');
    g.add(look, 'k', 0.2, 4, 0.01).name('fade k');
    g.add(look, 'size', 0.5, 8, 0.1).name('point size');
    g.add(look, 'intensity', 0.02, 1, 0.01);
    g.add(look, 'bloomStrength', 0, 3, 0.01).name('bloom');
    g.add(look, 'bloomRadius', 0, 1, 0.01).name('bloom radius');
    g.add(look, 'bloomThreshold', 0, 1, 0.01).name('bloom threshold');
    g.addColor(look, 'on').name('ON colour');
    g.addColor(look, 'off').name('OFF colour');
    g.addColor(look, 'background');
    g.add(look, 'frame').name('frame');
    g.add({ reset: () => { delete look.view; defaultView(); save(look); } }, 'reset').name('Reset view');
    g.onChange(apply);
    apply();

    if (look.view) {
      camera.position.fromArray(look.view.position);
      controls.target.fromArray(look.view.target);
      if (look.view.fov) { camera.fov = look.view.fov; camera.updateProjectionMatrix(); }
      controls.update();
    }
    controls.addEventListener('end', () => {
      look.view = { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov };
      save(look);
    });

    this.cam = this.gui.addFolder('Camera');
    this.cam.hide();
    this.camState = { afk: true, lo: 90, hi: 110, target: 1.0, record: false, file: '' };
    const s = this.camState;
    const afk = () => {
      if (s.lo > s.hi) [s.lo, s.hi] = [s.hi, s.lo]; // libreeb refuses an inverted band
      this.afkCtrls.forEach((c) => c.updateDisplay());
      send({ type: 'antiflicker', on: s.afk, lo_hz: s.lo, hi_hz: s.hi });
    };
    this.afkCtrls = [
      this.cam.add(s, 'afk').name('anti-flicker').onChange(afk),
      this.cam.add(s, 'lo', 50, 500, 1).name('band low (Hz)').onFinishChange(afk),
      this.cam.add(s, 'hi', 50, 520, 1).name('band high (Hz)').onFinishChange(afk),
    ];
    this.biasFolder = this.cam.addFolder('Biases');
    this.biasCtrls = new Map();
    this.biasValues = {};
    this.cam.add(s, 'target', 0.1, 10, 0.1).name('auto-bias ev/s/px');
    this.cam.add({ auto: () => send({ type: 'autobias', target: s.target }) }, 'auto').name('Auto-bias');
    this.cam.add({ hot: () => send({ type: 'calibrate_hot_pixels' }) }, 'hot').name('Recalibrate hot pixels');
    this.cam.add({ save: () => send({ type: 'bias_save' }) }, 'save').name('Save biases');
    // options() re-adds the controller at the end of its folder, so it gets a folder of its own.
    this.fileCtrl = this.cam.addFolder('Load biases').add(s, 'file', ['']).name('file');
    this.cam.add({ reset: () => send({ type: 'bias_reset' }) }, 'reset').name('Reset biases');
    this.recCtrl = this.cam.add(s, 'record').name('● Record').onChange((on) => send({ type: 'record', on }));
    this.cam.onOpenClose(() => send({ type: 'list_bias_files' }));
  }

  /** Audio folder: load a song, play/pause (also Space), volume. */
  addAudio(audio) {
    const f = this.gui.addFolder('Audio  (Space plays)');
    const input = document.getElementById('audio-file');
    const st = { song: '—', volume: 1 };
    const song = f.add(st, 'song').name('song').disable();
    f.add({ load: () => input.click() }, 'load').name('Load…');
    const play = f.add({ toggle: () => audio.toggle() }, 'toggle').name('Play / pause');
    f.add(st, 'volume', 0, 1, 0.01).onChange((v) => { audio.volume = v; });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      await audio.load(file);
      st.song = file.name;
      song.updateDisplay();
      input.value = '';
    });
    audio.el.addEventListener('play', () => play.name('Pause'));
    audio.el.addEventListener('pause', () => play.name('Play'));
  }

  /** Scenes folder: edit the active scene's weights live; returns { fade, refresh }. */
  addScenes(mixer, save) {
    const f = this.gui.addFolder('Scenes  (keys 0–9)');
    const ui = { fade: 0.4, label: '' };
    const label = f.add(ui, 'label').name('active').disable();
    const w = Object.fromEntries(EFFECTS.map((k) => [k, 0]));
    const ctrls = EFFECTS.map((k, i) => f.add(w, k, 0, 1, 0.01).onChange((v) => {
      mixer.scenes[mixer.active].w[i] = v;
      save();
    }));
    f.add(ui, 'fade', 0.05, 3, 0.01).name('fade (s)');
    f.add({ reset: () => {
      mixer.scenes.splice(0, mixer.scenes.length, ...defaultScenes());
      save();
      ui.refresh();
    } }, 'reset').name('Reset scenes');
    ui.refresh = () => {
      const sc = mixer.scenes[mixer.active];
      ui.label = `${mixer.active} · ${sc.name}`;
      label.updateDisplay();
      EFFECTS.forEach((k, i) => { w[k] = sc.w[i]; ctrls[i].updateDisplay(); });
    };
    ui.refresh();
    return ui;
  }

  onMessage(msg) {
    if (msg.type === 'biases') this.setBiases(msg.list);
    else if (msg.type === 'bias_files') this.setBiasFiles(msg.files);
    else if (msg.type === 'status') {
      const s = this.camState;
      s.afk = !!msg.antiflicker;
      if (msg.antiflicker) [s.lo, s.hi] = msg.antiflicker;
      s.record = !!msg.recording;
      this.recCtrl.name(msg.recording ? `● Recording ${msg.recording.split('/').pop()}` : '● Record');
      for (const c of [...this.afkCtrls, this.recCtrl]) c.updateDisplay();
      if (msg.message?.startsWith('saved ')) this.send({ type: 'list_bias_files' });
    }
  }

  setBiases(list) {
    if (!list.length) return this.cam.hide();
    this.cam.show();
    for (const b of list) {
      this.biasValues[b.name] = b.offset;
      let c = this.biasCtrls.get(b.name);
      if (!c) {
        c = this.biasFolder.add(this.biasValues, b.name, b.min, b.max, 1).name(b.name.replace('bias_', ''))
          .onChange((v) => this.send({ type: 'bias', name: b.name, offset: v }));
        c.domElement.title = b.hint;
        this.biasCtrls.set(b.name, c);
      }
      c.updateDisplay();
    }
  }

  setBiasFiles(files) {
    const s = this.camState;
    s.file = '';
    this.fileCtrl = this.fileCtrl.options(['', ...files]).name('file')
      .onChange((f) => f && this.send({ type: 'bias_load', file: f }));
  }
}
