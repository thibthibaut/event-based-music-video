# Audio-reactive scenes (phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The page plays a song, analyses it every frame, and drives 8 shader/CPU effects on the event volume. Keys `0`–`9` crossfade between scenes, which are sets of effect weights.

**Architecture:** Page-only work. A Web Audio `AnalyserNode` feeds a pure `Features` class (bands, auto-gain, beat, log spectrum). The log spectrum is written each frame into a 256×128 history texture keyed on sensor time. A pure `SceneMixer` crossfades 8 weights. `main.js` pushes features and weights into uniforms each frame. Six effects live in the `XytVolume` shader; background and camera are per-frame CPU updates.

**Tech Stack:** three.js r186 (vendored), lil-gui 0.20.0 (vendored), Web Audio API, `node --test` for the pure modules. No server changes.

**Spec:** `docs/superpowers/specs/2026-11-23-audio-scenes-design.md`

## Global Constraints

- No server or wire-protocol changes. No extra render passes. No per-event JS work.
- Effect order and names (index = weight slot): `0 jitter, 1 fountain, 2 palette, 3 background, 4 camera, 5 pump, 6 shockwave, 7 twist`.
- Bands: bass 20–150 Hz, mid 150–2000 Hz, treble 2000–12000 Hz. Auto-gain peak τ 3 s, floor 1e-3.
- Beat: flux > mean + 1.5·std over the last 1 s, 250 ms refractory, envelope τ 0.15 s. `lastBeatT` is in sensor seconds (`uNow`).
- Log spectrum: 256 bins, 30 Hz – 16 kHz. History: 256 × 128 texture, `ROW_S = 2/128` s, `row(t) = floor(t/ROW_S) mod 128`.
- Analyser: `fftSize 2048`, `smoothingTimeConstant 0.5`.
- Scenes: key `0` = plain (all 0), `1`–`9` = stored scenes. Fade τ default 0.4 s (slider 0.05–3). Stored in `localStorage['emv.scenes']`.
- Keys: ignore while an `INPUT`/`SELECT`/`TEXTAREA` has focus. `Space` play/pause, `H` hide UI, `F` full screen.
- Every scene must render with no audio loaded (levels 0).

## Review Focus

1. **Silence, or no audio loaded:** auto-gain must not blow noise up to 1.0, and there must be no NaN from dividing by a zero peak. → Task 1 test `silence_stays_zero`.
2. **Key pressed mid-fade, or the same key repeated:** no jump in weights. → Task 2 test `retarget_mid_fade_is_continuous`.
3. **Corrupt or old `emv.scenes` in localStorage** (wrong length, strings, `null`): falls back to the defaults and does not crash. → Task 2 test `load_rejects_bad_shapes`.
4. **Frame hitch, a backgrounded tab, or a stream reconnect** (a large jump in `uNow` or a negative `t`): the history fill is capped at 128 rows, with no huge loop and no negative row index. → Task 3 tests `fill_caps_at_ring_size`, `row_of_negative_time`.
5. **Typing in a lil-gui number field** must not switch scenes or toggle play. → Task 5 manual check, step 4.

---

### Task 1: Audio features (`web/features.js`)

**Files:**
- Create: `web/features.js`, `web/test/features.test.mjs`

**Interfaces:**
- Produces:
  - `export const LOG_BINS = 256, LOG_F_LO = 30, LOG_F_HI = 16000`
  - `export function binRange(fLo, fHi, sampleRate, fftSize) -> [i0, i1]`: analyser bin indices, half-open, clamped to `[0, fftSize/2]`, with at least 1 bin
  - `export class Features { constructor({ sampleRate, fftSize }); update(bins: Uint8Array, dt: number, now: number): void; bass; mid; treble; beat; lastBeatT; logSpec: Uint8Array(256) }`. `bass/mid/treble/beat` are in 0–1. `lastBeatT` starts at `-1e9`. `now` is sensor seconds.

