// Small app-level commands for the Settings panel.

use tauri::Manager;

// true when this launch came from "Start Mosaic with your computer" (the autostart plugin passes
// --autostart), so "start minimized" only applies to those launches, never when you open Mosaic yourself
#[tauri::command]
pub fn launched_at_startup() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

// Settings > App > Back up settings: writes the backup JSON to the Downloads folder (falling back to the
// app's data folder) as Mosaic-backup-YYYY-MM-DD.json and returns the full path, so the UI can show it
#[tauri::command]
pub fn save_backup_file(app: tauri::AppHandle, contents: String) -> Result<String, String> {
    if contents.len() > 20 * 1024 * 1024 {
        return Err("backup too large".to_string());
    }
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("Mosaic-backup-{}.json", chrono::Local::now().format("%Y-%m-%d"));
    let path = dir.join(name);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
