#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// Mosaic, Rust backend.
//
// playback (streamlink -> local HTTP relay -> MSE in the webview) lives in stream_relay.rs,
// including why it's built that way. this file wires up Tauri: app state, command registration,
// and the Helix commands that don't yet warrant their own module

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

mod chat;
mod chat_commands;
mod deps_check;
mod eventsub;
mod helix;
mod kick;
mod kick_chat;
mod kick_oauth;
mod link_preview;
mod notify_prefs;
mod oauth;
mod pubsub;
mod drop_prefs;
mod seventv_cosmetics;
mod whispers;
mod stream_relay;
mod seventv_events;
mod song_id;
mod track_id;
mod user_notes;
mod tray;
mod twitch_device_auth;
mod vod_progress;
mod watch_heartbeat;

// state for the active chat session: the oneshot sender that signals the running chat task to
// disconnect, the mpsc sender that pushes outgoing PRIVMSGs into it, and the logged-in user's
// credentials (if any) so the UI can tell whether sending is even possible
pub(crate) struct ChatState {
    pub(crate) stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub(crate) outgoing_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<chat::OutgoingMessage>>>,
    pub(crate) auth: Mutex<Option<chat::AuthCredentials>>,
}

impl Default for ChatState {
    fn default() -> Self {
        ChatState {
            stop_tx: Mutex::new(None),
            outgoing_tx: Mutex::new(None),
            auth: Mutex::new(None),
        }
    }
}