- [ ] **Step 1: Write the failing tests.** Use helpers that build a `Uint8Array(1024)` with energy in a given Hz range (`sampleRate 48000`, `fftSize 2048`).
  - `bass_only_spectrum_reads_bass`: after 30 updates (`dt` 1/60) of bass-only energy → `bass > 0.9`, `mid < 0.05`, `treble < 0.05`.
  - `silence_stays_zero`: 120 updates of all zeros → `bass`, `mid`, `treble` and `beat` are all 0 and `Number.isFinite` holds.
  - `auto_gain_follows_quieter_track`: 120 frames at level 200, then 600 frames at 50 → `bass > 0.8` at the end.
  - `beats_on_kick_train`: 4 s at 60 fps, bass 220 for 3 frames every 0.5 s and 20 otherwise → beat count (rising edges of `beat === 1`) is 7–8 (the first can be missed while the stats warm up).
  - `no_beats_on_constant_level`: 4 s of constant bass 150 → 0 beats.
  - `refractory_blocks_double_beats`: kicks every 0.1 s for 2 s → at most 8 beats.
  - `beat_sets_last_beat_time`: the `now` passed on the beat frame equals `lastBeatT`.
  - `log_spectrum_covers_range`: energy only at 30–40 Hz lights `logSpec[0]`; only at 15–16 kHz lights `logSpec[255]`.
- [ ] **Step 2: Run `node --test web/test/features.test.mjs`.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `web/features.js`** with the constants in Global Constraints.
  - Auto-gain: `peak = max(level, peak·exp(-dt/3))`, `out = peak > 1e-3 ? level/peak : 0`, with levels in 0–1 (bin mean / 255).
  - Beat flux history: a ring of the last 1 s of `(t, flux)`.
  - Log bin `k` covers `f = LO·(HI/LO)^(k/256)` to `(k+1)/256` and takes the max of its analyser bins (at least one).
- [ ] **Step 4: Run `node --test web/test/features.test.mjs`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add web/features.js web/test/features.test.mjs && git commit -m "feat: audio band, beat and log-spectrum features"`

### Task 2: Scenes and crossfade (`web/scenes.js`)

**Files:**
- Create: `web/scenes.js`, `web/test/scenes.test.mjs`

**Interfaces:**
- Produces:
  - `export const EFFECTS = ['jitter', 'fountain', 'palette', 'background', 'camera', 'pump', 'shockwave', 'twist']`
  - `export function defaultScenes() -> Array<{ name: string, w: number[8] }>`: length 10, index 0 = `{ name: 'plain', w: all 0 }`, 1–9 as named in the spec
  - `export function loadScenes(json: string | null) -> scenes`: validates length 10, each `w` is 8 finite numbers in 0–1 and `name` is a string; otherwise returns `defaultScenes()`
  - `export function sceneForKey(key: string) -> number | null`: `'0'`–`'9'` map to 0–9, anything else to `null`
  - `export class SceneMixer { constructor(scenes); select(i: number); step(dt: number, fadeS: number) -> Float32Array(8); active: number; current: Float32Array(8) }`. `step` moves `current` toward `scenes[active].w` by `1 - exp(-dt/fadeS)`. Starts on scene 0 with `current` = 0.

- [ ] **Step 1: Write the failing tests.**
  - `default_scenes_shape`: 10 scenes, scene 0 all zeros, every weight in 0–1.
  - `key_mapping`: `'3'` → 3, `'0'` → 0, `'a'` → null, `' '` → null.
  - `fade_converges_monotonically`: select 2, step 60× at 1/60 with fade 0.4. Each weight moves monotonically toward its target and ends within 0.02 of it.
  - `retarget_mid_fade_is_continuous`: select 2, 10 steps, then select 5. The first step after the switch changes no weight by more than `1 - exp(-dt/fade)` times the distance to the target.
  - `zero_fade_snaps_safely`: `step(1/60, 0)` gives the exact target with no NaN.
  - `load_rejects_bad_shapes`: `null`, `'nope'`, `'[]'`, 10 scenes with one `w` of length 7, and a weight `'x'` all give the defaults. A valid round-trip of `JSON.stringify(defaultScenes())` with one weight changed keeps the change.
- [ ] **Step 2: Run `node --test web/test/scenes.test.mjs`.** Expected: FAIL.
- [ ] **Step 3: Implement `web/scenes.js`.** Default weights are starting values; Task 5 tunes them.
- [ ] **Step 4: Run `node --test web/test/scenes.test.mjs`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat: scenes with crossfade mixer"` (add the new files first).

