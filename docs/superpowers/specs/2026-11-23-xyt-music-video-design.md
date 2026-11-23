# Event-camera music video: live XYT volume viewer — design

Date: 2026-11-23

## Intent

Make a music video from an event camera (Prophesee EVK4). The picture is an
x-y-t volume of events: the newest events sit on a "now" plane at their sensor
x,y, and older events slide back in depth, speeding up and fading as they go.
Points glow in the libreeb viewer colours.

Two uses, same renderer:

- **Live**: the performer dances in front of the camera and sees the volume in
  real time. This is how the dance gets performed and rehearsed.
- **Offline** (phase 2): a recording plus the soundtrack (mp3/wav) rendered
  frame by frame at a fixed frame rate, with FFT-driven effects, so every take
  is identical and in sync with the music.

## Phases

- **Phase 1 (this design, to validate the look)**: Rust server + three.js page,
  live camera and real-time file replay, recording, the off-axis glowing volume
  with speed ramp and fade, a tweak panel.
- **Phase 2 (later, separate design round)**: audio loading, FFT, music-driven
  transforms (camera shake from frequency bands, event jitter, etc.),
  frame-exact offline export to video. Open question for phase 2: whether live
  mode also reacts to music, and if so from the mp3 in the page or a room mic.

## Goals (phase 1)

- Full-screen, 60 fps, glowing XYT volume from a live EVK4 with no visible
  stutter or drops caused by our software.
- Same view from a recorded file, played back in real time.
- Record a live session to disk for later offline rendering.
- Look parameters tweakable live, and the UI hideable for clean capture.

## Non-goals (phase 1)

- Audio, FFT, music-driven effects, frame export (phase 2).
- Browser-only / hosted deployment. It runs on the laptop the camera is plugged into.
- Multiple cameras, non-EVK4 sensors.

## Anti-goals

- Dropped or stuttering frames in live mode. The tested WebUSB path was rejected
  for exactly this. The page must never block on event data.
- Any architecture where offline and live renders look different. One renderer,
  one shader, only the clock and the event source differ.

## Constraints

- EVK4 HD, 1280×720. Flicker in the room can push the raw rate very high. The
  hardware anti-flicker filter, bias tuning and hot-pixel masking cut it at the
  sensor.
- libreeb (git dependency, `camera` feature) gives
  `CameraReader` (live) and `RawFileReader` (`.raw` files).
- The camera thread (anti-flicker, auto-bias, hot-pixel masking, `.bin` record
  and replay) is reused from earlier code by the same author, GPL-3.0.
- Renderer style: point sprites with a core+glow shader, depth fade, ring buffer.
- WebUSB in the browser was tested and dropped data under flicker. Rejected.

## Approaches considered

- **A. Rust server + three.js page (chosen).** A native server reads the camera
  or file with libreeb, applies the sensor-side filters, caps the rate and
  streams packed events over a WebSocket on localhost. It also serves the
  page. In phase 2 the same server serves events per frame window and muxes
  the exported frames with the audio. One decoder, one event path.
- B. Server for live, browser (libreeb wasm) decodes files. The page stands
  alone for offline use, but there are two decode paths to keep in sync and
  4K frame export from a page with no server is awkward. Rejected.
- C. Fully native (wgpu). Fastest, but loses three.js shader iteration and the
  existing glow code. Works against the request. Rejected.
- WebUSB live in the browser: tested, drops under flicker. Rejected.

## Decided

- New repo `~/ws/event-music-video`, git-initialised.
- Rust server binary plus a static `web/` folder. No JS build step. three.js
  and its addons are vendored as ES modules, using an import map.
- View: perspective camera **slightly off-axis** so the volume reads as 3D,
  so the volume reads as 3D. In phase 2 the camera shakes with FFT bands and
  events get jitter.
- Colours (libreeb `xyt_view.rs`): ON `#F5C2E7` pink, OFF `#89DCEB` cyan,
  background `#0F0F19`.
- Time axis with a speed ramp: `z = -depth · (age/window)^γ`, γ slightly > 1.
- Fade: `opacity = (1 - age/window)^k`.
- Glow: additive blending of soft point sprites plus a bloom post-pass.

## Design

### Server (Rust)

- CLI: `event-music-video --camera` or `--file <path>` (`.raw` via
  `RawFileReader`, `.bin` via the copied 13-byte record reader), `--port 8080`,
  `--biases <file.bias>`, `--max-rate <ev/s>` (default 2_000_000).
- HTTP + WebSocket on `127.0.0.1` (axum + tokio): `/` serves `web/`, `/ws`
  carries the event stream and control messages.
- Source thread, from the reused camera code: camera (bias
  offsets, anti-flicker band, auto-bias, hot-pixel calibration on start,
  record to `.bin`) and real-time file replay. Drop the parts that do not apply
  here (taps).
- Rate cap: per batch, keep each event with probability
  `min(1, budget / measured_rate)`. Random, not stride, so there is no spatial
  pattern. Report the measured rate and kept rate.
- Wire format, binary WS message per batch (≈ every 10 ms or 1024+ events):
  `u32 count`, then `count × { u16 x | p<<15, u16 y, u32 t_us }`
  (little-endian, 8 bytes/event). `t_us` is relative to source start. At 2 M ev/s
  this is 16 MB/s on localhost, which is fine.
