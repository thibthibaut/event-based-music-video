# XYT Live Viewer (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust server streams EVK4 (or recorded) events over a WebSocket to a full-screen three.js page that renders a glowing, off-axis x-y-t volume with a speed ramp and fade, plus camera controls (biases, anti-flicker, auto-bias, hot pixels, recording).

**Architecture:** A source thread (reused camera code) reads the camera or a file and sends `SourceMsg` over std `mpsc`. A bridge thread decimates the batches to a rate budget, encodes them to binary frames, and publishes them on a tokio `broadcast` channel. An axum server serves `web/` and `/ws`. The page writes events into a GPU ring buffer. The shader computes age from a `uNow` uniform, so old events are never rewritten.

**Tech Stack:** Rust 2021, libreeb (path dependency, feature `camera`), axum 0.8 (`ws`), tokio, tower-http `ServeDir`, serde/serde_json, anyhow. three.js r186 (vendored ES modules + addons), lil-gui 0.20.0 (vendored). No npm build step. `node --test` is used only for the pure JS wire parser test.

**Spec:** `docs/superpowers/specs/2026-11-23-xyt-music-video-design.md`

## Global Constraints

- The server binds `127.0.0.1` only. Default port `8080`.
- CLI: `--camera` | `--file <path>` (`.bin` or `.raw`), `--biases <file.bias>`, `--max-rate <ev/s>` (default `2_000_000`), `--port <n>`.
- Wire event: 8 bytes LE `{ u16 x | (p << 15), u16 y, u32 t_us }`, with `t_us` relative to source start. Binary message = `u32 count` + events.
- Colours: ON `#F5C2E7`, OFF `#89DCEB`, background `#0F0F19`.
- Time axis `z = -depth · (age/window)^γ`; fade `alpha *= (1 - age/window)^k`.
- Max window 2 s. Ring buffer capacity = `max_rate × 2` (4 M by default).
- Bias offsets are relative to the factory default. Names and ranges come only from libreeb `BIAS_TABLE` (`rec_min`, `rec_max`, `hint`).
- `.bias` file format: one `<offset>    % <name>` per line.
- Recordings go to `recordings/YYYY-MM-DD_HH-MM-SS.bin`, with `<same>.bias` beside them. Saved biases go to `biases/YYYY-MM-DD_HH-MM-SS.bias`.
- Licence GPL-3.0, the same as libreeb.

## Review Focus

1. **Camera missing, or unplugged mid-run:** the server stays up, the page shows the error in its status line, and nothing panics. → Task 4 integration test with a missing file path (same error path as the camera).
2. **Slow or backgrounded browser tab:** the camera thread must never block. A lagging WebSocket client skips frames instead of applying back-pressure. → Task 4 test `lagged_client_does_not_block_bridge`.
3. **Flicker burst far above the budget:** the kept rate stays near `max_rate`, so the ring buffer never overwrites events inside the window. → Task 2 test `decimator_caps_burst`.
4. **Hand-edited or foreign `.bias` file** (unknown name, junk line, value out of range): bad lines are skipped and the value is clamped to `rec_min..=rec_max`, with no panic. → Task 1 test `parse_skips_junk_and_clamps`.
5. **Page reload or second connect mid-stream:** the new client gets `status` and `biases` first, then events. → Task 4 test `reconnect_gets_status_and_biases_first`.

---

### Task 1: Crate scaffold, copied helpers, `.bias` files

**Files:**
- Create: `Cargo.toml`, `.gitignore` (`target/`, `recordings/`, `biases/`), `src/main.rs` (stub `fn main() {}`), `src/lib.rs`, `src/biases.rs`
- Reuse verbatim: `src/autobias.rs` and `src/hotpix.rs` from the earlier camera code (with their tests)

