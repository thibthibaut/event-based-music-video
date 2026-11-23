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

See `docs/superpowers/specs/2026-11-23-xyt-music-video-design.md`. Phase 2 (soundtrack FFT,
music-driven effects, frame-exact offline export) is not built yet.
