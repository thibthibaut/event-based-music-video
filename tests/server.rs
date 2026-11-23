use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::{Duration, Instant};

use event_music_video::server::{handle_control, router, spawn_bridge, Shared};
use event_music_video::source::{spawn_file, write_record, CameraCmd, SourceMsg};
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;

fn temp_bin(name: &str, n: u64) -> PathBuf {
    let p = std::env::temp_dir().join(format!("emv-srv-{}-{name}.bin", std::process::id()));
    let mut v = Vec::new();
    // 2 s of events at 10 kev/s so the stream is still live while the test reads.
    for i in 0..n {
        write_record(&mut v, (i % 1280) as u16, (i % 720) as u16, (i % 2) as u8, i * 100).unwrap();
    }
    std::fs::write(&p, v).unwrap();
    p
}

/// File source → bridge → server on an ephemeral port. Returns the ws URL.
async fn start(path: PathBuf) -> (String, Arc<Shared>) {
    let shared = Shared::new("file", None);
    let (tx, rx) = channel();
    spawn_file(tx, path, Arc::new(AtomicBool::new(false)));
    spawn_bridge(rx, shared.clone(), 2e6);
    let start = Instant::now();
    while !shared.status.lock().unwrap().contains("\"width\":1280") && !shared.status.lock().unwrap().contains("\"error\":\"") {
        assert!(start.elapsed() < Duration::from_secs(2), "no geometry");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let app = router(shared.clone(), PathBuf::from("web"));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, shared)
}

fn json(m: &Message) -> serde_json::Value {
    match m {
        Message::Text(t) => serde_json::from_str(t.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

async fn next(ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin)) -> Message {
    tokio::time::timeout(Duration::from_secs(3), ws.next()).await.expect("timeout").unwrap().unwrap()
}

#[tokio::test]
async fn first_messages_are_status_then_biases() {
    let (url, _) = start(temp_bin("first", 20_000)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let s = json(&next(&mut ws).await);
    assert_eq!(s["type"], "status");
    assert_eq!(s["width"], 1280);
    assert_eq!(json(&next(&mut ws).await)["type"], "biases");
    loop {
        if let Message::Binary(b) = next(&mut ws).await {
            assert!(u32::from_le_bytes(b[0..4].try_into().unwrap()) > 0);
            break;
        }
    }
}

#[tokio::test]
async fn reconnect_gets_status_and_biases_first() {
    let (url, _) = start(temp_bin("reconnect", 20_000)).await;
    for _ in 0..2 {
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert_eq!(json(&next(&mut ws).await)["type"], "status");
        assert_eq!(json(&next(&mut ws).await)["type"], "biases");
        next(&mut ws).await;
    }
}

#[tokio::test]
async fn missing_file_shows_error_in_status() {
    let (url, shared) = start(PathBuf::from("/nonexistent/nope.bin")).await;
    assert!(shared.status.lock().unwrap().contains("\"error\":\""));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let s = json(&next(&mut ws).await);
    assert!(s["error"].is_string());
}

#[test]
fn lagged_client_does_not_block_bridge() {
    let shared = Shared::new("file", None);
    let _never_reads = shared.events.subscribe();
    let (tx, rx) = channel();
    let bridge = spawn_bridge(rx, shared, 2e6);
    for k in 0..10_000u64 {
        let mut b = libreeb::EventBatch::new();
        for i in 0..100 {
            b.push(i, i, k * 10_000 + i as u64 * 100, 1);
        }
        tx.send(SourceMsg::Batch(b)).unwrap();
    }
    drop(tx);
    let t = Instant::now();
    bridge.join().unwrap();
    assert!(t.elapsed() < Duration::from_secs(2));
}

#[test]
fn bias_load_rejects_paths() {
    let (ctx, crx) = channel::<CameraCmd>();
    let shared = Shared::new("camera", Some(ctx));
    assert!(handle_control(&shared, r#"{"type":"bias_load","file":"../x.bias"}"#).is_err());
    assert!(crx.try_recv().is_err());
    assert!(handle_control(&shared, r#"{"type":"bias_load","file":"good.bias"}"#).is_ok());
    assert!(matches!(crx.try_recv(), Ok(CameraCmd::BiasLoad(p)) if p == PathBuf::from("biases/good.bias")));
}

#[test]
fn bias_control_maps_name_to_index() {
    let (ctx, crx) = channel::<CameraCmd>();
    let shared = Shared::new("camera", Some(ctx));
    handle_control(&shared, r#"{"type":"bias","name":"bias_fo","offset":-3}"#).unwrap();
    let i = event_music_video::biases::index_of("bias_fo").unwrap();
    assert!(matches!(crx.try_recv(), Ok(CameraCmd::Bias(j, -3)) if j == i));
    assert!(handle_control(&shared, r#"{"type":"bias","name":"bias_nope","offset":1}"#).is_err());
}

#[test]
fn status_reports_antiflicker_band() {
    let shared = Shared::new("camera", None);
    let (tx, rx) = channel();
    let bridge = spawn_bridge(rx, shared.clone(), 2e6);
    tx.send(SourceMsg::AntiFlicker(Some((90, 110)))).unwrap();
    drop(tx);
    bridge.join().unwrap();
    let s: serde_json::Value = serde_json::from_str(&shared.status.lock().unwrap()).unwrap();
    assert_eq!(s["antiflicker"], serde_json::json!([90, 110]));
}
