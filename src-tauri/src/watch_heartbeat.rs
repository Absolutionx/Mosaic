// Core "watch heartbeat" — ported from the StreamNook project's watch_heartbeat_service.rs.
//
// Reports exactly what the official web player reports: ONE minute-watched event per minute for the
// single channel the user is actually watching, while it's playing. The minute goes out on BOTH
// watch-reporting paths, because Twitch's spade ingestion is split:
//   - the raw spade `/track` POST credits DROP progress, and
//   - the same event with a `location`/`player` field on that endpoint credits CHANNEL POINTS.
// Reporting one path only silently stops the other kind of crediting. This is the piece that makes
// channel points accrue and drop progress advance for the on-screen stream. It never reports more than
// one channel, never an off-screen one, and never claims anything.
//
// Divergence from StreamNook: their drops path also fires a gzip'd `sendSpadeEvents` GraphQL mutation
// as a redundant backup behind the raw spade POST. We keep only the raw POST (the one their comments
// note "credits reliably") to avoid a gzip dependency. If drops ever stop crediting, that backup is
// the thing to add.
//
// Requires the Twitch device-login token (same one pins/predictions use). No device login -> no token
// -> nothing is reported, exactly like not being logged in on the web.

use base64::engine::general_purpose;
use base64::Engine;
use reqwest::Client;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::RwLock;

const SPADE_URL: &str = "https://spade.twitch.tv/track";
const BROADCAST_REFRESH: Duration = Duration::from_secs(900);

#[derive(Clone)]
struct WatchTarget {
    channel_id: String,
    login: String,
    broadcast_id: Option<String>,
    game_id: String,
    game_name: String,
    broadcast_checked_at: Option<Instant>,
}

pub struct WatchHeartbeatService {
    client: Client,
    app: AppHandle,
    target: RwLock<Option<WatchTarget>>,
    playing: AtomicBool,
    cached_user_id: RwLock<Option<(String, String)>>,
    loop_started: AtomicBool,
}

