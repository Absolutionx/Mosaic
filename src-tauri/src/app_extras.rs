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

#[cfg(all(desktop, not(windows)))]
fn enter_fullscreen(window: &tauri::WebviewWindow) -> Result<bool, String> {
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    Ok(false)
}

#[cfg(all(desktop, not(windows)))]
fn leave_fullscreen(window: &tauri::WebviewWindow, remaximize: bool) -> Result<bool, String> {
    window.set_fullscreen(false).map_err(|e| e.to_string())?;
    if remaximize {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(false)
}

// Android: the app already fills the screen; going fullscreen there is the player's own job (the page hides the
// rest of the layout), so the window is left as it is
#[cfg(mobile)]
fn enter_fullscreen(_window: &tauri::WebviewWindow) -> Result<bool, String> {
    Ok(false)
}

#[cfg(mobile)]
fn leave_fullscreen(_window: &tauri::WebviewWindow, _remaximize: bool) -> Result<bool, String> {
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


// WebView2's memory saver: while Mosaic sits hidden (tray, minimized) with nothing playing, the frontend turns
// it on and WebView2 gives back what it can (caches, decoded images, the graphics process's spare memory);
// back on screen it's turned off again. Microsoft's API for exactly this (ICoreWebView2_19 MemoryUsageTargetLevel).
// a no-op elsewhere, or on a WebView2 runtime too old to have it
#[tauri::command]
pub fn set_memory_saver(app: tauri::AppHandle, on: bool) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let Some(win) = app.get_webview_window("main") else { return };
        let _ = win.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows_core::Interface;
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let Ok(core19) = core.cast::<ICoreWebView2_19>() else { return };
            let level = if on { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            let _ = core19.SetMemoryUsageTargetLevel(level);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, on);
    }
}

// Tell WebView2 the page isn't on screen, the way a browser treats a background tab: it stops drawing and
// painting entirely (document.hidden turns true), while audio keeps playing. WebView2 doesn't do this by itself
// for a hidden or minimized window, so it's set here: hidden to the tray (main.rs CloseRequested, and Start
// minimized in main.js), minimized while lurking (lurk-mode.js). Visible again in tray::restore_window, by lurk
// mode, and on any focus (main.rs, a safety net: a focused window is on screen). a no-op elsewhere
#[tauri::command]
pub fn set_page_visible(app: tauri::AppHandle, visible: bool) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let Some(win) = app.get_webview_window("main") else { return };
        let _ = win.with_webview(move |wv| unsafe {
            let _ = wv.controller().SetIsVisible(visible.into());
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, visible);
    }
}

