// persists go-live notification opt-ins to notify_channels.json in app_local_data_dir. old
// files may carry a stale close_pref key; serde ignores unknown fields, so they still load

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

const PREFS_FILE: &str = "notify_channels.json";

// Category targets moved from one category per login (a String) to many (a Vec<String>). The custom
// deserialize below accepts BOTH shapes so existing files keep working: a bare "Just Chatting" is
// read as ["Just Chatting"], and a list is read as-is. New writes are always lists.
#[derive(Deserialize)]
#[serde(untagged)]
enum CategoryTargetsIn {
    One(String),
    Many(Vec<String>),
}

impl From<CategoryTargetsIn> for Vec<String> {
    fn from(v: CategoryTargetsIn) -> Self {
        match v {
            CategoryTargetsIn::One(s) => {
                if s.trim().is_empty() { Vec::new() } else { vec![s] }
            }
            CategoryTargetsIn::Many(list) => list,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedPrefs {
    // lowercase channel logins the user wants go-live notifications for
    channels: Vec<String>,
    // login -> the category (game) names to notify on when the channel switches TO one of them.
    // Deserializes from either the old String form or the new list form (see CategoryTargetsIn).
    #[serde(default, deserialize_with = "de_category_targets")]
    category_targets: HashMap<String, Vec<String>>,
}

// Reads the whole map allowing each value to be a String (old) or a Vec<String> (new).
fn de_category_targets<'de, D>(d: D) -> Result<HashMap<String, Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: HashMap<String, CategoryTargetsIn> = HashMap::deserialize(d)?;
    Ok(raw.into_iter().map(|(k, v)| (k, v.into())).collect())
}

fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(PREFS_FILE))
}

fn load_prefs(app: &AppHandle) -> PersistedPrefs {
    let Some(path) = prefs_path(app) else { return PersistedPrefs::default() };
    let Ok(json) = std::fs::read_to_string(&path) else { return PersistedPrefs::default() };
    serde_json::from_str::<PersistedPrefs>(&json).unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: &PersistedPrefs) -> Result<(), String> {
    let path = prefs_path(app)
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_notify_channels(app: AppHandle) -> Vec<String> {
    load_prefs(&app).channels
}

#[tauri::command]
pub fn set_notify_channels(app: AppHandle, channels: Vec<String>) -> Result<(), String> {
    let mut prefs = load_prefs(&app);
    prefs.channels = channels;
    save_prefs(&app, &prefs)
}

#[tauri::command]
pub fn get_notify_category_targets(app: AppHandle) -> HashMap<String, Vec<String>> {
    load_prefs(&app).category_targets
}

#[tauri::command]
pub fn set_notify_category_targets(
    app: AppHandle,
    targets: HashMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut prefs = load_prefs(&app);
    // drop empty lists so a channel with no categories doesn't linger in the file
    prefs.category_targets = targets.into_iter().filter(|(_, v)| !v.is_empty()).collect();
    save_prefs(&app, &prefs)
}
