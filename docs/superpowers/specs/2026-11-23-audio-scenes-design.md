# Audio-reactive scenes with live keys — design (phase 2a)

Date: 2026-11-23. Builds on `2026-11-23-xyt-music-video-design.md` (phase 1, merged).

## Intent

Turn the live XYT volume into a music-video instrument. The page plays the song. Its
spectrum drives visual effects on the events. During the take, someone switches between
effect "scenes" with keyboard keys: the performer, or a second person at the laptop.
OBS records the page (picture and sound) as the take. Live is the primary mode; a
frame-exact offline render stays possible later and is out of scope here.

## Goals

- Load an mp3/wav in the page, play/pause it, and hear it (so OBS records it in sync).
- Live analysis each frame: spectrum, bass/mid/treble levels, a beat pulse.
- Eight effects, each with a 0–1 weight, driven by the analysis.
- Keys `1`–`9` recall scenes (sets of weights); `0` returns to the plain volume.
  Changes crossfade smoothly.
- Scenes are editable in the panel and persist in the browser.

## Non-goals

- Offline/frame-exact export (phase 2b).
- Microphone input, MIDI, timeline/automatic scene switching.
- Measuring/tuning performance (done later with OBS running; see Constraints).

## Anti-goals

- Hard cuts or pops when switching scenes.
- Per-event work on the JS main thread that grows with the event rate.
- Effects that only work with audio loaded: with no audio every scene still renders
  (audio levels read as 0).

## Constraints

- Hardware: AMD Radeon integrated GPU (Phoenix), 1920×1200, with OBS encoding on the same
  GPU. Every effect must be a few shader lines or a per-frame CPU update. No extra render
  passes.
- Keep the phase 1 server and wire protocol unchanged. This is page-only work.
- Keys must work from a plain wireless keyboard or presenter clicker, so only standard
  key events are used.

## Approaches considered

- **A. Web Audio `AnalyserNode` + effects in the shader + spectrum history texture (chosen).**
  Analysis is native and cheap. The fountain looks up the spectrum at each event's birth
  time in a 2-D history texture, so per-event work stays on the GPU.
- B. Store a per-event lift computed in JS on arrival. That is ~2 M lookups/s on the main
  thread, and the gain is frozen once applied. Rejected.
- C. FFT in the Rust server. The page must still play the audio for the performer and OBS,
  so two clocks drift. More plumbing, no gain. Rejected.

## Design

### Audio (`web/audio.js`)

- Panel **Audio** folder: **Load…** (`<input type=file accept="audio/*">`), play/pause,
  volume, the file name, and three small level bars (bass/mid/treble) as live meters.
- The graph: `HTMLAudioElement` → `MediaElementAudioSourceNode` → `AnalyserNode`
  (`fftSize 2048`, `smoothingTimeConstant 0.5`) → `destination`.
- The `AudioContext` is created/resumed on the first user gesture (load or play), as
  browser autoplay rules require.
- `Space` toggles play/pause.

### Features (`web/features.js`, pure, unit-tested)

The `Features` class is updated once per animation frame from `getByteFrequencyData`
(0–255 per bin) and the frame `dt`:

- **Bands:** mean magnitude over bass 20–150 Hz, mid 150–2000 Hz, treble 2–12 kHz,
  converted from bin index with `sampleRate / fftSize`.
- **Auto-gain per band:** divide by a running peak that decays with τ = 3 s
  (floor 1e-3), so levels are 0–1 regardless of the track's mastering.
- **Beat:** bass flux (positive part of the frame-to-frame bass rise) above
  `mean + 1.5·std` of the last 1 s of flux, with a 250 ms refractory period. On a beat:
  `beat = 1`, `lastBeatT = now`, where `now` is the **sensor-time** `uNow` passed in by
  `main.js`, so the shockwave lines up with the events born at the beat. Otherwise `beat` decays with τ = 0.15 s.
- **Log spectrum:** 256 bins, log-spaced 30 Hz – 16 kHz, each sampled from the analyser
  bins (max over the covered range), as a `Uint8Array(256)`, for the history texture.

### Spectrum history (`web/spectrum_history.js`)

- A `DataTexture` 256 × 128, `RedFormat`, `UnsignedByteType`, `LinearFilter` on x,
  wrapping as a ring over time.
- Row duration `ROW_S = 2 s / 128` (15.6 ms), so the ring covers the 2 s max window.
- Rows are keyed on **sensor time** (the same clock as `uNow` and event `aT`):
  `row(t) = floor(t / ROW_S) mod 128`.
- Each frame writes the current log spectrum into every row from the last written row up
  to `row(uNow)`, then uploads only the changed rows.
- With no audio loaded, the rows stay 0.
- While there is no event stream (`uNow` unknown), nothing is written.

### Effects (shader + per-frame CPU)

