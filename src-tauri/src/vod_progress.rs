// persists per-VOD playback position so the app can resume where the user left off. single
// JSON file in app_local_data_dir (whole-file load/save), same pattern as notify_prefs.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

const PROGRESS_FILE: &str = "vod_progress.json";

// heavy VOD watching would otherwise grow this file forever; evicting the least-recently-updated
// entries at the cap keeps it bounded with no user involvement
const MAX_ENTRIES: usize = 300;

#[derive(Serialize, Deserialize, Clone)]
pub struct ProgressEntry {
    pub position_secs: f64,
    pub total_secs: f64,
    // unix millis, only used to pick eviction victims (oldest-updated first) once MAX_ENTRIES is exceeded, never shown to the user
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedProgress {
    // keyed by VOD id (Helix video id, as a string)
    #[serde(default)]
    vods: HashMap<String, ProgressEntry>,
}

fn progress_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(PROGRESS_FILE))
}

fn load_progress(app: &AppHandle) -> PersistedProgress {
    let Some(path) = progress_path(app) else { return PersistedProgress::default() };
    let Ok(json) = std::fs::read_to_string(&path) else { return PersistedProgress::default() };
    serde_json::from_str::<PersistedProgress>(&json).unwrap_or_default()
}

fn save_progress(app: &AppHandle, progress: &PersistedProgress) -> Result<(), String> {
    let path = progress_path(app)
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    let json = serde_json::to_string(progress).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// used when opening a VOD to decide whether to resume. see get_all_vod_progress for the bulk version
#[tauri::command]
pub fn get_vod_progress(app: AppHandle, video_id: String) -> Option<ProgressEntry> {
    load_progress(&app).vods.get(&video_id).cloned()
}

// every VOD with saved progress (id -> entry). fetched once per VOD-list render (vods.js), so
// N resume indicators cost one call, not N
#[tauri::command]
pub fn get_all_vod_progress(app: AppHandle) -> HashMap<String, ProgressEntry> {
    load_progress(&app).vods
}

// called periodically while watching (main.js) and on stop/switch-away, not every position-poll
// tick, a write every few seconds is plenty for "resume roughly where you left off" and avoids hammering disk
#[tauri::command]
pub fn save_vod_progress(
    app: AppHandle,
    video_id: String,
    position_secs: f64,
    total_secs: f64,
) -> Result<(), String> {
    let mut progress = load_progress(&app);
    progress.vods.insert(
        video_id,
        ProgressEntry { position_secs, total_secs, updated_at: now_millis() },
    );

    if progress.vods.len() > MAX_ENTRIES {
        // evict oldest-updated first, down to the cap, keeps what's most likely to still matter (recently watched)
        let mut by_age: Vec<(String, u64)> = progress
            .vods
            .iter()
            .map(|(id, entry)| (id.clone(), entry.updated_at))
            .collect();
        by_age.sort_by_key(|(_, updated_at)| *updated_at);
        let overflow = progress.vods.len() - MAX_ENTRIES;
        for (id, _) in by_age.into_iter().take(overflow) {
            progress.vods.remove(&id);
        }
    }

    save_progress(&app, &progress)
}
