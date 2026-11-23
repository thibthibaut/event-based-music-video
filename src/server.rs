//! HTTP + WebSocket server and the bridge from the source thread to clients.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use libreeb::biases::BIAS_TABLE;
use libreeb::EventBatch;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tower_http::services::ServeDir;

use crate::biases;
use crate::source::{CameraCmd, SourceMsg};
use crate::wire::{encode, Decimator};

/// State shared by the bridge thread and every WebSocket client.
pub struct Shared {
    pub events: broadcast::Sender<Bytes>,
    pub text: broadcast::Sender<String>,
    /// Latest `status` JSON, sent first to each new client.
    pub status: Mutex<String>,
    /// Latest `biases` JSON, sent second to each new client.
    pub biases: Mutex<String>,
    /// Camera command channel; `None` for a file source.
    pub cmds: Mutex<Option<Sender<CameraCmd>>>,
    source: String,
}

impl Shared {
    pub fn new(source: &str, cmds: Option<Sender<CameraCmd>>) -> Arc<Self> {
        let status = Status { source: source.into(), ..Status::default() };
        Arc::new(Self {
            events: broadcast::channel(64).0,
            text: broadcast::channel(64).0,
            status: Mutex::new(status.json()),
            biases: Mutex::new(biases_json(&[])),
            cmds: Mutex::new(cmds),
            source: source.into(),
        })
    }
}

#[derive(Serialize, Default)]
struct Status {
    source: String,
    sensor: String,
    width: u32,
    height: u32,
    rate_in: f64,
    rate_kept: f64,
    dropped_usb: u64,
    afk: Option<(u32, u32)>,
    recording: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

impl Status {
    fn json(&self) -> String {
        let mut v = serde_json::to_value(self).unwrap();
        v["type"] = "status".into();
        v.to_string()
    }
}

/// `biases` message; an empty `offsets` (file source) gives an empty list.
fn biases_json(offsets: &[i32]) -> String {
    let list: Vec<_> = BIAS_TABLE
        .iter()
        .zip(offsets)
        .map(|(b, o)| serde_json::json!({"name": b.name, "offset": o, "min": b.rec_min, "max": b.rec_max, "hint": b.hint}))
        .collect();
    serde_json::json!({"type": "biases", "list": list}).to_string()
}

/// Coalesce until this much sensor time or this many kept events.
const FLUSH_US: u64 = 10_000;
const FLUSH_EVENTS: usize = 1024;

/// Decimate, encode and publish events; keep the cached status/biases current.
/// Never blocks on clients: a lagging client just misses messages.
pub fn spawn_bridge(rx: Receiver<SourceMsg>, shared: Arc<Shared>, max_rate: f64) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut status = Status { source: shared.source.clone(), ..Status::default() };
        let mut dec = Decimator::new(max_rate);
        let mut t0: Option<u64> = None;
        let mut pending = EventBatch::new();
        let mut kept_since = (Instant::now(), 0usize);
        let mut last_status = Instant::now();
        let publish = |status: &Status| {
            let j = status.json();
            *shared.status.lock().unwrap() = j.clone();
            let _ = shared.text.send(j);
        };
        loop {
            let msg = match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(m) => m,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if last_status.elapsed() >= Duration::from_secs(1) {
                        status.rate_kept = 0.0;
                        publish(&status);
                        last_status = Instant::now();
                    }
                    continue;
                }
                Err(_) => break,
            };
            let mut now_status = false;
            match msg {
                SourceMsg::Geometry { w, h, sensor } => {
                    (status.width, status.height, status.sensor) = (w, h, sensor);
                    status.error = None;
                    now_status = true;
                }
                SourceMsg::Batch(batch) => {
                    let t0 = *t0.get_or_insert(batch.t.first().copied().unwrap_or(0));
                    let keep = dec.mask(&batch);
                    for i in (0..batch.len()).filter(|&i| keep[i]) {
                        pending.push(batch.x[i], batch.y[i], batch.t[i], batch.p[i]);
                    }
                    let span = match (pending.t.first(), pending.t.last()) {
                        (Some(a), Some(b)) => b - a,
                        _ => 0,
                    };
                    if pending.len() >= FLUSH_EVENTS || span >= FLUSH_US {
                        kept_since.1 += pending.len();
                        let all = vec![true; pending.len()];
                        let _ = shared.events.send(Bytes::from(encode(&pending, &all, t0)));
                        pending = EventBatch::new();
                    }
                }
                SourceMsg::Info(m) => {
                    status.message = Some(m);
                    now_status = true;
                }
                SourceMsg::Error(e) => {
                    status.error = Some(e);
                    now_status = true;
                }
                SourceMsg::Dropped(n) => status.dropped_usb = n,
                SourceMsg::Afk(total, flicker) => status.afk = Some((total, flicker)),
                SourceMsg::Biases(o) => {
                    let j = biases_json(&o);
                    *shared.biases.lock().unwrap() = j.clone();
                    let _ = shared.text.send(j);
                }
                SourceMsg::Recording(p) => {
                    status.recording = p.map(|p| p.display().to_string());
                    now_status = true;
                }
                SourceMsg::Ended => {
                    status.message = Some("source ended".into());
                    now_status = true;
                }
            }
            if now_status || last_status.elapsed() >= Duration::from_secs(1) {
                let secs = kept_since.0.elapsed().as_secs_f64();
                if secs >= 1.0 {
                    status.rate_kept = kept_since.1 as f64 / secs;
                    kept_since = (Instant::now(), 0);
                }
                status.rate_in = dec.rate();
                publish(&status);
                last_status = Instant::now();
            }
        }
    })
}

