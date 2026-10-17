// Pinned shortcuts showing an old icon after an update.
//
// Windows keeps the icons it has shown in an on-disk cache keyed by file path. Mosaic updates in place (same
// mosaic.exe path), so a taskbar pin or Start menu entry can keep showing the previous version's icon for
// weeks, through restarts, until that cache happens to be rebuilt (seen after 1.5.8's new icon: the app,
// installer and header all had it, the pinned taskbar button didn't, and re-pinning didn't help).
//
// The fix is to tell Explorer the icons changed, the way installers do: SHChangeNotify with
// SHCNE_UPDATEITEM for mosaic.exe and for every Mosaic shortcut (taskbar pins, Start menu, desktop), then
// SHCNE_ASSOCCHANGED, which makes Explorer refresh the icons it has cached. The installer does the
// ASSOCCHANGED part as well (windows/installer-hooks.nsh); this covers updates however they were installed.
// It runs once per version, in the background, at startup.

#[cfg(windows)]
pub fn refresh_after_update(app: &tauri::AppHandle) {
    use tauri::Manager;
    let version = app.package_info().version.to_string();
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let marker = dir.join("icon-refresh-version");
    if std::fs::read_to_string(&marker).ok().as_deref() == Some(version.as_str()) {
        return;
    }
    std::thread::spawn(move || {
        let n = notify_icons_changed();
        eprintln!("[icon_refresh] told Windows about the icon for {version} ({n} shortcut(s))");
        // dev builds share the installed app's data folder: recording the version there would make the real
        // release of the same version skip this
        if !cfg!(debug_assertions) {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(&marker, &version);
        }
    });
}

#[cfg(not(windows))]
pub fn refresh_after_update(_app: &tauri::AppHandle) {}

// every shortcut to Mosaic Windows might draw: taskbar pins, Start menu, desktop. matched by name, which is
// what the installer names them
#[cfg(windows)]
fn mosaic_shortcuts() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA").map(std::path::PathBuf::from) {
        dirs.push(appdata.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"));
        dirs.push(appdata.join(r"Microsoft\Internet Explorer\Quick Launch"));
        dirs.push(appdata.join(r"Microsoft\Windows\Start Menu\Programs"));
        dirs.push(appdata.join(r"Microsoft\Windows\Start Menu\Programs\Mosaic"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from) {
        dirs.push(home.join("Desktop"));
    }
    let mut out = Vec::new();
    for d in dirs {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with(".lnk") && name.contains("mosaic") {
                out.push(e.path());
            }
        }
    }
    out
}

#[cfg(windows)]
fn notify_icons_changed() -> usize {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{
        SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM, SHCNF_FLUSH, SHCNF_IDLIST, SHCNF_PATHW,
    };
    let shortcuts = mosaic_shortcuts();
    let mut paths: Vec<std::path::PathBuf> = shortcuts.clone();
    if let Ok(exe) = std::env::current_exe() {
        paths.push(exe);
    }
    for p in &paths {
        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSH, Some(wide.as_ptr() as *const _), None);
        }
    }
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, None, None);
    }
    shortcuts.len()
}