// one connection per watched channel; torn down on Stop
pub(crate) struct EventSubState {
    pub(crate) stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for EventSubState {
    fn default() -> Self {
        EventSubState { stop_tx: Mutex::new(None) }
    }
}

// account-level EventSub connection (whispers): started at login/startup and kept alive regardless of
// what's being watched, so whispers arrive app-wide. Separate from EventSubState, whose connection is
// per-channel and torn down on every channel switch.
pub(crate) struct WhisperEventSubState {
    pub(crate) stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for WhisperEventSubState {
    fn default() -> Self {
        WhisperEventSubState { stop_tx: Mutex::new(None) }
    }
}

// Runtime flags shared with the window-close handler.
//   close_to_tray: when true, the window's X hides to the tray (app keeps running to receive whispers
//     and live/category notifications) instead of quitting. Set from the frontend setting.
//   quitting: set true when the user chooses Quit (tray menu / real exit) so the close handler lets
//     the window actually close instead of hiding it.
pub(crate) struct AppFlags {
    pub(crate) close_to_tray: std::sync::atomic::AtomicBool,
    pub(crate) quitting: std::sync::atomic::AtomicBool,
}

impl Default for AppFlags {
    fn default() -> Self {
        AppFlags {
            // default ON: minimize to tray (the requested default). the frontend can flip it off.
            close_to_tray: std::sync::atomic::AtomicBool::new(true),
            quitting: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

// one connection per watched channel's emote set; torn down on Stop/switch, same pattern as EventSubState for a separate service
pub(crate) struct SevenTvEventsState {
    pub(crate) stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for SevenTvEventsState {
    fn default() -> Self {
        SevenTvEventsState { stop_tx: Mutex::new(None) }
    }
}

// true until the first time the frontend asks. distinguishes a real process launch from an
// in-process webview reload (F5): a reload hits the SAME host, so it sees the flag already cleared,
// while a fresh launch is a new process with a fresh `true`. this is what lets F5 resume the stream
// while a cold start correctly lands on Home. backend-side rather than sessionStorage on purpose: it
// keys off real process identity, so no webview storage-lifetime quirk (WebView2 vs WebKit) can fool it
struct LaunchState {
    fresh: AtomicBool,
}

impl Default for LaunchState {
    fn default() -> Self {
        Self { fresh: AtomicBool::new(true) }
    }
}

// whether THIS call is the first since the process started; clears the flag so every later call (i.e. every reload) returns false
#[tauri::command]
fn take_is_fresh_launch(state: State<LaunchState>) -> bool {
    state.fresh.swap(false, Ordering::SeqCst)
}

fn main() {
    // kill the WebView2 white flash on startup (Windows): its surface renders white underneath web
    // content until the first paint, visible for a frame or two when the maximized window appears. the
    // native window backgroundColor doesn't cover this surface, and the WebView2 API path can still
    // flicker; Microsoft documents this env var (read before the webview is created) as the reliable fix.
    // format is AARRGGBB, must be 8 digits or it's treated as transparent. harmless on non-Windows
    std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF0E0E10");

    // must happen before any TLS connection (before the chat WebSocket connects), rustls 0.23+ panics
    // on first use with no CryptoProvider installed. a process-wide, one-time setup call, unrelated to Tauri
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default()
        // must be the FIRST plugin registered (per its docs) so it runs before anything spawns windows/tray
        // icons for what would be a second, separate process. on a second launch this callback runs INSIDE
        // the already-running instance (the new process's main() never proceeds, the plugin exits it), so
        // restore_window brings the existing window forward instead of a second one appearing
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::restore_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // process (relaunch after update) and os (platform() gate in the updater banner). cross-platform, so registered unconditionally
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init());

    // auto-updater: Windows only. macOS/Linux ship via the GitHub Actions .dmg and don't self-update,
    // so the plugin isn't registered there, keeps the update-check path off platforms with no update endpoint
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            tray::setup_tray(app).map_err(|e| e.to_string())?;

            // maximize the still-hidden main window before its first paint, so the webview paints at final size
            // and there's no resize when the frontend reveals it. the window is created hidden (visible:false)
            // and shown from JS only after the dark UI has painted; that, not a background color, is what actually
            // prevents the WebView2 white-surface flash that launching maximized otherwise causes (see tauri#14068)
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.maximize();
            }

            // watch heartbeat: reports minute-watched so Twitch drops + channel points accrue while
            // watching. needs the device-login token (opt-in); no-ops without it. must be created here
            // since it needs the AppHandle to read that token.
            let heartbeat = std::sync::Arc::new(watch_heartbeat::WatchHeartbeatService::new(
                app.handle().clone(),
            ));
            heartbeat.start();
            app.manage(heartbeat);

            let pubsub = std::sync::Arc::new(pubsub::PubSubService::new(app.handle().clone()));
            app.manage(pubsub);

            let seventv = std::sync::Arc::new(seventv_cosmetics::SevenTvCosmetics::new(app.handle().clone()));
            app.manage(seventv);

            Ok(())
        })
        .manage(LaunchState::default())
        .manage(ChatState::default())
        .manage(EventSubState::default())
        .manage(WhisperEventSubState::default())
        .manage(AppFlags::default())
        .manage(SevenTvEventsState::default())
        .manage(kick_chat::KickChatState::default())
        .manage(std::sync::Arc::new(stream_relay::StreamRelayState::default()))
        .invoke_handler(tauri::generate_handler![
            take_is_fresh_launch,
            track_id::identify_song,
            user_notes::get_user_note,
            user_notes::set_user_note,
            user_notes::get_user_note_ids,
            pubsub::pubsub_set_channel,
            pubsub::pubsub_clear,
            seventv_cosmetics::seventv_cosmetics_set_channel,
            seventv_cosmetics::seventv_cosmetics_clear,
            seventv_cosmetics::get_all_seventv_paints,
            seventv_cosmetics::get_all_seventv_badges,
            whispers::send_whisper,
            whispers::whisper_get_threads,
            whispers::whisper_get_thread,
            whispers::whisper_record,
            whispers::whisper_mark_read,
            whispers::whisper_total_unread,
            drop_prefs::get_hidden_drops,
            drop_prefs::set_drop_hidden,
            watch_heartbeat::heartbeat_set_target,
            watch_heartbeat::heartbeat_clear_target,
            watch_heartbeat::heartbeat_set_playing,
            stream_relay::start_stream,
            kick::get_kick_stream,
            kick::get_kick_channel_chat_info,
            kick::get_kick_live_dvr,
            kick::kick_followed_status,
            kick::kick_top_live_streams,
            kick::kick_live_streams_page,
            kick::kick_top_games,
            kick::kick_streams_for_category,
            kick::kick_streams_for_game_names,
            kick::kick_search_categories,
            kick::kick_category_viewer_counts,
            kick::kick_channel_emotes,
            kick::kick_channel_videos,
            kick::kick_vod_playback,
            kick_oauth::kick_oauth_configured,
            kick_oauth::start_kick_oauth_login,
            kick_oauth::restore_kick_session,
            kick_oauth::kick_logout,
            kick_oauth::kick_send_chat_message,
            kick_chat::start_kick_chat,
            kick_chat::stop_kick_chat,
            stream_relay::get_vod_m3u8_url,
            stream_relay::get_live_m3u8_url,
            stream_relay::stop_stream,
            stream_relay::get_available_qualities,
            stream_relay::get_available_vod_qualities,
            chat_commands::start_chat,
            chat_commands::stop_chat,
            oauth::start_oauth_login,
            notify_prefs::get_notify_channels,
            notify_prefs::set_notify_channels,
            notify_prefs::get_notify_category_targets,
            notify_prefs::set_notify_category_targets,
            vod_progress::get_all_vod_progress,
            vod_progress::get_vod_progress,
            vod_progress::save_vod_progress,
            vod_progress::backfill_vod_progress_metadata,
            vod_progress::dismiss_vod_from_continue,
            oauth::validate_oauth_token,
            oauth::restore_session,
            oauth::logout,
            chat_commands::fetch_global_badges,
            chat_commands::fetch_global_emotes,
            chat_commands::fetch_channel_badges,
            chat_commands::fetch_cheermotes,
            link_preview::fetch_link_preview,
            link_preview::fetch_storyboard_json,
            deps_check::check_stream_deps,
            deps_check::install_stream_deps,
            chat_commands::ban_user,
            chat_commands::unban_user,
            chat_commands::delete_chat_message,
            chat_commands::get_chat_settings,
            chat_commands::update_chat_settings,
            chat_commands::automod_process_message,
            chat_commands::get_user_id_for_login,
            chat_commands::start_eventsub,
            chat_commands::stop_eventsub,
            chat_commands::start_account_eventsub,
            chat_commands::stop_account_eventsub,
            chat_commands::set_close_to_tray,
            chat_commands::start_seventv_events,
            chat_commands::stop_seventv_events,
            chat_commands::send_chat_message,
            chat_commands::set_oauth_credentials,
            helix::get_followed_channels,
            helix::get_pinned_chat_messages,
            helix::get_hype_train,
            helix::get_channel_prediction,
            helix::create_clip,
            helix::get_channel_points,
            helix::get_drops_inventory,
            helix::claim_drop,
            helix::get_watch_streak,
            helix::share_watch_streak,
            helix::get_channel_rewards,
            helix::redeem_reward,
            helix::redeem_highlight_message,
            helix::redeem_random_emote,
            helix::get_channel_emotes,
            helix::get_available_emotes,
            helix::get_active_hype_trains,
            helix::get_resub_notification,
            helix::share_resub,
            helix::unlock_chosen_emote,
            helix::unlock_modified_emote,
            twitch_device_auth::twitch_device_start,
            twitch_device_auth::twitch_device_poll,
            twitch_device_auth::twitch_device_connected,
            twitch_device_auth::twitch_device_logout,
            chat_commands::get_chatters,
            helix::get_streams_for_users,
            helix::get_stream_for_login,
            helix::get_user_by_login,
            helix::get_users_info,
            helix::get_top_live_streams,
            helix::get_live_streams_page,
            helix::get_streams_for_game_names,
            helix::get_top_games,
            helix::get_streams_for_game_id,
            helix::search_categories,
            helix::get_vod_chat_density,
            helix::get_category_viewer_counts,
            helix::get_videos_for_login,
            helix::get_vod_muted_segments,
            helix::get_live_vod_info,
            helix::get_vod_chat
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    use std::sync::atomic::Ordering;
                    let flags = window.app_handle().state::<AppFlags>();
                    let want_tray = flags.close_to_tray.load(Ordering::Relaxed);
                    let quitting = flags.quitting.load(Ordering::Relaxed);

                    if want_tray && !quitting {
                        // minimize to tray instead of quitting: keep the process alive so whispers and
                        // live/category notifications keep arriving. Cancel the real close, hide the
                        // window, and tell the frontend to stop playback so it's lightweight/quiet.
                        api.prevent_close();
                        let _ = window.hide();
                        let _ = window.emit("hidden-to-tray", ());
                        return;
                    }

                    // real quit path: close every PiP window (labels "pip" and "pip-*") so the app
                    // doesn't linger headless with a PiP as its only window
                    for (label, w) in window.app_handle().webview_windows() {
                        if label == "pip" || label.starts_with("pip-") {
                            let _ = w.close();
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    // programmatic teardown: same PiP cleanup as the real-quit path above
                    for (label, w) in window.app_handle().webview_windows() {
                        if label == "pip" || label.starts_with("pip-") {
                            let _ = w.close();
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
