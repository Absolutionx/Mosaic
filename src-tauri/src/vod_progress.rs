// persists per-VOD playback position so the app can resume where the user left off. single
// JSON file in app_local_data_dir (whole-file load/save), same pattern as notify_prefs.rs

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Manager};

const PROGRESS_FILE: &str = "vod_progress.json";

// heavy VOD watching would otherwise grow this file forever; evicting the least-recently-updated
// entries at the cap keeps it bounded with no user involvement
const MAX_ENTRIES: usize = 300;

#[derive(Serialize, Deserialize, Clone)]
pub struct ProgressEntry {
    pub position_secs: f64,
    pub total_secs: f64,
    // unix millis. picks eviction victims (oldest-updated first) once MAX_ENTRIES is exceeded, and
    // orders the Home page's "Continue where you left off" row (most recent first)
    pub updated_at: u64,
    // display metadata for the Home "Continue where you left off" row. optional + defaulted so
    // progress files written before these existed still load (those entries just don't show there
    // until the VOD is watched again and the metadata gets recorded)
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub channel_name: Option<String>,
    #[serde(default)]
    pub channel_login: Option<String>,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    // set when the user removes this VOD from Home's "Continue where you left off" row. hides it from
    // that row only; the saved position is kept, so opening the VOD again still resumes. cleared the
    // next time progress is saved (i.e. the user is actually watching it again)
    #[serde(default)]
    pub dismissed: bool,
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
    title: Option<String>,
    channel_name: Option<String>,
    channel_login: Option<String>,
    thumbnail_url: Option<String>,
) -> Result<(), String> {
    let mut progress = load_progress(&app);
    // keep previously recorded metadata when this save doesn't carry any (e.g. a VOD resumed via
    // session restore, which only knows the id) rather than wiping it
    let prev = progress.vods.get(&video_id).cloned();
    let keep = |new: Option<String>, old: Option<String>| new.filter(|s| !s.is_empty()).or(old);
    progress.vods.insert(
        video_id,
        ProgressEntry {
            position_secs,
            total_secs,
            updated_at: now_millis(),
            title: keep(title, prev.as_ref().and_then(|p| p.title.clone())),
            channel_name: keep(channel_name, prev.as_ref().and_then(|p| p.channel_name.clone())),
            channel_login: keep(channel_login, prev.as_ref().and_then(|p| p.channel_login.clone())),
            thumbnail_url: keep(thumbnail_url, prev.as_ref().and_then(|p| p.thumbnail_url.clone())),
            // watching it again brings it back into the Continue row
            dismissed: false,
        },
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

// Hides a VOD from Home's "Continue where you left off" row (its remove button) WITHOUT forgetting
// its position: opening the VOD again (e.g. from the channel's VODs page) still resumes where the
// user left off. Doesn't touch position or updated_at.
#[tauri::command]
pub fn dismiss_vod_from_continue(app: AppHandle, video_id: String) -> Result<(), String> {
    let mut progress = load_progress(&app);
    if let Some(entry) = progress.vods.get_mut(&video_id) {
        entry.dismissed = true;
        save_progress(&app, &progress)?;
    }
    Ok(())
}

// Fills in title / channel / thumbnail for progress entries saved before that metadata was recorded,
// so older watch history shows up in Home's "Continue where you left off" row. Looks them up on Twitch
// via /helix/videos?id=... (up to 100 ids per request). Twitch-only: Kick ids ("kick:...") are skipped.
// Never touches position/updated_at, so the row's most-recent-first order is unchanged.
//
// A VOD Twitch no longer has (archives expire after a while) is marked with an empty title so it isn't
// looked up again every launch; the Home row already ignores entries without a title. A chunk that
// fails for any other reason (network, auth) is left alone and retried next time.
//
// Returns how many entries were filled in.
#[tauri::command]
pub async fn backfill_vod_progress_metadata(
    app: AppHandle,
    state: tauri::State<'_, crate::ChatState>,
) -> Result<usize, String> {
    let (token, _) = crate::helix::require_auth(&state)?;

    // Twitch archive ids are numeric; skip Kick and anything else
    let missing: Vec<String> = load_progress(&app)
        .vods
        .iter()
        .filter(|(id, e)| e.title.is_none() && !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
        .map(|(id, _)| id.clone())
        .collect();
    if missing.is_empty() {
        return Ok(0);
    }

    // id -> (title, channel_name, channel_login, thumbnail_url)
    let mut found: HashMap<String, (String, String, String, String)> = HashMap::new();
    // ids whose lookup definitively completed (found or confirmed gone)
    let mut resolved: HashSet<String> = HashSet::new();

    for chunk in missing.chunks(100) {
        let query = chunk.iter().map(|id| format!("id={id}")).collect::<Vec<_>>().join("&");
        let url = format!("https://api.twitch.tv/helix/videos?{query}");
        let body = match crate::helix::helix_get(&url, Some(token.clone())).await {
            Ok(b) => b,
            // Helix returns 404 only when NONE of the requested ids exist -> all of this chunk is gone
            Err(e) if e.contains("404") => {
                resolved.extend(chunk.iter().cloned());
                continue;
            }
            Err(e) => {
                eprintln!("[vod_progress] metadata backfill request failed, will retry later: {e}");
                continue;
            }
        };
        let json: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // a successful response covers every id in the chunk: listed ones exist, missing ones are gone
        resolved.extend(chunk.iter().cloned());
        if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
            for v in arr {
                let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let id = s("id");
                if id.is_empty() { continue; }
                found.insert(id, (s("title"), s("user_name"), s("user_login"), s("thumbnail_url")));
            }
        }
    }

    // reload fresh right before writing, so a progress save that landed during the network round-trip
    // (they happen every 15s while watching) isn't overwritten with a stale position
    let mut progress = load_progress(&app);
    let mut filled = 0usize;
    for id in &missing {
        if !resolved.contains(id) { continue; }
        let Some(entry) = progress.vods.get_mut(id) else { continue };
        if entry.title.is_some() { continue; } // filled by a real save in the meantime
        match found.get(id) {
            Some((title, name, login, thumb)) => {
                entry.title = Some(title.clone());
                entry.channel_name = Some(name.clone());
                entry.channel_login = Some(login.clone());
                entry.thumbnail_url = Some(thumb.clone());
                filled += 1;
            }
            None => entry.title = Some(String::new()), // gone from Twitch: don't look it up again
        }
    }
    save_progress(&app, &progress)?;
    Ok(filled)
}