Shared uniforms: `uBass, uMid, uTreble, uBeat` (0–1), `uLastBeatT` (sensor s), `uTime` (s),
`uSpec` (history texture), and one weight per effect `uW*` (0–1). In each line below,
`u = age/window` and `c` = the event's plane position relative to the plane centre.

| # | Effect | Where | Rule (weight `w`) |
|---|---|---|---|
| 1 | Jitter | vertex | random 3-D offset from a hash of `gl_VertexID` and `floor(uTime·30)`, amplitude `w·(0.005 + 0.04·uTreble)` |
| 2 | Fountain | vertex | `bin = log-map(x column)`; `y += w · 0.8 · spec(bin, row(aT))`, so events lift upward and can leave the cube; older events keep the lift from their birth time |
| 3 | Palette | fragment | rotate the ON/OFF hues by `w·uTime·0.1` turns; mix toward white by `w·uBeat·0.6` |
| 4 | Background | CPU | `background = mix(base, accent, w·(0.35·uBass + 0.5·uBeat))`; accent = the palette-rotated ON colour, darkened |
| 5 | Camera | CPU | on each beat a random offset of size `w·0.06` decays with τ 0.2 s; plus an orbit drift of `w·0.1` rad/s around the volume |
| 6 | Time pump | vertex | depth multiplied by `1 + w·0.6·uBass` |
| 7 | Shockwave | vertex | `c *= 1 + w·0.5·exp(-((aT − uLastBeatT)/0.03)²)`: events born at the beat burst outward, and the ring travels back in depth as it ages |
| 8 | Twist | vertex | rotate `c` by `w·(0.5 + 2·uMid)·u·π` |

These constants are starting values. The builder tunes them by eye against the test
track, and they are not exposed in the panel.

### Scenes (`web/scenes.js`, logic pure and unit-tested)

- A scene is `{ name, w: [8 numbers 0–1] }`. Key `n` (1–9) recalls scene `n`.
  Key `0` recalls the plain scene (all weights 0).
- **Crossfade:** the current weights move toward the target with τ = `fade` seconds
  (panel slider 0.05–3 s, default 0.4 s). A new key press during a fade retargets from
  the current mix, so there is never a jump.
- **Default scenes** (the builder picks pleasing values; names are a guide):
  1 *jitter sparkle*, 2 *fountain*, 3 *palette + background*, 4 *shockwave + shake*,
  5 *twist tunnel*, 6 *time pump + fountain*, 7 *all-in*, 8 *calm drift* (palette + slow
  camera), 9 *chaos* (jitter + twist + shockwave).
- Panel **Scenes** folder:
  - the active scene number and name;
  - the 8 weight sliders of the active scene, editable live (edits apply at once, no fade);
  - **Reset scenes to defaults**;
  - the fade slider.
- Persist to `localStorage['emv.scenes']` in try/catch. A stored value that does not parse
  or has the wrong shape falls back to the defaults.
- Key handling is ignored while focus is in an input/select (lil-gui number fields).
  `H`, `F` and `Space` stay as they are.
- A small overlay shows the scene number and name for 1 s after a switch, unless the UI is
  hidden (`H`).

### Files

- New: `web/audio.js`, `web/features.js`, `web/spectrum_history.js`, `web/scenes.js`,
  `web/test/features.test.mjs`, `web/test/scenes.test.mjs`, `web/test/spectrum_history.test.mjs`
  (the row-index and fill logic only).
- Changed: `web/xyt_volume.js` (uniforms and shader effects), `web/main.js` (per-frame
  update order: features, history, scene fade, uniforms, camera/background), `web/panel.js`
  (Audio and Scenes folders), `README.md` (keys, audio).

### Testing

- Node unit tests:
  - Band mapping: a spectrum with energy only in the bass bins gives `bass≈1`,
    `mid≈0`, `treble≈0`.
  - Auto-gain decays.
  - Beat detection fires on a synthetic kick train at 120 BPM (2 Hz), with no extra
    beats on a constant level, and respects the refractory period.
  - Log-spectrum mapping covers 30 Hz – 16 kHz.
  - Scene fade is monotonic and converges; retargeting mid-fade never jumps; key → scene
    mapping; persisted-state validation.
  - History row index wraps and fills the skipped rows.
- Manual: generate a 120 BPM test track with ffmpeg (kick + bass + hi-hat). Check each
  default scene visually against the live camera, with the screenshots described in the
  plan.

## Left to the builder

- Exact effect constants and default scene weights (tune by eye).
- Overlay styling.
- How the palette rotation is computed (HSL or RGB rotation in the shader).

## Calls made by Claude (check these)

- Phase 2a covers no offline export; that is 2b.
- The camera-shake and background effects live on the CPU; all others in the shader.
- The default fade is 0.4 s, a time constant rather than "one beat", so it works without
  tempo detection.
- The plain scene is on `0`; scenes persist in the browser only (no file export).
