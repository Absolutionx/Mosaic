// Drop campaigns the user has hidden from the Drops panel. Twitch keeps drop progress server-side, so
// this only controls what Mosaic displays — a way to clear out stale/irrelevant campaigns picked up from
// random drops-enabled streams. Keyed by campaign id, persisted as hidden_drops.json in the app data dir.

use std::collections::BTreeSet;
use tauri::{AppHandle, Manager};

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("hidden_drops.json"))
}

fn load(app: &AppHandle) -> BTreeSet<String> {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, set: &BTreeSet<String>) -> Result<(), String> {
    let p = path(app).ok_or_else(|| "no app data dir".to_string())?;
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let data = serde_json::to_string_pretty(set).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_hidden_drops(app: AppHandle) -> Vec<String> {
    load(&app).into_iter().collect()
}

#[tauri::command]
pub fn set_drop_hidden(campaign_id: String, hidden: bool, app: AppHandle) -> Result<(), String> {
    if campaign_id.is_empty() {
        return Err("missing campaign id".into());
    }
    let mut set = load(&app);
    if hidden {
        set.insert(campaign_id);
    } else {
        set.remove(&campaign_id);
    }
    save(&app, &set)
}
