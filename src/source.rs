//! Event sources on their own thread: live EVK4 or a recording (`.bin` or `.raw`).
//!
//! `.bin` format: packed little-endian records `<u16 x, u16 y, u8 p, u64 t_us>`, 13 bytes each.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use libreeb::biases::BIAS_TABLE;
use libreeb::io::camera::PIXEL_MASK_SLOTS;
use libreeb::{CameraReader, EventBatch, RawFileReader};

use crate::autobias::{next_offset, trimmed_mean};
use crate::biases;
use crate::hotpix::hot_pixels;

const AUTO_SETTLE: Duration = Duration::from_millis(300);
const AUTO_MEASURE: Duration = Duration::from_secs(1);
const AUTO_MAX_ITERS: u32 = 12;
pub const RECORD_SIZE: usize = 13;

pub enum SourceMsg {
    /// Sent first: sensor size and name.
    Geometry { w: u32, h: u32, sensor: String },
    Batch(EventBatch),
    Info(String),
    Error(String),
    /// Host-side dropped USB buffers so far (camera only).
    Dropped(u64),
    /// Anti-flicker band now active (Hz), or off.
    AntiFlicker(Option<(u32, u32)>),
    /// Anti-flicker counters since enable: (events seen, events dropped as flicker).
    Afk(u32, u32),
    /// Full offset vector per `BIAS_TABLE` entry; empty for a file source.
    Biases(Vec<i32>),
    /// Recording started (path of the `.bin`) or stopped.
    Recording(Option<PathBuf>),
    Ended,
}

pub enum CameraCmd {
    /// (BIAS_TABLE index, offset from factory default).
    Bias(usize, i32),
    BiasReset,
    BiasSave,
    BiasLoad(PathBuf),
    /// Tune bias_diff_on/off to this many events/s per pixel, per polarity.
    AutoBias(f32),
    /// Hardware anti-flicker band-stop (Hz) or off.
    AntiFlicker(Option<(u32, u32)>),
    CalibrateMask,
    Record(bool),
    Stop,
}

pub struct CameraInit {
    /// Offset per BIAS_TABLE entry.
    pub bias_offsets: Vec<i32>,
    pub antiflicker: Option<(u32, u32)>,
}

/// Auto-bias state: settle after each write, then count per-pixel ON/OFF events.
struct AutoBias {
    target: f32,
    iter: u32,
    started: Instant,
    on: Vec<u32>,
    off: Vec<u32>,
}

pub fn write_record(w: &mut impl Write, x: u16, y: u16, p: u8, t: u64) -> std::io::Result<()> {
    let mut r = [0u8; RECORD_SIZE];
    r[0..2].copy_from_slice(&x.to_le_bytes());
    r[2..4].copy_from_slice(&y.to_le_bytes());
    r[4] = p;
    r[5..13].copy_from_slice(&t.to_le_bytes());
    w.write_all(&r)
}

/// Parse whole records; a trailing partial record is ignored.
pub fn parse_records(bytes: &[u8]) -> EventBatch {
    let mut b = EventBatch::with_capacity(bytes.len() / RECORD_SIZE);
    for r in bytes.chunks_exact(RECORD_SIZE) {
        let x = u16::from_le_bytes([r[0], r[1]]);
        let y = u16::from_le_bytes([r[2], r[3]]);
        let t = u64::from_le_bytes(r[5..13].try_into().unwrap());
        b.push(x, y, t, r[4]);
    }
    b
}

/// Sleeps so batches leave at sensor-time pace.
struct Pacer {
    start: Instant,
    t0: Option<u64>,
}

impl Pacer {
    fn new() -> Self {
        Self { start: Instant::now(), t0: None }
    }

    fn wait_for(&mut self, t_us: u64) {
        let t0 = *self.t0.get_or_insert(t_us);
        let due = Duration::from_micros(t_us.saturating_sub(t0));
        if let Some(wait) = due.checked_sub(self.start.elapsed()) {
            std::thread::sleep(wait);
        }
    }
}