### Task 3: Spectrum history (`web/spectrum_history.js`)

**Files:**
- Create: `web/spectrum_history.js`, `web/test/spectrum_history.test.mjs`

**Interfaces:**
- Consumes: `LOG_BINS` from Task 1
- Produces:
  - `export const ROWS = 128, ROW_S = 2 / 128`
  - `export function rowOf(t: number) -> number`: always 0–127, also for negative `t`
  - `export function rowsToFill(lastAbs: number | null, nowAbs: number) -> number[]`: the ring rows to write for absolute row indices `(lastAbs, nowAbs]`. When `lastAbs` is null it returns `[nowAbs mod R]`. At most `ROWS` entries. Empty when `nowAbs <= lastAbs`.
  - `export class SpectrumHistory { constructor(THREE); texture; write(nowS: number, logSpec: Uint8Array): void; reset(): void }`. Takes `THREE` as an argument so the module imports in node without three. `texture` is a `DataTexture(256×128, RedFormat, UnsignedByteType)` with `LinearFilter` and `wrapT = RepeatWrapping`. `write` uploads the touched rows via `texture.addUpdateRange` (row-aligned) and sets `needsUpdate`.

- [ ] **Step 1: Write the failing tests.**
  - `row_of_wraps`: `rowOf(0) === 0`, `rowOf(ROW_S * 128) === 0`, `rowOf(ROW_S * 129.5) === 1`.
  - `row_of_negative_time`: `rowOf(-ROW_S * 0.5) === 127`.
  - `fill_consecutive`: `rowsToFill(10, 13)` gives `[11, 12, 13]` (mod 128).
  - `fill_caps_at_ring_size`: `rowsToFill(0, 10_000).length === 128`.
  - `fill_none_backwards`: `rowsToFill(50, 40)` gives `[]`.
  - `history_write_marks_rows`: use a minimal fake `THREE` exposing `DataTexture`, `RedFormat`, `UnsignedByteType` and `LinearFilter` with a plain image array. Writing at `t=0` and then `t = 3·ROW_S` sets rows 1–3 to the given spectrum.
- [ ] **Step 2: Run `node --test web/test/spectrum_history.test.mjs`.** Expected: FAIL.
- [ ] **Step 3: Implement `web/spectrum_history.js`.**
- [ ] **Step 4: Run `node --test web/test/*.test.mjs`.** Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: spectrum history texture keyed on sensor time"` (after `git add`).

### Task 4: Audio playback, analysis wiring, Audio panel

**Files:**
- Create: `web/audio.js`
- Modify: `web/main.js`, `web/panel.js`, `web/index.html` (hidden file input), `web/style.css` (meters)
- Test: manual (Web Audio is not available in node)

**Interfaces:**
- Consumes: `Features` (Task 1), `SpectrumHistory` (Task 3)
- Produces:
  - `export class AudioPlayer { load(file: File): Promise<void>; toggle(): void; playing: boolean; name: string; volume: number /* setter */; bins(): Uint8Array | null /* null until loaded */; sampleRate; fftSize }`
  - In `main.js`, each frame (in this order) when `offset !== null`:
    1. `features.update(audio.bins() ?? ZERO_BINS, dt, uNow)`
    2. `history.write(uNow, features.logSpec)`
    3. set `uBass, uMid, uTreble, uBeat, uLastBeatT, uTime` on the volume.
  - The panel's Audio folder: **Load…**, play/pause, volume (0–1), file name, and three meter bars driven from `features` (DOM, updated each frame).
  - `Space` → `audio.toggle()`, unless a form field has focus.
  - Reset `history` on `resetStream()`.