impl WatchHeartbeatService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            client: Client::new(),
            app,
            target: RwLock::new(None),
            playing: AtomicBool::new(false),
            cached_user_id: RwLock::new(None),
            loop_started: AtomicBool::new(false),
        }
    }

    // Spawns the 60s tick loop (idempotent). Ticks no-op with no target or while paused.
    pub fn start(self: &Arc<Self>) {
        if self.loop_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // consume the immediate first tick so the first minute lands ~1 min in, like the web player
            tick.tick().await;
            loop {
                tick.tick().await;
                service.tick().await;
            }
        });
    }

    pub async fn set_target(&self, channel_id: String, login: String) {
        let mut target = self.target.write().await;
        let previous = target.as_ref().map(|t| t.channel_id.clone());
        if previous.as_deref() != Some(channel_id.as_str()) {
            *target = Some(WatchTarget {
                channel_id,
                login,
                broadcast_id: None,
                game_id: String::new(),
                game_name: String::new(),
                broadcast_checked_at: None,
            });
        }
        self.playing.store(true, Ordering::SeqCst);
    }

    pub async fn clear_target(&self) {
        self.playing.store(false, Ordering::SeqCst);
        self.target.write().await.take();
    }

    pub fn set_playing(&self, playing: bool) {
        self.playing.store(playing, Ordering::SeqCst);
    }

    async fn tick(&self) {
        if !self.playing.load(Ordering::SeqCst) {
            return;
        }
        let snapshot = { self.target.read().await.clone() };
        let Some(mut target) = snapshot else {
            return;
        };
        // no device token => no spade surface to report on; watching earns nothing (as if logged out)
        let Some(token) = crate::twitch_device_auth::get_device_token(&self.app).await else {
            return;
        };

        // resolve/refresh broadcast id + game info
        let stale = target
            .broadcast_checked_at
            .map(|at| at.elapsed() > BROADCAST_REFRESH)
            .unwrap_or(true);
        if stale {
            match self.fetch_stream_info(&target.channel_id, &token).await {
                Ok(Some((broadcast_id, game_id, game_name))) => {
                    target.broadcast_id = Some(broadcast_id);
                    target.game_id = game_id;
                    target.game_name = game_name;
                    target.broadcast_checked_at = Some(Instant::now());
                }
                Ok(None) => {
                    // not live (offline/VOD/ended): nothing to report; re-check next stale window
                    target.broadcast_id = None;
                    target.broadcast_checked_at = Some(Instant::now());
                }
                Err(e) => {
                    // a FAILED fetch must NOT refresh the stamp (that would extend a dead broadcast's
                    // crediting window); leave it stale so the next tick retries
                    eprintln!("[heartbeat] stream info fetch failed: {e}");
                }
            }
            let mut current = self.target.write().await;
            match current.as_mut() {
                Some(t) if t.channel_id == target.channel_id => *t = target.clone(),
                _ => return,
            }
        }
        let Some(broadcast_id) = target.broadcast_id.clone() else {
            return;
        };

        if let Err(e) = self.send_minute_watched(&target, &broadcast_id, &token).await {
            eprintln!("[heartbeat] drops send failed for {}: {e}", target.login);
        }
        if let Err(e) = self
            .send_minute_watched_legacy(&target, &broadcast_id, &token)
            .await
        {
            eprintln!("[heartbeat] points send failed for {}: {e}", target.login);
        }
    }

    // one GQL read: live broadcast id + game info. None when the channel isn't live.
    async fn fetch_stream_info(
        &self,
        channel_id: &str,
        token: &str,
    ) -> Result<Option<(String, String, String)>, String> {
        let query = "query GetStreamInfo($channelID: ID!) { user(id: $channelID) { stream { id game { id name } } } }";
        let response = self
            .client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({ "query": query, "variables": { "channelID": channel_id } }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        let stream = &body["data"]["user"]["stream"];
        let Some(id) = stream["id"].as_str() else {
            return Ok(None);
        };
        Ok(Some((
            id.to_string(),
            stream["game"]["id"].as_str().unwrap_or_default().to_string(),
            stream["game"]["name"].as_str().unwrap_or_default().to_string(),
        )))
    }

    async fn user_id(&self, token: &str) -> Result<String, String> {
        if let Some((cached_token, id)) = self.cached_user_id.read().await.as_ref() {
            if cached_token == token {
                return Ok(id.clone());
            }
        }
        let response = self
            .client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {token}"))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        let id = body["user_id"]
            .as_str()
            .ok_or_else(|| "token validation returned no user id".to_string())?
            .to_string();
        *self.cached_user_id.write().await = Some((token.to_string(), id.clone()));
        Ok(id)
    }

    // one 60s heartbeat means any pooled keep-alive has usually been closed; retry once on a transport
    // error (a real HTTP status returns Ok). Duplicate minute-watched is harmless (Twitch dedupes).
    async fn send_once_retrying<F>(make: F) -> reqwest::Result<reqwest::Response>
    where
        F: Fn() -> reqwest::RequestBuilder,
    {
        match make().send().await {
            Ok(resp) => Ok(resp),
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(250)).await;
                make().send().await
            }
        }
    }

    // DROPS path: raw spade ingest POST (plain base64 form, no auth header — the user_id is in the
    // payload). HTTP 204 = accepted.
    async fn send_minute_watched(
        &self,
        target: &WatchTarget,
        broadcast_id: &str,
        token: &str,
    ) -> Result<bool, String> {
        let user_id = self.user_id(token).await?;
        let payload = json!([{
            "event": "minute-watched",
            "properties": {
                "broadcast_id": broadcast_id,
                "channel_id": target.channel_id,
                "channel": target.login,
                "client_time": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
                "game": target.game_name,
                "game_id": target.game_id,
                "hidden": false,
                "is_live": true,
                "live": true,
                "logged_in": true,
                "minutes_logged": 1,
                "muted": false,
                "user_id": user_id
            }
        }]);
        let encoded = general_purpose::STANDARD
            .encode(serde_json::to_string(&payload).map_err(|e| e.to_string())?.as_bytes());
        let resp = Self::send_once_retrying(|| {
            self.client
                .post(SPADE_URL)
                .form(&[("data", encoded.as_str())])
                .timeout(Duration::from_secs(15))
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(resp.status().as_u16() == 204)
    }

    // POINTS path: same minute on the same endpoint, but with `location`/`player` set (required there,
    // absent from the drops event). Plain base64 form. HTTP 204 = accepted.
    async fn send_minute_watched_legacy(
        &self,
        target: &WatchTarget,
        broadcast_id: &str,
        token: &str,
    ) -> Result<bool, String> {
        let user_id = self.user_id(token).await?;
        let payload = json!([{
            "event": "minute-watched",
            "properties": {
                "broadcast_id": broadcast_id,
                "channel_id": target.channel_id,
                "channel": target.login,
                "hidden": false,
                "live": true,
                "location": "channel",
                "logged_in": true,
                "muted": false,
                "player": "site",
                "user_id": user_id
            }
        }]);
        let encoded = general_purpose::STANDARD
            .encode(serde_json::to_string(&payload).map_err(|e| e.to_string())?.as_bytes());
        let resp = Self::send_once_retrying(|| {
            self.client
                .post(SPADE_URL)
                .form(&[("data", encoded.as_str())])
                .timeout(Duration::from_secs(15))
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(resp.status().as_u16() == 204)
    }
}

// --- Tauri commands (frontend drives the target from the stream lifecycle) ---

#[tauri::command]
pub async fn heartbeat_set_target(
    channel_id: String,
    login: String,
    state: State<'_, Arc<WatchHeartbeatService>>,
) -> Result<(), String> {
    state.set_target(channel_id, login).await;
    Ok(())
}

#[tauri::command]
pub async fn heartbeat_clear_target(
    state: State<'_, Arc<WatchHeartbeatService>>,
) -> Result<(), String> {
    state.clear_target().await;
    Ok(())
}

#[tauri::command]
pub fn heartbeat_set_playing(playing: bool, state: State<'_, Arc<WatchHeartbeatService>>) {
    state.set_playing(playing);
}