/// Replay a recording (`.raw` via libreeb, anything else as `.bin`) at real-time pace.
pub fn spawn_file(tx: Sender<SourceMsg>, path: PathBuf, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let res = if path.extension().is_some_and(|e| e == "raw") {
            replay_raw(&tx, &path, &stop)
        } else {
            replay_bin(&tx, &path, &stop)
        };
        if let Err(e) = res {
            let _ = tx.send(SourceMsg::Error(format!("{}: {e:#}", path.display())));
        }
        let _ = tx.send(SourceMsg::Ended);
    })
}

fn replay_raw(tx: &Sender<SourceMsg>, path: &Path, stop: &AtomicBool) -> anyhow::Result<()> {
    let mut rd = RawFileReader::new(path)?;
    if rd.needs_geometry_scan() {
        rd.scan_geometry(100);
        rd.reset();
    }
    let g = rd.header.camera_geometry;
    let _ = tx.send(SourceMsg::Geometry { w: g.width, h: g.height, sensor: "file".into() });
    let _ = tx.send(SourceMsg::Biases(vec![]));
    rd.decoder().set_slice_by(libreeb::SliceBy::Time(10_000));
    let mut pacer = Pacer::new();
    for batch in rd.decoder() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let Some(&last) = batch.t.last() else { continue };
        pacer.wait_for(last);
        if tx.send(SourceMsg::Batch(batch)).is_err() {
            break;
        }
    }
    Ok(())
}

