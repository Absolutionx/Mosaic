// system tray icon and menu: restore (double-click / Open) and Quit. also the path the
// single-instance plugin routes a second launch through (see main.rs)

use tauri::{AppHandle, Manager};

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "Open Mosaic", true, None::<&str>)?;
    let sep  = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .tooltip("Mosaic")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => restore_window(app),
            "quit" => do_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // left double-click restores the window (single click opens the menu)
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                restore_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// ---- keep the window on its monitor across monitors sleeping ----
// Windows treats a monitor that powers off (especially over DisplayPort) as unplugged and moves every
// window on it, hidden ones included, to a monitor that's still on. so a window hidden to the tray at night
// woke up on the second monitor. where it was is saved when it's hidden to the tray and put back on restore,
// as long as that spot is on a monitor connected right now (otherwise Windows' own placement is kept)
#[derive(Clone, Copy)]
struct Placement {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    maximized: bool,
}
static SAVED_PLACEMENT: std::sync::Mutex<Option<Placement>> = std::sync::Mutex::new(None);

// called when the main window is hidden to the tray (CloseRequested in main.rs)
pub fn remember_placement<R: tauri::Runtime>(w: &tauri::Window<R>) {
    let (Ok(position), Ok(size)) = (w.outer_position(), w.outer_size()) else { return };
    let maximized = w.is_maximized().unwrap_or(false);
    if let Ok(mut saved) = SAVED_PLACEMENT.lock() {
        *saved = Some(Placement { position, size, maximized });
    }
}

// is the saved window's centre on a monitor that's connected right now?
fn placement_on_connected_monitor<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, p: &Placement) -> bool {
    let cx = p.position.x as i64 + p.size.width as i64 / 2;
    let cy = p.position.y as i64 + p.size.height as i64 / 2;
    w.available_monitors().map(|monitors| {
        monitors.iter().any(|m| {
            let (mp, ms) = (m.position(), m.size());
            cx >= mp.x as i64 && cx < mp.x as i64 + ms.width as i64
                && cy >= mp.y as i64 && cy < mp.y as i64 + ms.height as i64
        })
    }).unwrap_or(false)
}

// used by the tray menu, tray double-click, and the single-instance second-launch callback
pub fn restore_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let saved = SAVED_PLACEMENT.lock().ok().and_then(|s| *s);
        let mut maximize = false;
        if let Some(p) = saved {
            if placement_on_connected_monitor(&w, &p) {
                // un-maximize first so the move sticks; re-maximized below, on the right monitor
                let _ = w.unmaximize();
                let _ = w.set_size(p.size);
                let _ = w.set_position(p.position);
                maximize = p.maximized;
            }
        }
        let _ = w.show();
        if maximize {
            let _ = w.maximize();
        }
        let _ = w.set_focus();
    }
}

// previously also killed a running streamlink/mpv child so it wouldn't orphan, unneeded now
// that playback runs entirely in the webview via hls.js
pub fn do_quit(app: &AppHandle) {
    // mark that we're really quitting, so the main window's CloseRequested handler lets the window
    // close instead of hiding it to tray (see AppFlags in main.rs)
    let flags = app.state::<crate::AppFlags>();
    flags.quitting.store(true, std::sync::atomic::Ordering::Relaxed);
    app.exit(0);
}