**Interfaces:**
- Produces (`src/biases.rs`):
  - `pub fn index_of(name: &str) -> Option<usize>`: position in `libreeb::biases::BIAS_TABLE`
  - `pub fn defaults() -> Vec<i32>`: the `default_offset` per `BIAS_TABLE` entry
  - `pub fn parse(text: &str, offsets: &mut [i32]) -> Vec<String>`: applies each valid line, clamped to `rec_min..=rec_max`, and returns warnings for skipped lines
  - `pub fn write(offsets: &[i32]) -> String`: one line per `BIAS_TABLE` entry, `format!("{off:<5}% {name}\n")`
  - `pub fn timestamp_name(now: std::time::SystemTime) -> String`: `"YYYY-MM-DD_HH-MM-SS"` in local time. Use `chrono` with `default-features = false, features = ["clock"]`.

- [ ] **Step 1: Write `Cargo.toml`.** Package `event-music-video`, edition 2021, licence GPL-3.0. Deps: `libreeb = { path = "../libreeb", default-features = false, features = ["camera"] }`, `axum = { version = "0.8", features = ["ws"] }`, `tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }`, `tower-http = { version = "0.6", features = ["fs"] }`, `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`, `anyhow = "1"`, `chrono` as above, `futures-util = "0.3"`. Dev-deps: `tokio-tungstenite = "0.26"`.
- [ ] **Step 2: Copy `autobias.rs` and `hotpix.rs`, and declare all modules in `lib.rs`.** Run `cargo test`. Expected: the copied tests pass.
- [ ] **Step 3: Write the failing tests in `src/biases.rs`.**

```rust
#[test]
fn bias_file_round_trip() {
    let mut o = defaults();
    o[index_of("bias_diff_on").unwrap()] = 12;
    let mut back = defaults();
    assert!(parse(&write(&o), &mut back).is_empty());
    assert_eq!(back, o);
}
#[test]
fn parse_reads_metavision_format() {
    let mut o = vec![0; BIAS_TABLE.len()];
    parse("-5    % bias_fo\n", &mut o);
    assert_eq!(o[index_of("bias_fo").unwrap()], -5);
}
#[test]
fn parse_skips_junk_and_clamps() {
    let mut o = defaults();
    let w = parse("garbage\n3 % bias_nope\n99999 % bias_hpf\n", &mut o);
    assert_eq!(w.len(), 2);
    let i = index_of("bias_hpf").unwrap();
    assert_eq!(o[i], BIAS_TABLE[i].rec_max);
}
```

- [ ] **Step 4: Run `cargo test biases`.** Expected: FAIL to compile (functions missing).
- [ ] **Step 5: Implement the `src/biases.rs` functions** listed under Interfaces.
- [ ] **Step 6: Run `cargo test`.** Expected: all PASS.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat: crate scaffold, bias file read/write"`

### Task 2: Wire encoding and rate cap

**Files:**
- Create: `src/wire.rs`

**Interfaces:**
- Consumes: `libreeb::EventBatch` (SoA fields `x`, `y`, `p`, `t`)
- Produces:
  - `pub fn encode(batch: &EventBatch, keep: &[bool], t0_us: u64) -> Vec<u8>`: the binary message for the kept events. `t_us = (t - t0_us) as u32`.
  - `pub struct Decimator { budget: f64, rate: f64, rng: u64 }`
  - `pub fn Decimator::new(budget: f64) -> Self`
  - `pub fn Decimator::mask(&mut self, batch: &EventBatch) -> Vec<bool>`: updates `rate` from the batch's event count and time span (exponential smoothing with τ ≈ 0.25 s of sensor time), then keeps each event with probability `min(1, budget / rate)` using an inline xorshift64 (no `rand` dependency)
  - `pub fn Decimator::rate(&self) -> f64`

- [ ] **Step 1: Write the failing tests.**

```rust
#[test]
fn encode_layout_and_polarity_bit() {
    let mut b = EventBatch::new();
    b.push(1279, 719, 1_000_123, 1);
    b.push(3, 4, 1_000_200, 0);
    let m = encode(&b, &[true, true], 1_000_000);
    assert_eq!(u32::from_le_bytes(m[0..4].try_into().unwrap()), 2);
    assert_eq!(u16::from_le_bytes([m[4], m[5]]), 1279 | 0x8000);
    assert_eq!(u16::from_le_bytes([m[6], m[7]]), 719);
    assert_eq!(u32::from_le_bytes(m[8..12].try_into().unwrap()), 123);
    assert_eq!(u16::from_le_bytes([m[12], m[13]]), 3);
    assert_eq!(m.len(), 4 + 2 * 8);
}
#[test]
fn decimator_keeps_all_under_budget() { /* 1 M ev/s stream in 10 ms batches, budget 2 M: every mask is all true after warm-up */ }
#[test]
fn decimator_caps_burst() { /* 8 M ev/s for 1 s of sensor time in 1 ms batches, budget 2 M: kept count within 2 M ± 5 % */ }
```

