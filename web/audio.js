// Song playback through an AnalyserNode. Plays to the speakers so OBS records it in sync.
export class AudioPlayer {
  constructor() {
    this.ctx = new AudioContext(); // starts suspended until a user gesture resumes it
    this.el = new Audio();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    // Default -100..-30 dB clips loud masters at 255, which flattens kicks; features.js assumes this range.
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;
    this.gain = this.ctx.createGain();
    this.ctx.createMediaElementSource(this.el).connect(this.analyser);
    this.analyser.connect(this.gain).connect(this.ctx.destination);
    this.buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.sampleRate = this.ctx.sampleRate;
    this.fftSize = this.analyser.fftSize;
    this.name = '';
    this.loaded = false;
  }

  async load(file) {
    if (this.el.src) URL.revokeObjectURL(this.el.src);
    this.el.src = URL.createObjectURL(file);
    this.name = file.name;
    this.loaded = true;
    await this.ctx.resume();
  }

  get playing() {
    return this.loaded && !this.el.paused;
  }

  async toggle() {
    if (!this.loaded) return;
    await this.ctx.resume();
    if (this.el.paused) await this.el.play();
    else this.el.pause();
  }

  set volume(v) {
    this.gain.gain.value = v;
  }

  /** Current byte spectrum, or null before a song is loaded. */
  bins() {
    if (!this.loaded) return null;
    this.analyser.getByteFrequencyData(this.buf);
    return this.buf;
  }
}
