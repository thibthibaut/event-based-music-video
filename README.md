# event-music-video

Live x-y-t volume of event-camera (Prophesee EVK4) data, for making a music video.
The newest events sit on the "now" plane at their sensor x,y. Older events slide back in
depth, speeding up and fading as they go.

A Rust server reads the camera (or a recording) with [libreeb](../libreeb), caps the rate,
and streams events over a WebSocket to a three.js page.

## Run

```sh
cargo run --release -- --camera                          # live EVK4
cargo run --release -- --file recordings/<take>.bin      # replay (.bin or .raw)
```

Then open <http://127.0.0.1:8080>. A recent Chrome or Firefox works; the page needs WebGL2.

| Option | Default | |
|---|---|---|
| `--biases <file.bias>` | libreeb defaults | biases applied when the camera opens |
| `--max-rate <ev/s>` | `2000000` | events/s sent to the page; extra events are dropped at random |
| `--port <n>` | `8080` | HTTP/WebSocket port on 127.0.0.1 |

The camera starts with the hardware anti-flicker filter on, set to 90–110 Hz (for 50 Hz mains
lighting). In a 60 Hz country, change the band to 110–130 Hz in the panel.

## Page

- **H** hides the panel, the status line and the cursor, for clean capture. **F** toggles full screen.
- **R** auto-rotates around the cube. **M** glides to the flat view: the now-plane fills the screen
  and history recedes as a tunnel. Press M again to glide back.
- **P** / **O** (hold) dolly-zoom: more or less perspective, while the now-plane keeps its size.
- The panel's **Keys** folder lists every shortcut.
- Drag to orbit, scroll to zoom. The view and the **Look** settings are saved in the browser.
- **Look:** time window, depth, speed ramp γ (`z = -depth·(age/window)^γ`), fade k
  (`alpha·(1-age/window)^k`), point size, intensity, bloom, colours, frame.
- **Camera** (live only):
  - anti-flicker band
  - the six bias sliders
  - auto-bias to a target event rate per pixel
  - hot-pixel recalibration
  - save, load and reset biases
  - record

## Music and scenes

- **Audio** folder: **Load…** an mp3/wav, then press **Space** (or the button) to play or pause.
  The song plays from the page, so OBS records the picture and the sound in sync (capture the
  desktop or browser audio). The three bars at the bottom right show the bass, mid and treble.
- Keys **1**–**9** crossfade to a scene, and **0** returns to the plain volume.
  The scenes are:
  1. jitter sparkle
  2. fountain
  3. palette + background
  4. shockwave
  5. twist tunnel
  6. pump fountain
  7. all-in
  8. calm drift
  9. chaos
- A scene mixes eight effects, each with a 0–1 weight:
  - jitter (treble)
  - fountain: each column lifts by its frequency, and older events keep their lift
  - palette: slow hue drift
  - background: slow colour drift (never pulses with the music)
  - camera shake on beats, plus an orbit drift
  - time pump (bass)
  - shockwave: events born on a beat burst outward
  - twist (mids)
- The **Scenes** folder edits the active scene's weights live and sets the crossfade time.
  Scenes are saved in the browser. **Reset scenes** restores the defaults.
- The camera effect drifts the view. **Look → Reset view** brings it back.
- Keys are ignored while a panel field has focus.

## Files

- `recordings/<timestamp>.bin`: a recorded take (13-byte records `u16 x, u16 y, u8 p, u64 t_us`).
  The biases used for the take are saved beside it as `<timestamp>.bias`.
- `biases/<timestamp>.bias`: saved biases, in the Metavision `<offset> % <name>` format.

## Test

```sh
cargo test
node --test web/test/*.test.mjs
```

## Design

See `docs/superpowers/specs/2026-11-23-xyt-music-video-design.md`. Music and scenes: `docs/superpowers/specs/2026-11-23-audio-scenes-design.md`. A frame-exact
offline export is not built yet.
