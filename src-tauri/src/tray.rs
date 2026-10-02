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
struct Rect {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
}
impl Rect {
    fn center(&self) -> (i64, i64) {
        (self.position.x as i64 + self.size.width as i64 / 2, self.position.y as i64 + self.size.height as i64 / 2)
    }
}
#[derive(Clone, Copy)]
struct Placement {
    normal: Option<Rect>, // the window's normal (not maximized) bounds
    maximized: bool,
    center: (i64, i64),   // where the window was, to find its monitor
}
// the last normal bounds, updated whenever the window moves / resizes while not maximized. needed because a
// maximized window's own size is the maximized one (slightly LARGER than the screen on Windows): saving
// that as the normal size made "restore down" give a screen-sized window hanging off the edges
static LAST_NORMAL: std::sync::Mutex<Option<Rect>> = std::sync::Mutex::new(None);
static SAVED_PLACEMENT: std::sync::Mutex<Option<Placement>> = std::sync::Mutex::new(None);

// WindowEvent::Moved / Resized (main.rs)
pub fn track_normal_bounds<R: tauri::Runtime>(w: &tauri::Window<R>) {
    // only a genuinely normal window: not maximized, minimized, hidden, or FULLSCREEN (a fullscreen window
    // isn't "maximized", but its screen-sized rect must never become the normal bounds either)
    if w.is_maximized().unwrap_or(false) || w.is_minimized().unwrap_or(false)
        || w.is_fullscreen().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
        return;
    }
    if let (Ok(position), Ok(size)) = (w.outer_position(), w.outer_size()) {
        if let Ok(mut last) = LAST_NORMAL.lock() {
            *last = Some(Rect { position, size });
        }
    }
}

// called when the main window is hidden to the tray (CloseRequested in main.rs)
pub fn remember_placement<R: tauri::Runtime>(w: &tauri::Window<R>) {
    let (Ok(position), Ok(size)) = (w.outer_position(), w.outer_size()) else { return };
    let current = Rect { position, size };
    let maximized = w.is_maximized().unwrap_or(false);
    let normal = if maximized { LAST_NORMAL.lock().ok().and_then(|l| *l) } else { Some(current) };
    if let Ok(mut saved) = SAVED_PLACEMENT.lock() {
        *saved = Some(Placement { normal, maximized, center: current.center() });
    }
}

// the connected monitor containing a point, as (position, size)
fn monitor_at<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, (cx, cy): (i64, i64)) -> Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)> {
    w.available_monitors().ok()?.into_iter().find_map(|m| {
        let (mp, ms) = (*m.position(), *m.size());
        let inside = cx >= mp.x as i64 && cx < mp.x as i64 + ms.width as i64
            && cy >= mp.y as i64 && cy < mp.y as i64 + ms.height as i64;
        inside.then_some((mp, ms))
    })
}

// used by the tray menu, tray double-click, and the single-instance second-launch callback
pub fn restore_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let saved = SAVED_PLACEMENT.lock().ok().and_then(|s| *s);
        let mut maximize = false;
        if let Some(p) = saved {
            // only when the monitor it was on is connected right now (else Windows' own placement is kept)
            if let Some((mp, ms)) = monitor_at(&w, p.center) {
                // its normal bounds, if known, sane (fit the screen) and on that same monitor; otherwise a
                // centered window at 80% of the monitor. this also repairs normal bounds that were saved
                // as the maximized size by an earlier version
                let usable = p.normal.filter(|r| {
                    r.size.width <= ms.width && r.size.height <= ms.height
                        && monitor_at(&w, r.center()).map(|(p2, _)| p2 == mp).unwrap_or(false)
                });
                let normal = usable.unwrap_or_else(|| {
                    let (width, height) = (ms.width * 4 / 5, ms.height * 4 / 5);
                    Rect {
                        position: tauri::PhysicalPosition::new(mp.x + ((ms.width - width) / 2) as i32, mp.y + ((ms.height - height) / 2) as i32),
                        size: tauri::PhysicalSize::new(width, height),
                    }
                });
                // un-maximize first so the move sticks; re-maximized below, on the right monitor, so restore
                // down later returns to these normal bounds
                let _ = w.unmaximize();
                let _ = w.set_size(normal.size);
                let _ = w.set_position(normal.position);
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