Note: `EventBatch::push(x, y, t, p)` is the expected argument order. Check it against libreeb before writing.

- [ ] **Step 2: Run `cargo test wire`.** Expected: FAIL (missing).
- [ ] **Step 3: Implement `encode` and `Decimator`.**
- [ ] **Step 4: Run `cargo test wire`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: wire encoding and rate cap"`

### Task 3: Event sources (camera + file)

**Files:**
- Create: `src/source.rs`, adapted from the earlier camera code

**Interfaces:**
- Consumes: `biases::{parse, write, defaults, index_of, timestamp_name}`, `autobias::*`, `hotpix::*`
- Produces:
  - `pub enum SourceMsg { Geometry{w: u32, h: u32, sensor: String}, Batch(EventBatch), Info(String), Error(String), Dropped(u64), Afk(u32, u32), Biases(Vec<i32>), Recording(Option<PathBuf>), Ended }`. `Biases` carries the full offset vector, is sent at open, and is resent after every change (slider echo, auto-bias, load, reset).
  - `pub enum CameraCmd { Bias(usize, i32), BiasReset, BiasSave, BiasLoad(PathBuf), AutoBias(f32), AntiFlicker(Option<(u32, u32)>), CalibrateMask, Record(bool), Stop }`
  - `pub struct CameraInit { pub bias_offsets: Vec<i32>, pub antiflicker: Option<(u32, u32)> }`
  - `pub fn spawn_camera(tx: Sender<SourceMsg>, cmds: Receiver<CameraCmd>, init: CameraInit) -> JoinHandle<()>`
  - `pub fn spawn_file(tx: Sender<SourceMsg>, path: PathBuf, stop: Arc<AtomicBool>) -> JoinHandle<()>`
  - Keep `write_record`, `parse_records` and `RECORD_SIZE` as they are.

Changes from the earlier code:
- Drop `Taps`, `load_taps`, ROI (full sensor; call `cam.clear_roi()`) and the `speed` argument (always 1.0).
- `Record(true)` does `create_dir_all("recordings")`, opens `recordings/<timestamp_name>.bin`, writes `biases::write(&offsets)` to `<same>.bias`, and sends `Recording(Some(path))`. `Record(false)` flushes and sends `Recording(None)`.
- `BiasSave` does `create_dir_all("biases")`, writes `biases/<timestamp_name>.bias` and sends `Info` with the path.
- `BiasLoad(p)` reads the file, runs `biases::parse` into a copy of `offsets`, writes every bias, sends any warnings as `Info`, and sends `Biases`.
- `BiasReset` applies `biases::defaults()`.
- `spawn_file`: a `.raw` extension uses `libreeb::RawFileReader::new` with `set_slice_time(10_000)`. `Geometry` comes from `header.camera_geometry`. Batches are paced to sensor time like the `.bin` path. A `.bin` file sends `Geometry{w: 1280, h: 720}`; mark it `// shortcut: .bin has no header, assumes EVK4 HD; read a sidecar if other sensors appear`. The file thread sends `Biases(vec![])`, so the page hides the camera controls.

- [ ] **Step 1: Copy the `bin_file_roundtrip` test and add a failing test.**

```rust
#[test]
fn file_source_sends_geometry_then_batches_then_ended() {
    // write 3 records into a temp .bin, spawn_file, collect messages:
    // first is Geometry{w:1280,h:720,..}, then Biases(empty), ≥1 Batch with 3 events total, last is Ended
}
#[test]
fn missing_file_reports_error_then_ended() { /* spawn_file on a non-existent path: Error(..) then Ended */ }
```