fn replay_bin(tx: &Sender<SourceMsg>, path: &Path, stop: &AtomicBool) -> anyhow::Result<()> {
    let f = File::open(path)?;
    // shortcut: .bin has no header, assumes EVK4 HD; read a sidecar if other sensors appear
    let _ = tx.send(SourceMsg::Geometry { w: 1280, h: 720, sensor: "file".into() });
    let _ = tx.send(SourceMsg::Biases(vec![]));
    let mut rd = BufReader::with_capacity(1 << 20, f);
    let mut buf = vec![0u8; RECORD_SIZE * 8192];
    let mut pacer = Pacer::new();
    let (mut wrap, mut prev) = (0u64, 0u64);
    while !stop.load(Ordering::Relaxed) {
        let n = read_full(&mut rd, &mut buf)?;
        if n == 0 {
            break;
        }
        let mut batch = parse_records(&buf[..n - n % RECORD_SIZE]);
        // Old recordings may contain missed EVT3 wraps (2^24 µs back-jumps).
        for t in batch.t.iter_mut() {
            if *t + wrap + 1_000_000 < prev {
                wrap += 1 << 24;
            }
            *t += wrap;
            prev = prev.max(*t);
        }
        let Some(&last) = batch.t.last() else { continue };
        pacer.wait_for(last);
        if tx.send(SourceMsg::Batch(batch)).is_err() {
            break;
        }
    }
    Ok(())
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// Apply the anti-flicker setting; failures are reported, not fatal.
fn set_afk(cam: &CameraReader, tx: &Sender<SourceMsg>, band: Option<(u32, u32)>) -> bool {
    match cam.set_antiflicker(band) {
        Ok(()) => {
            let msg = band.map_or("anti-flicker off".into(), |(lo, hi)| format!("anti-flicker {lo}-{hi} Hz"));
            let _ = tx.send(SourceMsg::Info(msg));
            let _ = tx.send(SourceMsg::AntiFlicker(band));
            band.is_some()
        }
        Err(e) => {
            let _ = tx.send(SourceMsg::Error(format!("anti-flicker: {e:#}")));
            false
        }
    }
}

fn write_all_biases(cam: &CameraReader, offsets: &[i32]) -> anyhow::Result<()> {
    for (i, b) in BIAS_TABLE.iter().enumerate() {
        cam.write_bias(b.addr, cam.bias_default(i), offsets[i])?;
    }
    Ok(())
}

fn bias_index(name: &str) -> usize {
    biases::index_of(name).expect("bias in BIAS_TABLE")
}

/// Open the first EVK4, configure it, and stream until `Stop` or channel close.
pub fn spawn_camera(tx: Sender<SourceMsg>, cmds: Receiver<CameraCmd>, init: CameraInit) -> JoinHandle<()> {
    std::thread::spawn(move || {
        if let Err(e) = run_camera(&tx, &cmds, init) {
            let _ = tx.send(SourceMsg::Error(format!("camera: {e:#}")));
        }
        let _ = tx.send(SourceMsg::Ended);
    })
}

fn run_camera(tx: &Sender<SourceMsg>, cmds: &Receiver<CameraCmd>, init: CameraInit) -> anyhow::Result<()> {
    let mut cam = CameraReader::open()?;
    let mut offsets = init.bias_offsets;
    write_all_biases(&cam, &offsets)?;
    let (i_on, i_off) = (bias_index("bias_diff_on"), bias_index("bias_diff_off"));
    let (w, h) = (cam.width() as usize, cam.height() as usize);
    let n_px = w * h;
    // Full-sensor window: libreeb clear_roi() stops all output on the IMX646 (measured 2026-11-23).
    cam.set_roi(0, 0, w as u32 - 1, h as u32 - 1)?;
    let mut afk_on = set_afk(&cam, tx, init.antiflicker);
    let _ = tx.send(SourceMsg::Geometry { w: w as u32, h: h as u32, sensor: cam.sensor_name().to_string() });
    let _ = tx.send(SourceMsg::Biases(offsets.clone()));

    let mut auto: Option<AutoBias> = None;
    let mut calib: Option<(Instant, Vec<u32>)> = Some((Instant::now(), vec![0; n_px]));
    let mut rec: Option<BufWriter<File>> = None;
    let mut last_stats = Instant::now();
    loop {
        match cmds.try_recv() {
            Ok(CameraCmd::Bias(i, off)) if i < offsets.len() => {
                let b = &BIAS_TABLE[i];
                offsets[i] = off.clamp(b.rec_min, b.rec_max);
                cam.write_bias(b.addr, cam.bias_default(i), offsets[i])?;
                let _ = tx.send(SourceMsg::Biases(offsets.clone()));
            }
            Ok(CameraCmd::Bias(..)) => {}
            Ok(CameraCmd::BiasReset) => {
                offsets = biases::defaults();
                write_all_biases(&cam, &offsets)?;
                let _ = tx.send(SourceMsg::Biases(offsets.clone()));
                let _ = tx.send(SourceMsg::Info("biases reset to defaults".into()));
            }
            Ok(CameraCmd::BiasSave) => {
                let p = PathBuf::from("biases").join(format!("{}.bias", biases::timestamp_name(SystemTime::now())));
                let res = std::fs::create_dir_all("biases").and_then(|_| std::fs::write(&p, biases::write(&offsets)));
                let _ = tx.send(match res {
                    Ok(()) => SourceMsg::Info(format!("saved {}", p.display())),
                    Err(e) => SourceMsg::Error(format!("save {}: {e}", p.display())),
                });
            }
            Ok(CameraCmd::BiasLoad(p)) => match std::fs::read_to_string(&p) {
                Ok(text) => {
                    for w in biases::parse(&text, &mut offsets) {
                        let _ = tx.send(SourceMsg::Info(w));
                    }
                    write_all_biases(&cam, &offsets)?;
                    let _ = tx.send(SourceMsg::Biases(offsets.clone()));
                    let _ = tx.send(SourceMsg::Info(format!("loaded {}", p.display())));
                }
                Err(e) => {
                    let _ = tx.send(SourceMsg::Error(format!("load {}: {e}", p.display())));
                }
            },
            Ok(CameraCmd::AutoBias(target)) => {
                auto = Some(AutoBias { target, iter: 0, started: Instant::now(), on: vec![0; n_px], off: vec![0; n_px] });
                calib = None;
                let _ = tx.send(SourceMsg::Info(format!("auto bias: target {target} ev/s/px per polarity")));
            }
            Ok(CameraCmd::AntiFlicker(band)) => afk_on = set_afk(&cam, tx, band),
            Ok(CameraCmd::CalibrateMask) => calib = Some((Instant::now(), vec![0; n_px])),
            Ok(CameraCmd::Record(true)) if rec.is_none() => {
                std::fs::create_dir_all("recordings")?;
                let stem = biases::timestamp_name(SystemTime::now());
                let p = PathBuf::from("recordings").join(format!("{stem}.bin"));
                std::fs::write(p.with_extension("bias"), biases::write(&offsets))?;
                rec = Some(BufWriter::with_capacity(1 << 22, File::create(&p)?));
                let _ = tx.send(SourceMsg::Recording(Some(p)));
            }
            Ok(CameraCmd::Record(true)) => {}
            Ok(CameraCmd::Record(false)) => {
                if let Some(mut r) = rec.take() {
                    r.flush()?;
                    let _ = tx.send(SourceMsg::Recording(None));
                }
            }
            Ok(CameraCmd::Stop) | Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => {}
        }
        let Some(batch) = cam.next() else { anyhow::bail!("stream ended") };
        if let Some((started, counts)) = calib.as_mut() {
            for i in 0..batch.len() {
                counts[batch.y[i] as usize * w + batch.x[i] as usize] += 1;
            }
            if started.elapsed() >= Duration::from_secs(1) {
                let px = hot_pixels(counts, w, 50.0, PIXEL_MASK_SLOTS);
                cam.set_pixel_masks(&px)?;
                let _ = tx.send(SourceMsg::Info(format!("masked {} hot pixels", px.len())));
                calib = None;
            }
        }
        if let Some(a) = auto.as_mut() {
            let el = a.started.elapsed();
            if el >= AUTO_SETTLE {
                for i in 0..batch.len() {
                    let k = batch.y[i] as usize * w + batch.x[i] as usize;
                    if batch.p[i] == 1 { a.on[k] += 1 } else { a.off[k] += 1 }
                }
            }
            if el >= AUTO_SETTLE + AUTO_MEASURE {
                let secs = AUTO_MEASURE.as_secs_f32();
                let (r_on, r_off) = (trimmed_mean(&a.on, 0.01) / secs, trimmed_mean(&a.off, 0.01) / secs);
                let mut changed = false;
                for (idx, rate) in [(i_on, r_on), (i_off, r_off)] {
                    let b = &BIAS_TABLE[idx];
                    if let Some(o) = next_offset(offsets[idx], rate, a.target, 8.0, 0.15, b.rec_min, b.rec_max) {
                        if o != offsets[idx] {
                            offsets[idx] = o;
                            cam.write_bias(b.addr, cam.bias_default(idx), o)?;
                            changed = true;
                        }
                    }
                }
                if changed {
                    let _ = tx.send(SourceMsg::Biases(offsets.clone()));
                }
                a.iter += 1;
                let _ = tx.send(SourceMsg::Info(format!(
                    "auto bias #{}: ON {r_on:.1} OFF {r_off:.1} ev/s/px -> diff_on {} diff_off {}",
                    a.iter, offsets[i_on], offsets[i_off]
                )));
                if !changed || a.iter >= AUTO_MAX_ITERS {
                    let _ = tx.send(SourceMsg::Info(if changed { "auto bias: stopped at max iterations".into() } else { "auto bias: done".into() }));
                    auto = None;
                    calib = Some((Instant::now(), vec![0; n_px])); // hot pixels depend on biases
                } else {
                    a.started = Instant::now();
                    a.on.fill(0);
                    a.off.fill(0);
                }
            }
        }
        if let Some(r) = rec.as_mut() {
            for i in 0..batch.len() {
                write_record(r, batch.x[i], batch.y[i], batch.p[i], batch.t[i])?;
            }
        }
        if last_stats.elapsed() >= Duration::from_secs(1) {
            let _ = tx.send(SourceMsg::Dropped(cam.dropped_buffers()));
            if afk_on {
                if let Ok((total, flicker)) = cam.antiflicker_counts() {
                    let _ = tx.send(SourceMsg::Afk(total, flicker));
                }
            }
            last_stats = Instant::now();
        }
        if tx.send(SourceMsg::Batch(batch)).is_err() {
            break;
        }
    }
    if let Some(mut r) = rec {
        r.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("emv-{}-{name}", std::process::id()))
    }

    fn collect(rx: Receiver<SourceMsg>) -> Vec<SourceMsg> {
        rx.iter().collect()
    }

    #[test]
    fn bin_file_roundtrip() {
        let mut v = Vec::new();
        write_record(&mut v, 1, 2, 1, 3).unwrap();
        write_record(&mut v, 1279, 719, 0, u64::MAX).unwrap();
        write_record(&mut v, 7, 8, 1, 9).unwrap();
        v.push(0xAA); // partial trailing record
        let b = parse_records(&v);
        assert_eq!((b.x.clone(), b.y.clone(), b.p.clone(), b.t.clone()), (vec![1, 1279, 7], vec![2, 719, 8], vec![1, 0, 1], vec![3, u64::MAX, 9]));
    }

    #[test]
    fn file_source_sends_geometry_then_batches_then_ended() {
        let path = temp_path("three.bin");
        let mut v = Vec::new();
        for i in 0..3u64 {
            write_record(&mut v, i as u16, 2, 1, 1000 + i * 100).unwrap();
        }
        std::fs::write(&path, v).unwrap();
        let (tx, rx) = channel();
        spawn_file(tx, path.clone(), Arc::new(AtomicBool::new(false))).join().unwrap();
        let msgs = collect(rx);
        std::fs::remove_file(&path).ok();
        assert!(matches!(&msgs[0], SourceMsg::Geometry { w: 1280, h: 720, .. }));
        assert!(matches!(&msgs[1], SourceMsg::Biases(b) if b.is_empty()));
        let n: usize = msgs.iter().map(|m| if let SourceMsg::Batch(b) = m { b.len() } else { 0 }).sum();
        assert_eq!(n, 3);
        assert!(matches!(msgs.last(), Some(SourceMsg::Ended)));
    }

    #[test]
    fn missing_file_reports_error_then_ended() {
        let (tx, rx) = channel();
        spawn_file(tx, temp_path("nope.bin"), Arc::new(AtomicBool::new(false))).join().unwrap();
        let msgs = collect(rx);
        assert!(matches!(&msgs[0], SourceMsg::Error(_)));
        assert!(matches!(msgs.last(), Some(SourceMsg::Ended)));
    }

    #[test]
    #[ignore = "set EMV_RAW_FILE to a .raw recording"]
    fn raw_file_replays() {
        let (tx, rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let h = spawn_file(tx, PathBuf::from(std::env::var("EMV_RAW_FILE").expect("EMV_RAW_FILE")), stop.clone());
        let (mut batches, mut last_t) = (0, 0);
        for m in rx.iter() {
            match m {
                SourceMsg::Geometry { w, h, .. } => println!("geometry {w}x{h}"),
                SourceMsg::Batch(b) => {
                    assert!(b.t[0] >= last_t);
                    last_t = *b.t.last().unwrap();
                    batches += 1;
                    if batches == 50 {
                        stop.store(true, Ordering::Relaxed);
                    }
                }
                SourceMsg::Error(e) => panic!("{e}"),
                _ => {}
            }
        }
        h.join().unwrap();
        println!("{batches} batches, last t {last_t}");
        assert!(batches >= 50);
    }
}