- Control, JSON text messages page→server: `antiflicker {on, lo_hz, hi_hz}`,
  `bias {name, offset}`, `bias_reset`, `bias_save`, `bias_load {file}`, `autobias {target}`, `calibrate_hot_pixels`,
  `record {on}` (file name `recordings/YYYY-MM-DD_HH-MM-SS.bin`). Server→page:
  `status {source, sensor, width, height, rate_in, rate_kept, dropped_usb,
  recording, message}` once per second plus on change.
- A single client is assumed. Shortcut: a second tab gets the same stream; no
  fan-out work is needed.

### Biases

- All six EVK4 biases from libreeb `BIAS_TABLE`: `bias_diff_on`, `bias_diff_off`,
  `bias_diff`, `bias_fo`, `bias_hpf`, `bias_refr`. They are written as offsets
  from the factory default.
- On connect the server sends `biases {list: [{name, offset, min, max, hint}]}`,
  using `rec_min`/`rec_max`/`hint` from `BIAS_TABLE`. The page builds one slider
  per bias from it, so nothing is hard-coded in JS.
- Slider change → `bias {name, offset}` → `write_bias` immediately. Auto-bias
  and file loads push `bias {name, offset}` back, so the sliders follow.
- Bias files use the Metavision `.bias` format (`<offset>    % <name>` per line, as
  in `libreeb/biases.bias`):
  - CLI `--biases <file.bias>` applies them at camera open.
  - Panel **Save biases** writes `biases/<timestamp>.bias`. **Load biases** picks
    from the files in `biases/` (the server lists them).
  - Each recording also writes its biases beside it as `<recording>.bias`, so a
    good take's settings can be reused.
- **Reset to defaults** button.

### Page (three.js)

- `web/index.html`, `web/main.js`, `web/xyt_volume.js`, `web/stream.js`,
  `web/panel.js`, `web/vendor/three/…` (with `addons/postprocessing` and
  `addons/controls/OrbitControls.js`), `web/vendor/lil-gui`.
- **Stream** (`stream.js`): a WebSocket with `binaryType = 'arraybuffer'`.
  On each message it pushes the events into the volume ring buffer.
  Reconnects automatically, so the page stays up while the server restarts.
- **Volume** (`xyt_volume.js`): `THREE.Points` over a ring buffer of
  `capacity` events, sized `max_rate × max window` (default 2 M ev/s × 2 s = 4 M, about 64 MB of GPU memory) so events are never overwritten before they fade out. Attributes are `position.xy`
  (normalised sensor x,y, y flipped, aspect kept), `t` (float seconds), `p`.
  New events are written in place with `addUpdateRange` on just the written
  slice, so old events are never touched. The vertex shader computes
  `age = uNow - t`, discards `age > uWindow` or `age < 0`, and places
  `z = -uDepth * pow(age/uWindow, uGamma)`. The fragment shader draws a
  core+glow sprite in the ON/OFF colour with `alpha *= pow(1-age/uWindow, uK)`,
  `AdditiveBlending`, `depthWrite: false`.
- **Clock**: in live mode, `uNow` = newest received `t` plus the wall-clock time
  since it arrived, smoothed (a one-pole filter on the offset). This keeps the
  slide smooth between batches. In phase 2, offline mode sets `uNow` per
  exported frame. The clock is one function, swapped by mode.
- **Precision**: `t` is stored relative to a rebasing origin. Keep it under about
  1 hour in float32 seconds (µs resolution at 1 h is ~0.25 ms; ample for
  rendering). Rebase on source restart.
- **Scene**: a faint frame/grid outline of the now-plane and the back plane,
  toggleable. Perspective camera off-axis by default,
  with OrbitControls to adjust; the camera pose is saved in the panel state.
- **Post**: `EffectComposer` → `RenderPass` → `UnrealBloomPass` → `OutputPass`.
- **Panel** (lil-gui, `H` hides it and the cursor): window (s), depth, γ, k,
  point size, bloom strength/radius/threshold, ON/OFF colours, background,
  grid on/off, reset camera view; camera controls: anti-flicker on and band,
  all bias sliders with save/load/reset (see Biases), auto-bias, recalibrate hot pixels,
  record toggle; a status line (rate in/kept, USB drops, recording). Look
  settings persist in `localStorage`.
- `F` toggles browser full screen.

### Testing

- Rust unit tests: `.bias` parse/write round-trip, wire encode (byte layout, polarity bit), rate-cap keep
  ratio, `.bin` round-trip (copied test).
- Manual acceptance: live EVK4 in a flickering room with anti-flicker on, fast
  full-body motion: 60 fps, `dropped_usb` stays 0, no visible stutter. Replay
  of a `.bin` recording looks identical to live.

## Left to the builder

- Exact batch flush interval and default look values (depth, γ, k, sizes, bloom).
- axum vs. a lighter HTTP/WS crate, if axum gets in the way.
- Grid styling details.
- How `.raw` replay paces itself (mirror the `.bin` replay: sleep to timestamps).

## Calls made by Claude (check these)

- Recording is in phase 1, because offline rendering needs takes of the dance.
- Rate cap default 2 M ev/s, max window 2 s, ring buffer 4 M events.
- Server-side random decimation rather than spatial binning.
- Copy `source.rs` and its helpers instead of making a shared crate.
- lil-gui for the panel, vendored three.js (pinned version) and no npm.