- [ ] **Step 2: Run `cargo test source`.** Expected: FAIL.
- [ ] **Step 3: Implement the adapted `src/source.rs`** as described above.
- [ ] **Step 4: Run `cargo test`.** Expected: PASS.
- [ ] **Step 5: Manual check of the `.raw` path.** Run a 3-line scratch `main` or a test marked `#[ignore]` on a short `.raw` recording. Expected: `Geometry` with the header size, batches with increasing `t`, then `Ended`.
- [ ] **Step 6: Commit.** `git commit -am "feat: camera and file event sources with bias commands"`

### Task 4: Server, bridge and CLI

**Files:**
- Create: `src/server.rs`
- Modify: `src/main.rs` (CLI and wiring)
- Test: `tests/server.rs`

**Interfaces:**
- Consumes: `source::*`, `wire::{encode, Decimator}`, `BIAS_TABLE`
- Produces (the protocol the page relies on):
  - Server→page text JSON, tagged by `"type"`:
    - `{"type":"status","source":"camera"|"file","sensor":s,"width":w,"height":h,"rate_in":f,"rate_kept":f,"dropped_usb":n,"afk":[total,flicker]|null,"recording":path|null,"message":s|null,"error":s|null}`
    - `{"type":"biases","list":[{"name":s,"offset":i,"min":i,"max":i,"hint":s}]}`
    - `{"type":"bias_files","files":[s]}`
  - Page→server text JSON, `#[serde(tag="type", rename_all="snake_case")] enum Control`: `bias{name, offset}`, `bias_reset`, `bias_save`, `bias_load{file}` (a file name inside `biases/` only; reject any path separator), `list_bias_files`, `autobias{target}`, `antiflicker{on, lo_hz, hi_hz}`, `calibrate_hot_pixels`, `record{on}`
  - `pub struct Shared { pub events: broadcast::Sender<Bytes>, pub text: broadcast::Sender<String>, pub status: Mutex<String>, pub biases: Mutex<String>, pub cmds: Mutex<Option<std::sync::mpsc::Sender<CameraCmd>>> }`
  - `pub fn spawn_bridge(rx: Receiver<SourceMsg>, shared: Arc<Shared>, max_rate: f64) -> JoinHandle<()>`: a std thread. It runs the Decimator and `encode`, then `events.send` (ignoring "no receivers"). It updates the cached status/biases JSON and sends it on `text`, emitting status at most once per second plus immediately on Geometry/Error/Recording/Ended. `t0_us` is the first batch's first `t`. Batches are coalesced until ≥10 ms of sensor time or ≥1024 events.
  - `pub fn router(shared: Arc<Shared>, web_dir: PathBuf) -> axum::Router`: `/ws` and a fallback `ServeDir(web_dir)`. On connect it sends cached `status`, then `biases`, then forwards both broadcasts. On `RecvError::Lagged` it continues (skips). Control messages go to `cmds`.
  - `pub async fn serve(shared, web_dir, port) -> anyhow::Result<()>`

Broadcast capacities: events 64, text 64.

- [ ] **Step 1: Write the failing integration tests in `tests/server.rs`.** Each builds `Shared`, feeds a `spawn_file` on a temp `.bin` through `spawn_bridge`, serves `router` on port 0 and connects with `tokio-tungstenite`.

```rust
#[tokio::test] async fn first_messages_are_status_then_biases() { /* msg0 type=="status" width==1280; msg1 type=="biases"; a later binary msg has count>0 */ }
#[tokio::test] async fn reconnect_gets_status_and_biases_first() { /* connect, read 3 msgs, drop, reconnect: same first two types */ }
#[tokio::test] async fn missing_file_shows_error_in_status() { /* --file nope.bin: a status message has error != null; server still accepts connects */ }
#[test] fn lagged_client_does_not_block_bridge() { /* one subscriber that never reads, push 10_000 batches through the bridge: the bridge thread finishes (join) within 2 s */ }
#[test] fn bias_load_rejects_paths() { /* Control::BiasLoad{file:"../x.bias"} is refused: no CameraCmd is sent */ }
```