/// Control messages from the page.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Control {
    Bias { name: String, offset: i32 },
    BiasReset,
    BiasSave,
    BiasLoad { file: String },
    ListBiasFiles,
    Autobias { target: f32 },
    Antiflicker { on: bool, lo_hz: u32, hi_hz: u32 },
    CalibrateHotPixels,
    Record { on: bool },
}

/// Apply one page→server JSON control message.
pub fn handle_control(shared: &Shared, text: &str) -> Result<(), String> {
    let c: Control = serde_json::from_str(text).map_err(|e| format!("bad control {text:?}: {e}"))?;
    let cmd = match c {
        Control::ListBiasFiles => {
            let mut files: Vec<String> = std::fs::read_dir("biases")
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.ends_with(".bias"))
                .collect();
            files.sort();
            let _ = shared.text.send(serde_json::json!({"type": "bias_files", "files": files}).to_string());
            return Ok(());
        }
        Control::Bias { name, offset } => {
            CameraCmd::Bias(biases::index_of(&name).ok_or(format!("unknown bias {name}"))?, offset)
        }
        Control::BiasReset => CameraCmd::BiasReset,
        Control::BiasSave => CameraCmd::BiasSave,
        Control::BiasLoad { file } => {
            if file.contains(['/', '\\']) || file.starts_with('.') || !file.ends_with(".bias") {
                return Err(format!("refused bias file {file:?}"));
            }
            CameraCmd::BiasLoad(PathBuf::from("biases").join(file))
        }
        Control::Autobias { target } => CameraCmd::AutoBias(target),
        Control::Antiflicker { on, lo_hz, hi_hz } => CameraCmd::AntiFlicker(on.then_some((lo_hz, hi_hz))),
        Control::CalibrateHotPixels => CameraCmd::CalibrateMask,
        Control::Record { on } => CameraCmd::Record(on),
    };
    let cmds = shared.cmds.lock().unwrap();
    let tx = cmds.as_ref().ok_or("no camera: controls need --camera")?;
    tx.send(cmd).map_err(|_| "camera thread stopped".to_string())
}

pub fn router(shared: Arc<Shared>, web_dir: PathBuf) -> Router {
    Router::new().route("/ws", get(ws_upgrade)).fallback_service(ServeDir::new(web_dir)).with_state(shared)
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(shared): State<Arc<Shared>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| client(socket, shared))
}

async fn client(mut socket: WebSocket, shared: Arc<Shared>) {
    // Subscribe before sending the cached state so nothing falls in between.
    let mut events = shared.events.subscribe();
    let mut text = shared.text.subscribe();
    let first = [shared.status.lock().unwrap().clone(), shared.biases.lock().unwrap().clone()];
    for m in first {
        if socket.send(Message::Text(m.into())).await.is_err() {
            return;
        }
    }
    loop {
        let out = tokio::select! {
            e = events.recv() => match e {
                Ok(b) => Message::Binary(b),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            t = text.recv() => match t {
                Ok(s) => Message::Text(s.into()),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            m = socket.recv() => match m {
                Some(Ok(Message::Text(t))) => {
                    if let Err(e) = handle_control(&shared, t.as_str()) {
                        let j = serde_json::json!({"type": "error", "error": e}).to_string();
                        Message::Text(j.into())
                    } else {
                        continue;
                    }
                }
                Some(Ok(_)) => continue,
                _ => return,
            },
        };
        if socket.send(out).await.is_err() {
            return;
        }
    }
}

/// Serve `web_dir` and `/ws` on 127.0.0.1:`port`.
pub async fn serve(shared: Arc<Shared>, web_dir: PathBuf, port: u16) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!("open http://127.0.0.1:{port}");
    axum::serve(listener, router(shared, web_dir)).await?;
    Ok(())
}
