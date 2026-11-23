use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::channel;
use std::sync::Arc;

use event_music_video::server::{serve, spawn_bridge, Shared};
use event_music_video::{biases, source};

const USAGE: &str = "usage: event-music-video (--camera | --file <rec.bin|rec.raw>) [--biases <file.bias>] [--max-rate <ev/s>] [--port <n>]";

struct Args {
    camera: bool,
    file: Option<PathBuf>,
    biases: Option<PathBuf>,
    max_rate: f64,
    port: u16,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args { camera: false, file: None, biases: None, max_rate: 2e6, port: 8080 };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--camera" => a.camera = true,
            "--file" => a.file = Some(value()?.into()),
            "--biases" => a.biases = Some(value()?.into()),
            "--max-rate" => a.max_rate = value()?.parse().map_err(|e| format!("--max-rate: {e}"))?,
            "--port" => a.port = value()?.parse().map_err(|e| format!("--port: {e}"))?,
            _ => return Err(format!("unknown argument {flag}")),
        }
    }
    if a.camera == a.file.is_some() {
        return Err("pick exactly one of --camera or --file".into());
    }
    Ok(a)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args().unwrap_or_else(|e| {
        eprintln!("{e}\n{USAGE}");
        std::process::exit(2);
    });
    let web_dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/web"));
    let (tx, rx) = channel();
    let shared = if let Some(path) = args.file {
        source::spawn_file(tx, path, Arc::new(AtomicBool::new(false)));
        Shared::new("file", None)
    } else {
        let mut offsets = biases::defaults();
        if let Some(p) = &args.biases {
            for w in biases::parse(&std::fs::read_to_string(p)?, &mut offsets) {
                eprintln!("{}: {w}", p.display());
            }
        }
        let (ctx, crx) = channel();
        source::spawn_camera(tx, crx, source::CameraInit { bias_offsets: offsets, antiflicker: Some((90, 110)) });
        Shared::new("camera", Some(ctx))
    };
    spawn_bridge(rx, shared.clone(), args.max_rate);
    serve(shared, web_dir, args.port).await
}

