// VOD downloads: save a Twitch VOD (or a time range of it) to an MP4 in the Downloads folder.
//
// The VOD's playlist URL is resolved exactly as for playback (stream_relay::resolve_vod_cdn_url), then ffmpeg
// copies the chosen range: -ss before -i seeks inside the HLS playlist, so skipped parts are never
// downloaded; -c copy means no re-encoding (original quality, fast); +faststart puts the index up front so
// the file opens instantly anywhere. Progress comes from ffmpeg's -progress output and is emitted as
// "vod-download-progress" { id, seconds }; completion as "vod-download-done" { id, ok, path?, error? }.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
pub struct DownloadsState {
    cancels: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    // files this app wrote: the only paths "show in folder" will reveal
    files: Mutex<Vec<PathBuf>>,
}

// a safe file name from a title: no path separators or characters Windows rejects, reasonable length
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == ' ');
    let short: String = trimmed.chars().take(120).collect();
    if short.is_empty() { "Mosaic VOD".to_string() } else { short }
}

// "name.mp4", or "name (2).mp4" etc. when it already exists
fn unique_path(dir: &std::path::Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..1000)
        .map(|n| dir.join(format!("{stem} ({n}).{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

#[tauri::command]
pub async fn start_vod_download(
    app: tauri::AppHandle,
    state: State<'_, DownloadsState>,
    video_id: String,
    quality: String,
    start_secs: Option<f64>,
    end_secs: Option<f64>,
    name: String,
) -> Result<serde_json::Value, String> {
    if quality.is_empty() || !quality.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ',') {
        return Err("invalid quality".to_string());
    }
    let start = start_secs.filter(|s| s.is_finite() && *s > 0.0);
    let end = end_secs.filter(|e| e.is_finite() && *e > start.unwrap_or(0.0));

    let url = crate::stream_relay::resolve_vod_cdn_url(&video_id, &quality).await?;

    let dir = app.path().download_dir().or_else(|_| app.path().app_data_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let audio_only = quality == "audio_only";
    let path = unique_path(&dir, &sanitize(&name), if audio_only { "m4a" } else { "mp4" });

    let mut cmd = Command::new(crate::stream_relay::resolve_dep_path("ffmpeg"));
    cmd.args(["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-progress", "pipe:1"]);
    if let Some(s) = start {
        cmd.arg("-ss").arg(format!("{s:.3}"));
    }
    cmd.arg("-i").arg(&url);
    if let Some(e) = end {
        cmd.arg("-t").arg(format!("{:.3}", e - start.unwrap_or(0.0)));
    }
    if audio_only {
        cmd.arg("-vn");
    }
    cmd.args(["-c", "copy", "-movflags", "+faststart", "-n"])
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    crate::stream_relay::augment_child_path(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("couldn't start ffmpeg: {e}"))?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    state.cancels.lock().map_err(|e| e.to_string())?.insert(id.clone(), cancel_tx);

    // progress: ffmpeg prints key=value lines; out_time_us is the position written so far
    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
            while let Ok(Some(line)) = lines.next_line().await {
                let v = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms="));
                if let Some(us) = v.and_then(|v| v.trim().parse::<i64>().ok()) {
                    if last_emit.elapsed().as_millis() >= 500 {
                        last_emit = std::time::Instant::now();
                        let _ = app2.emit("vod-download-progress", serde_json::json!({ "id": id2, "seconds": us as f64 / 1_000_000.0 }));
                    }
                }
            }
        });
    }
    let mut stderr = child.stderr.take();

    let app3 = app.clone();
    let id3 = id.clone();
    let path3 = path.clone();
    tokio::spawn(async move {
        let result = tokio::select! {
            status = child.wait() => Some(status),
            _ = cancel_rx => {
                let _ = child.kill().await;
                None
            }
        };
        let mut err_text = String::new();
        if let Some(mut e) = stderr.take() {
            let _ = e.read_to_string(&mut err_text).await;
        }
        let downloads = app3.state::<DownloadsState>();
        if let Ok(mut c) = downloads.cancels.lock() {
            c.remove(&id3);
        }
        match result {
            Some(Ok(status)) if status.success() => {
                if let Ok(mut f) = downloads.files.lock() {
                    f.push(path3.clone());
                }
                let _ = app3.emit("vod-download-done", serde_json::json!({ "id": id3, "ok": true, "path": path3.to_string_lossy() }));
            }
            other => {
                let _ = std::fs::remove_file(&path3); // never leave a broken partial file behind
                let cancelled = other.is_none();
                let last = err_text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
                let _ = app3.emit("vod-download-done", serde_json::json!({
                    "id": id3, "ok": false, "cancelled": cancelled,
                    "error": if cancelled { "Cancelled".to_string() } else if last.is_empty() { "ffmpeg stopped unexpectedly".to_string() } else { last },
                }));
            }
        }
    });

    Ok(serde_json::json!({
        "id": id,
        "path": path.to_string_lossy(),
        "file": path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
    }))
}

#[tauri::command]
pub fn cancel_vod_download(state: State<'_, DownloadsState>, id: String) -> Result<(), String> {
    if let Some(tx) = state.cancels.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}

// select the finished file in the file manager. only files this app downloaded can be revealed
#[tauri::command]
pub fn reveal_download(state: State<'_, DownloadsState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let known = state.files.lock().map_err(|e| e.to_string())?.iter().any(|f| *f == p);
    if !known || !p.exists() {
        return Err("file not found".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", p.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(&p).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(dir) = p.parent() {
            std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