// Skinned right-click menu. WebView2 draws its own native (light, Windows-styled) context menu, which is where the
// chat box's spelling suggestions live. Its ContextMenuRequested event hands over that menu's items (suggestions,
// Cut/Copy/Paste, ...); we mark it handled so WebView2 doesn't draw it, send the items to the frontend
// (context-menu.js) to draw in the app's style, and when one is picked, hand its command id back to WebView2, which
// runs it exactly as if it had been clicked in the native menu (so a suggestion still replaces the word).
// The pending request is held open with a deferral until the frontend answers. Windows only; elsewhere the
// webview's own menu stays.
#[cfg(windows)]
mod skinned_menu {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::Emitter;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ContextMenuItemCollection, ICoreWebView2ContextMenuRequestedEventArgs,
        ICoreWebView2Deferral, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_CHECK_BOX,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_RADIO, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
    };

    // only ever touched on the UI thread (the event handler and run_on_main_thread both run there)
    thread_local! {
        static PENDING: RefCell<Option<(u64, ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Deferral)>> =
            const { RefCell::new(None) };
    }
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn pwstr(get: impl FnOnce(*mut windows_core::PWSTR) -> windows_core::Result<()>) -> String {
        let mut p = windows_core::PWSTR::null();
        if get(&mut p).is_err() || p.is_null() {
            return String::new();
        }
        webview2_com::take_pwstr(p)
    }

    // the native menu, as plain JSON: { kind, name, label, shortcut, command, enabled, checked, children }
    unsafe fn items_json(items: &ICoreWebView2ContextMenuItemCollection) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        let mut count = 0u32;
        if items.Count(&mut count).is_err() {
            return out;
        }
        for i in 0..count {
            let Ok(item) = items.GetValueAtIndex(i) else { continue };
            let mut kind = Default::default();
            let _ = item.Kind(&mut kind);
            let kind_str = if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR {
                "separator"
            } else if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU {
                "submenu"
            } else if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_CHECK_BOX {
                "checkbox"
            } else if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_RADIO {
                "radio"
            } else {
                "command"
            };
            let mut command = -1i32;
            let _ = item.CommandId(&mut command);
            let mut enabled = windows_core::BOOL(1);
            let _ = item.IsEnabled(&mut enabled);
            let mut checked = windows_core::BOOL(0);
            let _ = item.IsChecked(&mut checked);
            let children = if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU {
                item.Children().map(|c| items_json(&c)).unwrap_or_default()
            } else {
                Vec::new()
            };
            out.push(serde_json::json!({
                "kind": kind_str,
                "name": pwstr(|p| item.Name(p)),
                "label": pwstr(|p| item.Label(p)),
                "shortcut": pwstr(|p| item.ShortcutKeyDescription(p)),
                "command": command,
                "enabled": enabled.as_bool(),
                "checked": checked.as_bool(),
                "children": children,
            }));
        }
        out
    }

    // finish the open request, running `command` (or nothing, for < 0). a stale id (a newer menu replaced it) is ignored
    pub fn finish(id: u64, command: i32) {
        PENDING.with(|p| {
            let mut p = p.borrow_mut();
            if !matches!(p.as_ref(), Some((pid, _, _)) if *pid == id) {
                return;
            }
            let (_, args, deferral) = p.take().unwrap();
            unsafe {
                if command >= 0 {
                    let _ = args.SetSelectedCommandId(command);
                }
                let _ = deferral.Complete();
            }
        });
    }

    pub fn install(app: &tauri::AppHandle) {
        use tauri::Manager;
        let Some(win) = app.get_webview_window("main") else { return };
        let handle = app.clone();
        let _ = win.with_webview(move |wv| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
            use windows_core::Interface;
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            // ContextMenuRequested needs WebView2 runtime 1.0.1185+; older ones just keep the native menu
            let Ok(core11) = core.cast::<ICoreWebView2_11>() else { return };
            let handler = webview2_com::ContextMenuRequestedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let items = match args.MenuItems() {
                    Ok(c) => items_json(&c),
                    Err(_) => return Ok(()),
                };
                if items.is_empty() {
                    return Ok(());
                }
                let Ok(deferral) = args.GetDeferral() else { return Ok(()) };
                args.SetHandled(true)?;
                // a menu still open (right-clicked again) closes without running anything
                if let Some(old) = PENDING.with(|p| p.borrow().as_ref().map(|(id, _, _)| *id)) {
                    finish(old, -1);
                }
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                PENDING.with(|p| *p.borrow_mut() = Some((id, args.clone(), deferral)));
                if handle.emit("skinned-context-menu", serde_json::json!({ "id": id, "items": items })).is_err() {
                    finish(id, -1);
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core11.add_ContextMenuRequested(&handler, &mut token);
        });
    }
}

// called once from setup()
pub fn install_skinned_context_menu(app: &tauri::AppHandle) {
    #[cfg(windows)]
    skinned_menu::install(app);
    #[cfg(not(windows))]
    let _ = app;
}

// the frontend's answer to a "skinned-context-menu" event: the picked item's command id, or -1 for dismissed
#[tauri::command]
pub fn context_menu_choose(app: tauri::AppHandle, id: u64, command: i32) {
    #[cfg(windows)]
    {
        let _ = app.run_on_main_thread(move || skinned_menu::finish(id, command));
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, command);
    }
}

// Spelling suggestions for the skinned menu. WebView2 does put the spelling suggestions in the menu it hands over,
// but with empty labels (Chromium fills them in from Windows' spell checker after the event has fired, and never
// for a menu the app draws itself), so the frontend asks Windows' spell checker (the same one Chromium uses)
// directly. `lang` is a BCP-47 tag like "en-US"; an unsupported one falls back to en-US. Empty on failure / elsewhere
#[tauri::command]
pub async fn spell_suggest(word: String, lang: String, max: usize) -> Vec<String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || spell_suggest_blocking(&word, &lang, max.min(8)))
            .await
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = (word, lang, max);
        Vec::new()
    }
}

