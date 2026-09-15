// Private per-user notes ("moderator memory" like Chatterino's user notes) — ported from StreamNook's
// user_notes service. Keyed by Twitch user id so a rename keeps the note. Persisted as user_notes.json
// in the app data dir. Notes are rare, so we just read/rewrite the whole map on each change.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
struct UserNote {
    note: String,
    updated_ms: i64,
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("user_notes.json"))
}

fn load(app: &AppHandle) -> HashMap<String, UserNote> {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, map: &HashMap<String, UserNote>) -> Result<(), String> {
    let p = path(app).ok_or_else(|| "no app data dir".to_string())?;
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let data = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn get_user_note(user_id: String, app: AppHandle) -> String {
    load(&app)
        .get(&user_id)
        .map(|n| n.note.clone())
        .unwrap_or_default()
}

// empty note deletes the entry
#[tauri::command]
pub fn set_user_note(user_id: String, note: String, app: AppHandle) -> Result<(), String> {
    if user_id.is_empty() {
        return Err("missing user id".into());
    }
    let mut map = load(&app);
    let trimmed = note.trim();
    if trimmed.is_empty() {
        map.remove(&user_id);
    } else {
        map.insert(
            user_id,
            UserNote {
                note: trimmed.chars().take(4000).collect(),
                updated_ms: now_ms(),
            },
        );
    }
    save(&app, &map)
}

// user ids that have a note, for the in-chat indicator
#[tauri::command]
pub fn get_user_note_ids(app: AppHandle) -> Vec<String> {
    load(&app).into_keys().collect()
}