- [ ] **Step 1: Generate the test track** into the scratchpad (not the repo): `ffmpeg -f lavfi` mixing a 120 BPM kick (a short 55 Hz sine burst every 0.5 s), a 110 Hz bass, and a hi-hat (high-passed noise burst every 0.25 s), 30 s, saved as `test-120bpm.wav`.
- [ ] **Step 2: Implement `audio.js`, the wiring, and the Audio folder.** Add the uniforms (`uBass…uTime`, `uSpec`) to `XytVolume` with no shader use yet.
- [ ] **Step 3: Manual check.** Run `cargo run --release -- --camera`, open the page, load the test track and press Space. Expected: you hear the audio; the bass meter pulses at 2 Hz; treble at 4 Hz; no console errors. Add a temporary `console.count('beat')` to confirm about 2 beats/s, then remove it.
- [ ] **Step 4: Run `node --test web/test/*.test.mjs`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: audio playback and analysis wired to the volume"` (after `git add`).

### Task 5: Effects, scene keys, Scenes panel, overlay

**Files:**
- Modify: `web/xyt_volume.js` (effect uniforms `uW: float[8]`, `uSpec`; the shader effects from the spec table rows 1, 2, 3, 6, 7, 8), `web/main.js` (SceneMixer, keys, CPU effects rows 4 and 5, overlay), `web/panel.js` (Scenes folder), `web/style.css` (overlay)

**Interfaces:**
- Consumes: `EFFECTS`, `defaultScenes`, `loadScenes`, `sceneForKey`, `SceneMixer` (Task 2), `history.texture` (Task 3), the feature uniforms (Task 4)
- Produces:
  - `volume.uniforms.uW.value: number[8]`, set each frame from `mixer.step(dt, fade)`.
  - Panel Scenes folder: the active scene label, 8 weight sliders bound to `scenes[mixer.active].w` (rebound on switch; edits save to localStorage), the fade slider, and **Reset scenes**.
  - Keys: `sceneForKey(e.key)` → `mixer.select(i)` and show the overlay `"<n> · <name>"` for 1 s (hidden under `body.clean`).

Shader notes:
- Fountain bin for column x: `logBin = clamp(log(f(x))…)`. Simplest: map x linearly across the 256 log bins (`x / width`), so the left edge is bass. Sample with `texture(uSpec, vec2(bin, (rowOf(aT) + 0.5)/128.0))`.
- Camera effect (CPU): add a decaying shake offset to `camera.position` after `controls.update()`, and remove it before the next `controls.update()`, so OrbitControls never accumulates it.
- Background (CPU): `scene.background.copy(base).lerp(accent, k)` each frame, where `base` comes from the panel's look colour.

- [ ] **Step 1: Implement the shader effects and uniforms.** Then run with `--camera` and screenshot each effect alone at weight 1 with the test track playing. Use headless Chrome as in phase 1, or your eyes in a real browser. Expected: each effect is visible and distinct, and weight 0 looks identical to phase 1.
- [ ] **Step 2: Implement the CPU effects, SceneMixer, keys, overlay and Scenes panel.**
- [ ] **Step 3: Tune the default scene weights and effect constants by eye** with the test track. Update `defaultScenes()`, then run `node --test web/test/*.test.mjs` (still PASS, all weights in 0–1).
- [ ] **Step 4: Manual key checks.**
  - Expected: `1`–`9` crossfade smoothly with no pop.
  - Pressing `4` then `7` quickly retargets smoothly.
  - `0` returns to plain.
  - Typing digits into a lil-gui number field does not switch scenes. Space in that field does not toggle play.
  - Reloading the page keeps edited scenes.
- [ ] **Step 5: Commit.** `git commit -m "feat: audio-driven effects and live scene keys"` (after `git add`).

### Task 6: README and live acceptance

**Files:**
- Modify: `README.md` (Audio and scene keys sections)

- [ ] **Step 1: Live check.** Use `--camera` with the test track and run through scenes 1–9 for 60 s while moving in front of the camera. Expected: no console errors, `USB drops` steady, every scene reacts to the beat.
- [ ] **Step 2: Update the README** with the keys (`0`–`9`, Space, H, F), the Audio and Scenes folders, and the note that OBS records the page audio.
- [ ] **Step 3: Run `cargo test && node --test web/test/*.test.mjs`.** Expected: all PASS.
- [ ] **Step 4: Commit.** `git commit -am "docs: audio and scene keys in README"`
