// Small app-level commands for the Settings panel.

use tauri::Manager;

// true when this launch came from "Start Mosaic with your computer" (the autostart plugin passes
// --autostart), so "start minimized" only applies to those launches, never when you open Mosaic yourself
#[tauri::command]
pub fn launched_at_startup() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

// Leftover update installers. The updater downloads each new version's installer into its own folder in the
// temp directory ("Mosaic-<version>-updater-<random>") and nothing ever removes it: the app exits so the
// installer can run. One installer per update adds up over time. This clears them out; main.rs calls it a
// little after startup, by which time the installer that put this version in place has finished (one that
// is still running simply fails to delete and goes at the next start).
// Deliberately narrow: only folders with that name shape, directly inside `temp`, and in them only the
// installer files; a folder holding anything else is left where it is. Returns how many folders went.
pub fn remove_old_update_files(temp: &std::path::Path, app_name: &str) -> usize {
    let app = app_name.to_lowercase();
    if app.is_empty() {
        return 0;
    }
    let prefix = format!("{app}-");
    let Ok(entries) = std::fs::read_dir(temp) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !(name.starts_with(&prefix) && name.contains("-updater-")) {
            continue;
        }
        // file_type() doesn't follow links: a link to a folder elsewhere is not one of ours
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        if let Ok(files) = std::fs::read_dir(&dir) {
            for f in files.flatten() {
                let fname = f.file_name().to_string_lossy().to_lowercase();
                let installer = fname.starts_with(&app) && (fname.ends_with(".exe") || fname.ends_with(".msi"));
                if installer && f.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    let _ = std::fs::remove_file(f.path());
                }
            }
        }
        // not recursive: this only succeeds if the folder is empty now
        if std::fs::remove_dir(&dir).is_ok() {
            removed += 1;
        }
    }
    removed
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

// F / the fullscreen button (toggleFullscreen in layout.js).
//
// from a normal window there is nothing special: tao saves the window's placement, covers the monitor, and
// puts the placement back on exit.
//
// from a MAXIMIZED window, tao's fullscreen leaves a taskbar-height strip at the bottom showing the bare
// window. the main window is undecorated, and for a maximized undecorated window tao's WM_NCCALCSIZE clamps
// the client area to the monitor's work area (so it doesn't cover the taskbar). it decides "maximized" from
// the WS_MAXIMIZE style bit, which is still set in fullscreen.
//
// entering: once the window is fullscreen, that one style bit is cleared and the frame recalculated, so the
// client area fills the monitor. the window never moves to its restored size.
//
// leaving: tao restores the placement it saved on the way in ("maximized", plus the original restore rect)
// with SetWindowPlacement. on a window that is NOT flagged maximized, that call first moves the window to
// the restore rect and then maximizes it, with the OS maximize animation: the app showed up small for a few
// frames and then zoomed out. so before tao leaves fullscreen the bit is put back and the window is set to
// the exact rect it had while maximized (recorded on the way in). to tao and to Windows it is then a
// maximized window already in place, and restoring "maximized" changes nothing visible.
//
// two more guards:
// - DWM's window transitions are switched off for the window around the change, so if a maximize / restore
//   does happen (the fallback below), it's a cut and not an animation.
// - entering is checked. if the client area doesn't fill the window after the bit is cleared, the older
//   route is used: un-maximize, then fullscreen, and maximize again on exit.
//
// everything runs in a single main-thread task, where tao applies each window call immediately, so no
// in-between state waits on the event loop.
//
// entering returns true only when the fallback was used. the caller hands that back as `remaximize` when
// leaving.
#[tauri::command]
pub async fn set_app_fullscreen(window: tauri::WebviewWindow, on: bool, remaximize: bool) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<bool, String>>();
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            #[cfg(windows)]
            {
                if let Ok(handle) = w.hwnd() {
                    win32::set_transitions_disabled(handle.0 as isize, true);
                }
            }
            let result = if on { enter_fullscreen(&w) } else { leave_fullscreen(&w, remaximize) };
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "fullscreen switch did not run".to_string())?;

    // transitions back on once the change has settled, so minimize / maximize animate as usual again
    #[cfg(windows)]
    {
        let w = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let target = w.clone();
            let _ = w.run_on_main_thread(move || {
                if let Ok(handle) = target.hwnd() {
                    win32::set_transitions_disabled(handle.0 as isize, false);
                }
            });
        });
    }
    result
}

#[cfg(not(windows))]
fn enter_fullscreen(window: &tauri::WebviewWindow) -> Result<bool, String> {
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    Ok(false)
}

