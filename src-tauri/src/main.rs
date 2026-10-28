#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Mosaic on desktop: the app itself is the library (lib.rs), which Android starts through Tauri's mobile entry point
fn main() {
    mosaic_lib::run()
}
