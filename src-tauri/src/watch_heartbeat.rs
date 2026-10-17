// Core "watch heartbeat" — ported from the StreamNook project's watch_heartbeat_service.rs.
//
// Reports exactly what the official web player reports: ONE minute-watched event per minute for the
// single channel the user is actually watching, while it's playing. This is the piece that makes channel
// points accrue and drop progress advance for the on-screen stream. It never reports more than one
// channel, never an off-screen one, and never claims anything.
//
// How the minute reaches Twitch: the web player (checked 10-16-26) no longer posts to spade.twitch.tv at
// all; every spade event, minute-watched included, goes through the GQL `sendSpadeEvents` mutation as a
// gzip'd, base64'd JSON array, sent with the viewer's token. spade.twitch.tv/track still answers 204 to
// anything (even an empty list), so the raw POSTs this used to rely on looked fine while crediting
// stopped. The GQL path is now the primary one; the raw POSTs are still sent as a harmless fallback
// (Twitch dedupes a minute reported twice).
//
// Requires the Twitch device-login token (same one pins/predictions use). No device login -> no token
// -> nothing is reported, exactly like not being logged in on the web.

use base64::engine::general_purpose;
use base64::Engine;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;
use reqwest::Client;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tokio::sync::RwLock;

const SPADE_URL: &str = "https://spade.twitch.tv/track";
const GQL_URL: &str = "https://gql.twitch.tv/gql";
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
    // what the last minute did, for heartbeat_status (Settings / devtools: is watching being credited?)
    last_status: std::sync::Mutex<String>,
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
            last_status: std::sync::Mutex::new("no minute sent yet".into()),
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
            self.set_status("not connected (device login needed), nothing sent".into());
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
            self.set_status(format!("{}: not live (or stream info unavailable), nothing sent", target.login));
            return;
        };

        // primary: the GQL path the web player uses now (credits both points and drops)
        let gql = self.send_minute_watched_gql(&target, &broadcast_id, &token).await;
        if let Err(e) = &gql {
            eprintln!("[heartbeat] gql send failed for {}: {e}", target.login);
        }
        self.set_status(match &gql {
            Ok(code) => format!("{} {}: sendSpadeEvents {code}", chrono::Local::now().format("%H:%M:%S"), target.login),
            Err(e) => format!("{} {}: sendSpadeEvents failed: {e}", chrono::Local::now().format("%H:%M:%S"), target.login),
        });
        // fallback: the old raw spade POSTs
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
            .header("Client-Id", crate::twitch_device_auth::device_client_id())
            .header("Authorization", format!("Bearer {token}"))
            .json(&json!({ "query": query, "variables": { "channelID": channel_id } }))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        // a rejected request (bad token, GQL error) is NOT "offline": report it, so the stamp stays stale and
        // the next tick retries, instead of quietly sending nothing for 15 minutes
        if !status.is_success() || body["data"]["user"].is_null() {
            let msg = body["errors"][0]["message"].as_str().or(body["message"].as_str()).unwrap_or("no data");
            return Err(format!("HTTP {status}: {msg}"));
        }
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

    fn set_status(&self, s: String) {
        if let Ok(mut g) = self.last_status.lock() {
            *g = s;
        }
    }

    // PRIMARY path: the same minute-watched the web player sends, through GQL sendSpadeEvents (gzip + base64
    // JSON array, "twilight" repository), with the viewer's token. Returns the statusCode Twitch's spade
    // answered with (204 = accepted)
    async fn send_minute_watched_gql(
        &self,
        target: &WatchTarget,
        broadcast_id: &str,
        token: &str,
    ) -> Result<i64, String> {
        let user_id = self.user_id(token).await?;
        let payload = json!([{
            "event": "minute-watched",
            "properties": {
                "broadcast_id": broadcast_id,
                "channel_id": target.channel_id,
                "channel": target.login,
                "client_time": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
                "content_mode": "live",
                "game": target.game_name,
                "game_id": target.game_id,
                "category_id": target.game_id,
                "hidden": false,
                "is_live": true,
                "live": true,
                "location": "channel",
                "logged_in": true,
                "minutes_logged": 1,
                "muted": false,
                "player": "site",
                "user_id": user_id
            }
        }]);
        let raw = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&raw).map_err(|e| e.to_string())?;
        let data = general_purpose::STANDARD.encode(gz.finish().map_err(|e| e.to_string())?);
        let body = json!({
            "operationName": "SendEvents",
            "query": "mutation SendEvents($input: SendSpadeEventsInput!) { sendSpadeEvents(input: $input) { statusCode } }",
            "variables": { "input": { "data": data, "repository": "twilight", "encoding": "GZIP_B64" } }
        });
        let resp = Self::send_once_retrying(|| {
            self.client
                .post(GQL_URL)
                .header("Client-Id", crate::twitch_device_auth::device_client_id())
                .header("Authorization", format!("OAuth {token}"))
                .json(&body)
                .timeout(Duration::from_secs(15))
        })
        .await
        .map_err(|e| e.to_string())?;
        let status = resp.status();
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(msg) = json["errors"][0]["message"].as_str() {
            return Err(format!("HTTP {status}: {msg}"));
        }
        json["data"]["sendSpadeEvents"]["statusCode"]
            .as_i64()
            .ok_or_else(|| format!("HTTP {status}: no statusCode in reply"))
    }

    pub fn status(&self) -> String {
        self.last_status.lock().map(|g| g.clone()).unwrap_or_default()
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

// what the last heartbeat minute did, e.g. "21:04:12 somechannel: sendSpadeEvents 204". for checking that
// watching is being credited (devtools: __TAURI_INTERNALS__.invoke("heartbeat_status"))
#[tauri::command]
pub fn heartbeat_status(state: State<'_, Arc<WatchHeartbeatService>>) -> String {
    state.status()
}