#[cfg(not(windows))]
fn leave_fullscreen(window: &tauri::WebviewWindow, remaximize: bool) -> Result<bool, String> {
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    if remaximize {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(false)
}

#[cfg(windows)]
fn enter_fullscreen(window: &tauri::WebviewWindow) -> Result<bool, String> {
    win32::forget_maximized(); // nothing left over from an earlier round
    let was_maximized = window.is_maximized().unwrap_or(false);
    let hwnd = window.hwnd().ok().map(|handle| handle.0 as isize);
    // where the window sits while maximized, for leave_fullscreen
    let maximized_rect = if was_maximized { hwnd.and_then(win32::window_rect) } else { None };

    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    if !was_maximized {
        return Ok(false);
    }
    if let (Some(hwnd), Some(rect)) = (hwnd, maximized_rect) {
        // no taskbar on this monitor: the clamp changed nothing, the bit can stay
        if win32::client_fills_window(hwnd)
            || (win32::clear_maximized_style(hwnd) && win32::client_fills_window(hwnd))
        {
            win32::remember_maximized(hwnd, rect);
            return Ok(false);
        }
    }
    // fallback: back out, leave the maximized state the ordinary way, go fullscreen again
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    window.unmaximize().map_err(|e| e.to_string())?;
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(windows)]
fn leave_fullscreen(window: &tauri::WebviewWindow, remaximize: bool) -> Result<bool, String> {
    let hwnd = window.hwnd().ok().map(|handle| handle.0 as isize);
    let in_place = hwnd.and_then(win32::restore_maximized_in_place);
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    // normally already maximized by now. the fallback route (remaximize) always needs this
    if (remaximize || in_place.is_some()) && !window.is_maximized().unwrap_or(false) {
        window.maximize().map_err(|e| e.to_string())?;
    }
    // restoring the saved placement may nudge a maximized window (its "maximized position" field): put it
    // back on the recorded rect if so
    if let (Some(hwnd), Some(rect)) = (hwnd, in_place) {
        win32::settle_maximized_at(hwnd, rect);
    }
    Ok(false)
}

// the few Win32 calls the fullscreen switch needs, declared directly rather than pulling in a bindings crate
#[cfg(windows)]
mod win32 {
    use std::sync::Mutex;

    #[repr(C)]
    #[derive(Clone, Copy, Default, PartialEq)]
    pub struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
        fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
        fn SetWindowPos(hwnd: isize, insert_after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn GetClientRect(hwnd: isize, rect: *mut Rect) -> i32;
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const core::ffi::c_void, size: u32) -> i32;
    }

    const GWL_STYLE: i32 = -16;
    const WS_MAXIMIZE: u32 = 0x0100_0000;
    const WS_CAPTION: u32 = 0x00C0_0000;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const DWMWA_TRANSITIONS_FORCEDISABLED: u32 = 3;

    // a window that went fullscreen from maximized: its handle and the rect it had while maximized
    static MAXIMIZED_BEFORE: Mutex<Option<(isize, Rect)>> = Mutex::new(None);

    pub fn remember_maximized(hwnd: isize, rect: Rect) {
        if let Ok(mut saved) = MAXIMIZED_BEFORE.lock() {
            *saved = Some((hwnd, rect));
        }
    }

    pub fn forget_maximized() {
        if let Ok(mut saved) = MAXIMIZED_BEFORE.lock() {
            *saved = None;
        }
    }

    pub fn window_rect(hwnd: isize) -> Option<Rect> {
        let mut rect = Rect::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) } != 0 {
            Some(rect)
        } else {
            None
        }
    }

    // DWM's minimize / maximize / restore animations for this one window
    pub fn set_transitions_disabled(hwnd: isize, disabled: bool) {
        let value: i32 = if disabled { 1 } else { 0 };
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &value as *const i32 as *const core::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    // true when the client area is as large as the window itself, i.e. nothing of the bare window shows
    pub fn client_fills_window(hwnd: isize) -> bool {
        let mut window = Rect::default();
        let mut client = Rect::default();
        let ok = unsafe { GetWindowRect(hwnd, &mut window) != 0 && GetClientRect(hwnd, &mut client) != 0 };
        ok && client.right - client.left == window.right - window.left
            && client.bottom - client.top == window.bottom - window.top
    }

    // tao removes the caption style for fullscreen and keeps it otherwise, undecorated or not
    fn has_fullscreen_styles(style: u32) -> bool {
        style & WS_CAPTION == 0
    }

    // entering: clears WS_MAXIMIZE on a window that is already fullscreen and has the frame recalculated.
    // returns false, touching nothing, when the fullscreen styles aren't in place: an ordinary maximized
    // window must never lose the bit this way
    pub fn clear_maximized_style(hwnd: isize) -> bool {
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if !has_fullscreen_styles(style) {
                return false;
            }
            if style & WS_MAXIMIZE != 0 {
                SetWindowLongW(hwnd, GWL_STYLE, (style & !WS_MAXIMIZE) as i32);
            }
            SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED) != 0
        }
    }

    // leaving, before tao does: puts WS_MAXIMIZE back and moves the still-fullscreen window to the rect it had
    // while maximized. the resulting WM_SIZE (SIZE_MAXIMIZED) is also what tells tao the window is maximized
    // again, so the styles it applies next keep the bit. returns that rect, or None when this window didn't go
    // fullscreen from maximized or is no longer in tao's fullscreen
    pub fn restore_maximized_in_place(hwnd: isize) -> Option<Rect> {
        let saved = match MAXIMIZED_BEFORE.lock() {
            Ok(mut saved) => saved.take(),
            Err(_) => None,
        };
        let rect = match saved {
            Some((saved_hwnd, rect)) if saved_hwnd == hwnd => rect,
            _ => return None,
        };
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if !has_fullscreen_styles(style) {
                return None;
            }
            if style & WS_MAXIMIZE == 0 {
                SetWindowLongW(hwnd, GWL_STYLE, (style | WS_MAXIMIZE) as i32);
            }
            let moved = SetWindowPos(
                hwnd,
                0,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            ) != 0;
            if moved {
                Some(rect)
            } else {
                None
            }
        }
    }

    // leaving, after tao: a window that is maximized again but not on the recorded rect is moved onto it
    pub fn settle_maximized_at(hwnd: isize, rect: Rect) {
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            if style & WS_MAXIMIZE == 0 || window_rect(hwnd) == Some(rect) {
                return;
            }
            SetWindowPos(
                hwnd,
                0,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}