- [ ] **Step 2: Run `cargo test --test server`.** Expected: FAIL.
- [ ] **Step 3: Implement `src/server.rs`.**
- [ ] **Step 4: Implement the `src/main.rs` CLI** (hand-parsed `std::env::args`, no clap). Defaults: `web_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/web")`. `--biases` is applied through `biases::parse` into `CameraInit.bias_offsets`. With neither `--camera` nor `--file`, print usage and exit 2. Print `open http://127.0.0.1:<port>`.
- [ ] **Step 5: Run `cargo test`.** Expected: all PASS.
- [ ] **Step 6: Commit.** `git commit -am "feat: websocket server, bridge and CLI"`

### Task 5: Page — vendoring, wire parser, volume renderer

**Files:**
- Create: `web/vendor/three/three.module.js`, `web/vendor/three/three.core.js`. Fetch both from `https://cdn.jsdelivr.net/npm/three@0.186.0/build/` (r186).
- Create: `web/vendor/three/addons/…`. Fetch from `https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/`: `controls/OrbitControls.js`, `postprocessing/{EffectComposer,RenderPass,ShaderPass,MaskPass,Pass,UnrealBloomPass,OutputPass}.js`, `shaders/{CopyShader,LuminosityHighPassShader,OutputShader}.js`. Keep the relative paths. Their `import 'three'` resolves through the import map.
- Create: `web/vendor/lil-gui.esm.js` from `https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.js`
- Create: `web/index.html`, `web/wire.js`, `web/xyt_volume.js`, `web/main.js`, `web/style.css`, `web/test/wire.test.mjs`

**Interfaces:**
- Consumes: the Task 4 protocol
- Produces:
  - `wire.js`: `export function parseEvents(buf: ArrayBuffer): {count, x: Uint16Array, y: Uint16Array, p: Uint8Array, tUs: Uint32Array}`
  - `xyt_volume.js`: `export class XytVolume { constructor(scene, {capacity}); setSensor(w, h); push(ev) /* writes into the ring buffer, t = tUs/1e6 */; setNow(sec); clear(); uniforms /* uWindow, uDepth, uGamma, uK, uPointSize, uOnColor, uOffColor, uPixelRatio */; frame /* LineSegments for the now and back planes */ }`
  - `main.js`: renderer (`antialias: false`, `powerPreference: 'high-performance'`), scene background `#0F0F19`, a `PerspectiveCamera(40)`, OrbitControls with the default off-axis pose `position (1.4, 0.8, 1.6)`, `target (0, 0, -depth/2)`, composer `RenderPass → UnrealBloomPass(strength 0.9, radius 0.4, threshold 0.0) → OutputPass`, and a WebSocket with auto-reconnect every 1 s that routes binary messages to `volume.push` and JSON to `panel.onMessage`.

Shader rules (spec values):
- Plane coordinates: `x' = (x/w - 0.5)·(w/h)`, `y' = 0.5 - y/h`.
- `age = uNow - aT`. Discard (send off-clip) when `age < 0 || age > uWindow`. `z = -uDepth·pow(age/uWindow, uGamma)`.
- Fragment: a soft round sprite with core + `exp(-r²·20)` glow (as in the reference `xyt_event_plot.js`), colour `mix(uOff, uOn, aP)`, `alpha *= pow(1 - age/uWindow, uK)`, `AdditiveBlending`, `depthWrite: false`, `transparent: true`.
- Ring write: when `head + n` wraps, write two slices and register two `addUpdateRange` calls per attribute. Call `clearUpdateRanges()` after the frame.

Live clock (in `main.js`), per received batch, with `last = max tUs/1e6`:

```js
const target = last - performance.now() / 1000;
offset = offsetInit ? offset + 0.05 * (target - offset) : (offsetInit = true, target);
// per frame:
volume.setNow(performance.now() / 1000 + offset);
```

Reset `offsetInit` and `volume.clear()` when a `status` arrives with a different `source`/`width`, or when the socket reconnects.

Defaults: window 1.0 s, depth 3.0, γ 1.6, k 1.5, point size 2.0.