#[cfg(windows)]
fn spell_suggest_blocking(word: &str, lang: &str, max: usize) -> Vec<String> {
    use windows::core::HSTRING;
    use windows::Win32::Globalization::{ISpellCheckerFactory, SpellCheckerFactory};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    let word = word.trim();
    if word.is_empty() || max == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    unsafe {
        let inited = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        (|| -> windows::core::Result<()> {
            let factory: ISpellCheckerFactory = CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER)?;
            let tag = if factory.IsSupported(&HSTRING::from(lang))?.as_bool() { lang } else { "en-US" };
            let checker = factory.CreateSpellChecker(&HSTRING::from(tag))?;
            let list = checker.Suggest(&HSTRING::from(word))?;
            while out.len() < max {
                let mut item = [windows::core::PWSTR::null()];
                let mut fetched = 0u32;
                if list.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                    break;
                }
                let s = item[0].to_string().unwrap_or_default();
                CoTaskMemFree(Some(item[0].0 as *const _));
                if !s.is_empty() && s != word {
                    out.push(s);
                }
            }
            Ok(())
        })()
        .ok();
        if inited {
            CoUninitialize();
        }
    }
    out
}

// Settings > App > Developer tools. Release builds start with WebView2's developer tools switched off in every
// window (main and picture-in-picture), so Inspect and Ctrl+Shift+I do nothing: "paste this into Inspect" is how
// scammers take over accounts. The setting turns them back on. Debug builds always have them.
// Tauri also injects its own Ctrl+Shift+I handler that calls internal_toggle_devtools, which opens them whatever
// WebView2's switch says; capabilities/*.json deny that command, leaving WebView2's own shortcut (which obeys it)
static DEVTOOLS_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// applies the current policy to one webview. also run for every page load (main.rs on_page_load), so windows
// opened later (picture-in-picture) start with it too
pub fn apply_devtools_policy<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let _ = webview.with_webview(set_devtools_on_platform);
}

fn set_devtools_on_platform(wv: tauri::webview::PlatformWebview) {
    #[cfg(windows)]
    unsafe {
        let on = DEVTOOLS_ON.load(std::sync::atomic::Ordering::Relaxed) || cfg!(debug_assertions);
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetAreDevToolsEnabled(on.into());
    }
    #[cfg(not(windows))]
    {
        let _ = wv;
    }
}

// every open window now (startup, or the setting changed)
pub fn apply_devtools_policy_all(app: &tauri::AppHandle) {
    use tauri::Manager;
    for win in app.webview_windows().values() {
        let _ = win.with_webview(set_devtools_on_platform);
    }
}

#[tauri::command]
pub fn set_devtools_enabled(app: tauri::AppHandle, on: bool) {
    DEVTOOLS_ON.store(on, std::sync::atomic::Ordering::Relaxed);
    apply_devtools_policy_all(&app);
}

// Ctrl+Shift+I / F12 (main.js). Release builds turn off WebView2's own shortcuts, and Tauri's built-in
// toggle is denied in capabilities/*.json because it ignores the setting, so this is the one way in from
// the keyboard: it opens the developer tools for the window it came from, only while the setting is on
#[tauri::command]
pub fn open_devtools(webview: tauri::Webview) {
    if DEVTOOLS_ON.load(std::sync::atomic::Ordering::Relaxed) || cfg!(debug_assertions) {
        webview.open_devtools();
    }
}

// ---- turning the screen on a phone (the player's rotate button, mobile.js) ----
// Android lets an app ask for an orientation: "landscape" or "portrait" holds the screen that way (either way
// up, by the phone's sensor) whatever the phone's tilt; "auto" hands it back to the phone (leaving a stream).
// The call goes to the app's Android activity on its own thread. Other platforms: nothing to do
#[tauri::command]
pub fn set_orientation(webview: tauri::Webview, mode: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // ActivityInfo.SCREEN_ORIENTATION_*: SENSOR_LANDSCAPE 6, SENSOR_PORTRAIT 7, UNSPECIFIED -1
        let value: i32 = match mode.as_str() {
            "landscape" => 6,
            "portrait" => 7,
            _ => -1,
        };
        webview
            .with_webview(move |w| {
                w.jni_handle().exec(move |env, activity, _webview| {
                    android_set_orientation(env, activity, value);
                });
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, mode);
    }
    Ok(())
}

#[cfg(target_os = "android")]
fn android_set_orientation(env: &mut jni::JNIEnv, activity: &jni::objects::JObject, value: i32) {
    if env
        .call_method(activity, "setRequestedOrientation", "(I)V", &[jni::objects::JValue::Int(value)])
        .is_err()
    {
        // a Java exception is left pending on failure; clear it so it can't surface somewhere unrelated
        let _ = env.exception_clear();
    }
}

// ---- the phone's status and navigation bars (mobile.js) ----
// Watching sideways, Frosty gives the video the whole screen: the bars at the top and bottom hide, and a swipe
// from the edge shows them for a moment. Upright, and everywhere else, they're back. Other platforms: nothing
#[tauri::command]
pub fn set_system_bars(webview: tauri::Webview, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        webview
            .with_webview(move |w| {
                w.jni_handle().exec(move |env, activity, _webview| {
                    if android_system_bars(env, activity, visible).is_err() {
                        let _ = env.exception_clear();
                    }
                });
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, visible);
    }
    Ok(())
}

#[cfg(target_os = "android")]
fn android_system_bars(env: &mut jni::JNIEnv, activity: &jni::objects::JObject, visible: bool) -> jni::errors::Result<()> {
    use jni::objects::JValue;
    let window = env.call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?.l()?;
    let sdk = env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?.i()?;
    if sdk >= 30 {
        // Android 11+: WindowInsetsController
        let ctrl = env
            .call_method(&window, "getInsetsController", "()Landroid/view/WindowInsetsController;", &[])?
            .l()?;
        if ctrl.is_null() {
            return Ok(());
        }
        let bars = env.call_static_method("android/view/WindowInsets$Type", "systemBars", "()I", &[])?.i()?;
        if visible {
            env.call_method(&ctrl, "show", "(I)V", &[JValue::Int(bars)])?;
        } else {
            // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE = 2: a swipe shows them briefly over the video
            env.call_method(&ctrl, "setSystemBarsBehavior", "(I)V", &[JValue::Int(2)])?;
            env.call_method(&ctrl, "hide", "(I)V", &[JValue::Int(bars)])?;
        }
    } else {
        // Android 8-10: the older View flags (IMMERSIVE_STICKY, FULLSCREEN, HIDE_NAVIGATION and the layout flags)
        let decor = env.call_method(&window, "getDecorView", "()Landroid/view/View;", &[])?.l()?;
        let flags = if visible { 0 } else { 4096 | 4 | 2 | 256 | 512 | 1024 };
        env.call_method(&decor, "setSystemUiVisibility", "(I)V", &[JValue::Int(flags)])?;
    }
    Ok(())
}

// ---- picture-in-picture on a phone (mobile.js, the player's PiP button and Options) ----
// Android's own floating player: the app's whole window shrinks to a small video window over other apps, and
// mobile.js shows only the video while it's that small. `auto`: go into it by itself when you leave the app
// while watching (Android 12+; older versions only go in with the button). `enter_now`: go into it now.
// Needs android:supportsPictureInPicture on the activity, which the Android build adds (build-android.yml)
#[tauri::command]
pub fn set_pip(webview: tauri::Webview, auto: bool, enter_now: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        webview
            .with_webview(move |w| {
                w.jni_handle().exec(move |env, activity, _webview| {
                    if android_pip(env, activity, auto, enter_now).is_err() {
                        let _ = env.exception_clear();
                    }
                });
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, auto, enter_now);
    }
    Ok(())
}

#[cfg(target_os = "android")]
fn android_pip(env: &mut jni::JNIEnv, activity: &jni::objects::JObject, auto: bool, enter_now: bool) -> jni::errors::Result<()> {
    use jni::objects::JValue;
    let sdk = env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")?.i()?;
    if sdk < 26 {
        return Ok(()); // picture-in-picture for apps arrived in Android 8
    }
    let builder = env.new_object("android/app/PictureInPictureParams$Builder", "()V", &[])?;
    let ratio = env.new_object("android/util/Rational", "(II)V", &[JValue::Int(16), JValue::Int(9)])?;
    env.call_method(&builder, "setAspectRatio",
        "(Landroid/util/Rational;)Landroid/app/PictureInPictureParams$Builder;", &[JValue::Object(&ratio)])?;
    if sdk >= 31 {
        env.call_method(&builder, "setAutoEnterEnabled",
            "(Z)Landroid/app/PictureInPictureParams$Builder;", &[JValue::Bool(auto as u8)])?;
        env.call_method(&builder, "setSeamlessResizeEnabled",
            "(Z)Landroid/app/PictureInPictureParams$Builder;", &[JValue::Bool(1)])?;
    }
    let params = env.call_method(&builder, "build", "()Landroid/app/PictureInPictureParams;", &[])?.l()?;
    env.call_method(activity, "setPictureInPictureParams",
        "(Landroid/app/PictureInPictureParams;)V", &[JValue::Object(&params)])?;
    if enter_now {
        env.call_method(activity, "enterPictureInPictureMode",
            "(Landroid/app/PictureInPictureParams;)Z", &[JValue::Object(&params)])?;
    }
    Ok(())
}