- [ ] **Step 1: Write the failing test `web/test/wire.test.mjs`** (`node:test`). Build the same 2-event buffer as Task 2's `encode_layout_and_polarity_bit` and assert `count 2, x [1279, 3], y [719, 4], p [1, 0], tUs [123, 200]`.
- [ ] **Step 2: Run `node --test web/test/`.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `web/wire.js`.** Use `DataView` reads in LE. Mask `x & 0x7fff` and set `p = x >> 15`.
- [ ] **Step 4: Run `node --test web/test/`.** Expected: PASS.
- [ ] **Step 5: Vendor three/addons/lil-gui and write `index.html`** with the import map `{"three": "./vendor/three/three.module.js", "three/addons/": "./vendor/three/addons/"}`, then implement `xyt_volume.js` and `main.js`.
- [ ] **Step 6: Visual check.** Record a short `.bin` (or use any existing recording). Run `cargo run --release -- --file <it>` and open the page. Expected: a pink/cyan glowing volume with the now-plane at the front, history receding off-axis and fading, no console errors, and 60 fps in the devtools FPS meter.
- [ ] **Step 7: Commit.** `git add web && git commit -m "feat: three.js XYT volume page"`

### Task 6: Control panel

**Files:**
- Create: `web/panel.js`
- Modify: `web/main.js` (wire up the panel)

**Interfaces:**
- Consumes: `XytVolume.uniforms`, the bloom pass, the Task 4 protocol
- Produces: `export class Panel { constructor({volume, bloom, controls, send}); onMessage(msg) }`

Contents (lil-gui folders):
- **Look:** window (0.1–2 s), depth (0.5–8), γ (0.5–3), k (0.2–4), point size (0.5–8), bloom strength/radius/threshold, ON/OFF/background colours, frame on/off, **Reset view**.
  - Persist to `localStorage['emv.look']` in try/catch, plus the camera pose on OrbitControls `end`.
- **Camera** (hidden when `biases.list` is empty):
  - anti-flicker on, with lo/hi Hz (defaults 90/110).
  - One slider per `biases.list` entry, range `min..max`, the `hint` as its title. On change it sends `bias`. On an incoming `biases` message, update the values without re-sending.
  - **Auto-bias** (target ev/s/px input, default 1.0).
  - **Recalibrate hot pixels**.
  - **Save biases**, and **Load biases** (a dropdown filled from `bias_files`; `list_bias_files` is sent when the folder opens).
  - **Reset biases**.
  - **Record** toggle, showing the path while recording.
- **Status line** (a fixed DOM element, not lil-gui): `sensor · in X Mev/s · kept Y Mev/s · USB drops N · ● REC`, or the error in red.
- Keys: `H` toggles panel + status + cursor; `F` toggles `requestFullscreen`.

- [ ] **Step 1: Implement `web/panel.js` and wire it into `main.js`.**
- [ ] **Step 2: Visual check, file mode.** The Camera folder is hidden. Look sliders change the view live and survive a reload. `H` hides all UI.
- [ ] **Step 3: Commit.** `git commit -am "feat: control panel with look, bias and camera controls"`

### Task 7: Live acceptance with the EVK4 and README

**Files:**
- Create: `README.md` (run commands, keys, file locations)

- [ ] **Step 1: Run `cargo run --release -- --camera`** with the EVK4 plugged in. Expected: the status shows the sensor name and rate, and sliders appear for all 6 biases.
- [ ] **Step 2: Move a bias slider.** Expected: the event rate changes within 1 s. **Save biases** creates a file in `biases/`. **Load** of that file restores the sliders. **Reset** returns the defaults.
- [ ] **Step 3: Flicker check.** In a flickering room, turn anti-flicker on and do fast full-body motion for 30 s. Expected: page at 60 fps, `USB drops` stays 0, and `kept` ≤ 2 M ev/s.
- [ ] **Step 4: Record about 10 s**, then run `cargo run --release -- --file recordings/<it>.bin`. Expected: replay looks like live, and `<it>.bias` exists beside the recording.
- [ ] **Step 5: Write `README.md` and commit.** `git add README.md && git commit -m "docs: README with run instructions"`
