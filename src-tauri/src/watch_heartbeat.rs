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
// Drops need more since Twitch's change of about 2026-10-07: minutes count toward a drop only while the viewer's
// player is fetching the stream's video segments, and only with a playlist that carries the viewer's identity.
// Mosaic's own playback runs through streamlink without the account, so a second loop (playlist_tick, every
// 20 s) does what the official player does: a playback token signed for the account, the lowest-quality media
// playlist, and a HEAD request (no video downloaded) for each new segment. Same approach as TwitchDropsMiner
// (f693b0c, 2026-10-09). It follows the same rules as the minute: one channel, the one on screen, only while
// it plays and is live.
//
// Clips and VODs (1.8.1): Twitch's own players report replays too, and a broken watch streak ("watch a clip,
// VOD or stream in the next 24h to save it") is saved from those reports. Mosaic's clip and VOD players used to
// send nothing, so watching there never saved a streak. heartbeat_replay sends what the web player sends
// (checked 10-19-26): a clip sends incrementClipViewCount + video-play when it starts, then
// clips_minute_watched (first ~9 s in, then each minute); a VOD sends video-play, then minute-watched with
// content_mode "vod" (first ~15 s in, then each minute). replay-watch.js times them, only while the clip or VOD
// is actually playing, one at a time.
//
// The reports alone (answered 204) didn't save a streak (10-21-26). Mosaic plays clips and VODs anonymously,
// while Twitch's player fetches them with a playback token signed for the viewer, so Twitch never saw the
// account watch them. The same thing stopped drops counting (see above). So when a clip or VOD starts, it's
// also fetched the way the player does it, with the account: a VOD's playlist from usher, or the first bytes
// of a clip's video. And the reports now carry the session ids the web player sends with each one.
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
const DROPS_INTERVAL: Duration = Duration::from_secs(20);
// a signed playlist is replaced after this long even while it still answers: its segment links are signed
// too, and a stale one can keep listing segments that no longer count (or none at all)
const DROPS_PLAYLIST_MAX_AGE: Duration = Duration::from_secs(600);
// rounds without new segments before the playlist is replaced (1 min), and before drops count as stalled
// for the "Drops aren't counting" bar (2 min)
const DROPS_REFRESH_AFTER_FAILS: u32 = 3;
const DROPS_STALLED_AFTER_FAILS: u32 = 6;
// heartbeat.log in the app's data folder: the last few hundred status lines, so a "drops stopped counting"
// can be looked into afterwards (release builds have no console)
const LOG_FILE: &str = "heartbeat.log";
const LOG_CAP_BYTES: u64 = 256 * 1024;
// segments remembered as already requested (a live media playlist lists ~15 at a time)
const DROPS_SEEN_CAP: usize = 256;

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
    // drops: (login, media playlist URL, when it was signed) for the account, and the segments already
    // requested from it
    drops_playlist: tokio::sync::Mutex<Option<(String, String, Instant)>>,
    // drops rounds in a row that requested no new segment (an error, or a playlist with nothing new): the
    // signed playlist is replaced after DROPS_REFRESH_AFTER_FAILS, and drops count as stalled after
    // DROPS_STALLED_AFTER_FAILS. Before this, a playlist that kept answering while its segments failed (or
    // stopped listing new ones) was kept forever: drops stopped counting until chat reconnected (e.g. logging
    // out and in), and nothing noticed because the minute reports still went through
    drops_fail_rounds: std::sync::atomic::AtomicU32,
    drops_seen: std::sync::Mutex<std::collections::VecDeque<String>>,
    drops_status: std::sync::Mutex<String>,
    // whether watching can count at all, for the "drops aren't counting" bar (drops-banner.js):
    // "unknown" until the first minute, "ok", "no_login" (no Twitch connection token) or "rejected"
    // (Twitch refused the token, so the connection has to be renewed). health() also reports "stalled" when
    // the minutes go through but the drops loop hasn't managed to request a segment for a while
    health: std::sync::Mutex<&'static str>,
    // clips and VODs: who the last one belongs to ("clip:<slug>" / "vod:<id>" -> details), so each minute
    // doesn't look it up again, and what the last replay report did (heartbeat_status)
    replay_info: tokio::sync::Mutex<Option<(String, ReplayInfo)>>,
    replay_status: std::sync::Mutex<String>,
    // the web player's device id (the same one for every report in a run)
    device_id: String,
}

// what a clip or VOD report names: its channel and category, and the video id Twitch's player puts in vod_id
#[derive(Clone)]
struct ReplayInfo {
    channel_id: String,
    login: String,
    game_id: String,
    game_name: String,
    vod_id: String,
    // one playback session per clip or VOD opened, like the web player's play_session_id
    play_session_id: String,
}

// 32 hex characters, the shape of the web player's device and session ids
fn random_hex_id() -> String {
    let mut rnd = [0u8; 16];
    let _ = getrandom::getrandom(&mut rnd);
    rnd.iter().map(|b| format!("{b:02x}")).collect()
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
            drops_playlist: tokio::sync::Mutex::new(None),
            drops_fail_rounds: std::sync::atomic::AtomicU32::new(0),
            drops_seen: std::sync::Mutex::new(std::collections::VecDeque::new()),
            drops_status: std::sync::Mutex::new("no playlist check yet".into()),
            health: std::sync::Mutex::new("unknown"),
            replay_info: tokio::sync::Mutex::new(None),
            replay_status: std::sync::Mutex::new("no clip or VOD reported yet".into()),
            device_id: random_hex_id(),
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
        // drops: the segment loop, every 20 s (see the header)
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(DROPS_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                service.playlist_tick().await;
            }
        });
    }

    pub async fn set_target(&self, channel_id: String, login: String) {
        let mut target = self.target.write().await;
        let previous = target.as_ref().map(|t| t.channel_id.clone());
        if previous.as_deref() != Some(channel_id.as_str()) {
            self.log(&format!("watching {login}"));
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
        self.drops_playlist.lock().await.take();
        self.drops_fail_rounds.store(0, Ordering::SeqCst);
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
            self.set_health("no_login");
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
        match &gql {
            Ok(code) if (200..300).contains(code) => self.set_health("ok"),
            Err(e) if is_auth_error(e) => self.set_health("rejected"),
            _ => {}
        }
        match &gql {
            Ok(code) if (200..300).contains(code) => {}
            Ok(code) => self.log(&format!("{}: minute answered {code}", target.login)),
            Err(e) => self.log(&format!("{}: minute failed: {e}", target.login)),
        }
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

    // DROPS: one round of what the official player does (see the header). Skipped unless a live Twitch channel
    // is on screen and playing, with the device login connected
    async fn playlist_tick(&self) {
        if !self.playing.load(Ordering::SeqCst) {
            return;
        }
        let Some(target) = self.target.read().await.clone() else {
            return;
        };
        // the minute loop decides "live" (broadcast id); before its first check, or while offline, do nothing
        if target.broadcast_id.is_none() {
            self.drops_playlist.lock().await.take();
            return;
        }
        let Some(token) = crate::twitch_device_auth::get_device_token(&self.app).await else {
            return;
        };
        // the login goes into usher's URL: only a plain Twitch login gets through
        let login = target.login.to_ascii_lowercase();
        if !crate::stream_relay::valid_twitch_login(&login) {
            return;
        }
        let result = self.request_new_segments(&login, &token).await;
        if let Err(e) = &result {
            if is_auth_error(e) {
                self.set_health("rejected");
            }
        }
        let fails = match &result {
            Ok(n) if *n > 0 => {
                self.drops_fail_rounds.store(0, Ordering::SeqCst);
                0
            }
            _ => self.drops_fail_rounds.fetch_add(1, Ordering::SeqCst) + 1,
        };
        // nothing new for a while: the signed playlist (or its segment links) went stale, start over with a
        // fresh one next round, the same thing reconnecting chat used to do
        if fails > 0 && fails % DROPS_REFRESH_AFTER_FAILS == 0 {
            self.drops_playlist.lock().await.take();
            self.log(&format!("{}: {fails} drops rounds without a new segment, replacing the playlist", target.login));
        }
        let now = chrono::Local::now().format("%H:%M:%S");
        let line = match &result {
            Ok(n) => format!("{now} {}: playlist ok, {n} new segment(s) requested", target.login),
            Err(e) => format!("{now} {}: playlist failed: {e}", target.login),
        };
        if let Err(e) = &result {
            eprintln!("[heartbeat] drops playlist for {}: {e}", target.login);
        }
        // only changes and failures go in the log, not every healthy round
        if !matches!(&result, Ok(n) if *n > 0) || fails == 0 && self.drops_status().contains("failed") {
            self.log(&line[9..]);
        }
        if let Ok(mut g) = self.drops_status.lock() {
            *g = line;
        }
    }

    // GETs the account-signed media playlist (fetching a new one when there is none for this channel, or the
    // old one stopped answering) and HEADs every segment not requested before. returns how many were new
    async fn request_new_segments(&self, login: &str, token: &str) -> Result<usize, String> {
        let mut cached = self.drops_playlist.lock().await;
        let mut fresh = false;
        let url = match cached.as_ref() {
            Some((l, u, at)) if l == login && at.elapsed() < DROPS_PLAYLIST_MAX_AGE => u.clone(),
            _ => {
                let u = self.media_playlist_url(login, token).await?;
                *cached = Some((login.to_string(), u.clone(), Instant::now()));
                fresh = true;
                u
            }
        };
        let mut body = self.get_playlist(&url).await;
        if body.is_err() && !fresh {
            // signed playlists expire: one retry with a new one
            let u = self.media_playlist_url(login, token).await?;
            *cached = Some((login.to_string(), u.clone(), Instant::now()));
            body = self.get_playlist(&u).await;
        }
        drop(cached);
        let body = body?;
        let segments: Vec<String> =
            body.lines().map(str::trim).filter(|l| l.starts_with("https://")).map(str::to_owned).collect();
        if segments.is_empty() {
            return Err("playlist had no segments".into());
        }
        let new: Vec<String> = {
            let seen = self.drops_seen.lock().map_err(|e| e.to_string())?;
            segments.into_iter().filter(|s| !seen.contains(s)).collect()
        };
        let mut done = 0usize;
        for seg in &new {
            let resp = self
                .client
                .head(seg)
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("segment HEAD answered {}", resp.status()));
            }
            if let Ok(mut seen) = self.drops_seen.lock() {
                seen.push_back(seg.clone());
                while seen.len() > DROPS_SEEN_CAP {
                    seen.pop_front();
                }
            }
            done += 1;
        }
        Ok(done)
    }

    async fn get_playlist(&self, url: &str) -> Result<String, String> {
        let resp = self
            .client
            .get(url)
            .header("Connection", "close")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("playlist answered {}", resp.status()));
        }
        resp.text().await.map_err(|e| e.to_string())
    }

    // a playback token signed for the account (GQL with the device token), then usher's master playlist, and
    // the last (lowest-quality) variant listed in it
    async fn media_playlist_url(&self, login: &str, token: &str) -> Result<String, String> {
        let body = json!({
            "operationName": "PlaybackAccessToken",
            "query": crate::stream_relay::PREVIEW_TOKEN_QUERY,
            "variables": { "login": login, "playerType": "site" }
        });
        let resp = self
            .client
            .post(GQL_URL)
            .header("Client-Id", crate::twitch_device_auth::device_client_id())
            .header("Authorization", format!("OAuth {token}"))
            .json(&body)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let tok = &json["data"]["streamPlaybackAccessToken"];
        let (Some(value), Some(sig)) = (tok["value"].as_str(), tok["signature"].as_str()) else {
            let msg = json["errors"][0]["message"].as_str().unwrap_or("no playback token");
            return Err(format!("playback token: {msg}"));
        };
        let usher = format!(
            "https://usher.ttvnw.net/api/channel/hls/{login}.m3u8?sig={}&token={}&allow_source=true\
&allow_audio_only=false&fast_bread=true&p={}&player_backend=mediaplayer&playlist_include_framerate=true",
            crate::stream_relay::pct_encode(sig),
            crate::stream_relay::pct_encode(value),
            rand::random::<u32>() % 10_000_000,
        );
        let master = self.get_playlist(&usher).await.map_err(|e| format!("master {e}"))?;
        master
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("https://"))
            .last()
            .map(str::to_owned)
            .ok_or_else(|| "master playlist listed no variants".to_string())
    }

    fn set_health(&self, h: &'static str) {
        let changed = self.health.lock().map(|mut g| {
            let changed = *g != h;
            *g = h;
            changed
        });
        if changed.unwrap_or(false) {
            self.log(&format!("health: {h}"));
        }
    }

    // the automatic "log out and back in": a fresh Twitch connection token, everything remembered about the
    // stream and the account forgotten, then one minute reported right away to see whether watching counts
    // now. returns the health afterwards ("ok" when it worked)
    pub async fn repair(&self, playing: bool) -> &'static str {
        self.playing.store(playing, Ordering::SeqCst);
        if crate::twitch_device_auth::get_device_token(&self.app).await.is_none()
            && !crate::twitch_device_auth::twitch_device_connected(self.app.clone())
        {
            self.set_health("no_login");
            return "no_login";
        }
        let refreshed = crate::twitch_device_auth::force_refresh(&self.app).await;
        eprintln!("[heartbeat] repair: token refresh {}", if refreshed { "ok" } else { "failed" });
        *self.cached_user_id.write().await = None;
        self.drops_playlist.lock().await.take();
        if let Ok(mut seen) = self.drops_seen.lock() {
            seen.clear();
        }
        if let Some(t) = self.target.write().await.as_mut() {
            t.broadcast_checked_at = None;
        }
        self.drops_fail_rounds.store(0, Ordering::SeqCst);
        self.set_health("unknown");
        self.tick().await;
        self.playlist_tick().await;
        let h = self.health();
        self.log(&format!("repair: token refresh {}, health now {h}", if refreshed { "ok" } else { "refused" }));
        h
    }

    pub fn health(&self) -> &'static str {
        let h = self.health.lock().map(|g| *g).unwrap_or("unknown");
        if h == "ok" && self.drops_fail_rounds.load(Ordering::SeqCst) >= DROPS_STALLED_AFTER_FAILS {
            return "stalled";
        }
        h
    }

    // one line in heartbeat.log (see LOG_FILE), with the date and time; the file is cut in half past the cap
    fn log(&self, line: &str) {
        use std::io::Write;
        use tauri::Manager;
        let Ok(dir) = self.app.path().app_local_data_dir() else { return };
        let path = dir.join(LOG_FILE);
        if std::fs::metadata(&path).map(|m| m.len() > LOG_CAP_BYTES).unwrap_or(false) {
            if let Ok(old) = std::fs::read(&path) {
                let keep = &old[old.len() / 2..];
                let start = keep.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
                let _ = std::fs::write(&path, &keep[start..]);
            }
        }
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{} {line}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
        }
    }

    pub fn drops_status(&self) -> String {
        self.drops_status.lock().map(|g| g.clone()).unwrap_or_default()
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
        self.send_spade_events(&payload, token).await
    }

    // any list of spade events through GQL sendSpadeEvents (gzip + base64 JSON array, "twilight" repository),
    // with the viewer's token. Returns the statusCode Twitch's spade answered with (204 = accepted)
    async fn send_spade_events(&self, payload: &serde_json::Value, token: &str) -> Result<i64, String> {
        let raw = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
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

    // a clip's or VOD's channel and category, from Twitch (cached for the one being watched)
    async fn replay_info(&self, kind: &str, id: &str, token: &str) -> Result<ReplayInfo, String> {
        let key = format!("{kind}:{id}");
        if let Some((k, info)) = self.replay_info.lock().await.as_ref() {
            if *k == key {
                return Ok(info.clone());
            }
        }
        let (query, vars, root) = if kind == "clip" {
            (
                "query MosaicReplayClip($slug: ID!) { clip(slug: $slug) { id broadcaster { id login } game { id name } } }",
                json!({ "slug": id }),
                "clip",
            )
        } else {
            (
                "query MosaicReplayVod($id: ID!) { video(id: $id) { id owner { id login } game { id name } } }",
                json!({ "id": id }),
                "video",
            )
        };
        let resp = self
            .client
            .post(GQL_URL)
            .header("Client-Id", crate::twitch_device_auth::device_client_id())
            .header("Authorization", format!("OAuth {token}"))
            .json(&json!({ "query": query, "variables": vars }))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(msg) = body["errors"][0]["message"].as_str() {
            return Err(format!("HTTP {status}: {msg}"));
        }
        let node = &body["data"][root];
        let owner = if kind == "clip" { &node["broadcaster"] } else { &node["owner"] };
        let (Some(vod_id), Some(channel_id), Some(login)) = (node["id"].as_str(), owner["id"].as_str(), owner["login"].as_str()) else {
            return Err(format!("HTTP {status}: no such {kind}"));
        };
        let info = ReplayInfo {
            channel_id: channel_id.to_string(),
            login: login.to_string(),
            game_id: node["game"]["id"].as_str().unwrap_or_default().to_string(),
            game_name: node["game"]["name"].as_str().unwrap_or_default().to_string(),
            vod_id: vod_id.to_string(),
            play_session_id: random_hex_id(),
        };
        *self.replay_info.lock().await = Some((key, info.clone()));
        Ok(info)
    }

    // one clip/VOD report (see the header). kind: "clip" | "vod"; event: "start" | "minute"; minutes: how many
    // minutes this one has reported so far, this one included; position: where in the clip/VOD it is (seconds)
    pub async fn report_replay(&self, kind: &str, id: &str, event: &str, minutes: u32, position: f64, muted: bool) -> Result<String, String> {
        let Some(token) = crate::twitch_device_auth::get_device_token(&self.app).await else {
            return Ok("not connected".into());
        };
        let user_id = self.user_id(&token).await?;
        let info = self.replay_info(kind, id, &token).await?;
        let clip = kind == "clip";
        let name = match (clip, event) {
            (_, "start") => "video-play",
            (true, _) => "clips_minute_watched",
            (false, _) => "minute-watched",
        };
        let mut props = json!({
            "channel_id": info.channel_id,
            "channel": info.login,
            "client_time": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            "content_mode": if clip { "clip" } else { "vod" },
            "vod_type": if clip { "clip" } else { "archive" },
            "vod_id": info.vod_id,
            "vod_timestamp": if position.is_finite() { position.max(0.0) } else { 0.0 },
            "game": info.game_name,
            "game_id": info.game_id,
            "category_id": info.game_id,
            "hidden": false,
            "is_live": false,
            "live": false,
            "location": "vod",
            "logged_in": true,
            "minutes_logged": if event == "start" { 0 } else { minutes },
            "muted": muted,
            "player": "site",
            "stream_type": "vod",
            "user_id": user_id,
            "platform": "web",
            "client_app": "twilight",
            "device_id": self.device_id,
            "distinct_id": self.device_id,
            "session_device_id": self.device_id,
            "play_session_id": info.play_session_id,
            "player_state": "Playing",
            "playback_rate": 1,
            "is_dvr": false
        });
        if clip {
            props["clip_slug"] = json!(id);
        } else {
            props["vod"] = json!(info.vod_id);
        }
        // the web player counts the clip as viewed when it starts
        if clip && event == "start" {
            let bump = self
                .client
                .post(GQL_URL)
                .header("Client-Id", crate::twitch_device_auth::device_client_id())
                .header("Authorization", format!("OAuth {token}"))
                .json(&json!({
                    "operationName": "incrementClipViewCount",
                    "variables": { "input": { "slug": id } },
                    "extensions": { "persistedQuery": { "version": 1, "sha256Hash": "6b2f169f994f2b93ff68774f6928de66a1e8cdb70a42f4af3a5a1ecc68ee759b" } }
                }))
                .timeout(Duration::from_secs(15))
                .send()
                .await;
            if let Err(e) = bump {
                self.log(&format!("clip {id}: view count failed: {e}"));
            }
        }
        // starting: fetch it with the account, as Twitch's player does (see the header)
        let fetched = if event == "start" {
            Some(match self.replay_playback(kind, id, &token).await {
                Ok(s) => s,
                Err(e) => format!("account fetch failed: {e}"),
            })
        } else {
            None
        };
        let payload = json!([{ "event": name, "properties": props }]);
        let result = self.send_spade_events(&payload, &token).await;
        let extra = fetched.map(|f| format!(", {f}")).unwrap_or_default();
        let line = match &result {
            Ok(code) => format!("{} {kind} {} ({}): {name} {code}{extra}", chrono::Local::now().format("%H:%M:%S"), id, info.login),
            Err(e) => format!("{} {kind} {} ({}): {name} failed: {e}{extra}", chrono::Local::now().format("%H:%M:%S"), id, info.login),
        };
        self.log(&line);
        eprintln!("[heartbeat] {line}");
        if let Ok(mut g) = self.replay_status.lock() {
            *g = line.clone();
        }
        result.map(|code| code.to_string())
    }

    // what Twitch's player fetches with the account when a clip or VOD starts: a playback token signed for the
    // viewer, then the VOD's master playlist from usher, or the start of the clip's video (smallest quality).
    // Nothing is played from it; it only lets Twitch see the account watching
    async fn replay_playback(&self, kind: &str, id: &str, token: &str) -> Result<String, String> {
        if kind == "clip" {
            let json = self
                .gql_as_viewer(
                    json!({
                        "query": "query MosaicClipPlayback($slug: ID!) { clip(slug: $slug) { \
                            playbackAccessToken(params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: \"site\"}) \
                            { signature value } videoQualities { quality sourceURL } } }",
                        "variables": { "slug": id }
                    }),
                    token,
                )
                .await?;
            let clip = &json["data"]["clip"];
            let tok = &clip["playbackAccessToken"];
            let (Some(sig), Some(value)) = (tok["signature"].as_str(), tok["value"].as_str()) else {
                return Err(json["errors"][0]["message"].as_str().unwrap_or("no clip playback token").to_string());
            };
            // listed best first; the last is the smallest
            let src = clip["videoQualities"]
                .as_array()
                .and_then(|q| q.iter().filter_map(|x| x["sourceURL"].as_str()).filter(|u| u.starts_with("https://")).last())
                .ok_or_else(|| "no clip video".to_string())?;
            let sep = if src.contains('?') { '&' } else { '?' };
            let url = format!(
                "{src}{sep}sig={}&token={}",
                crate::stream_relay::pct_encode(sig),
                crate::stream_relay::pct_encode(value)
            );
            let resp = self
                .client
                .get(&url)
                .header("Range", "bytes=0-65535")
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("clip video {}", resp.status().as_u16()))
        } else {
            let json = self
                .gql_as_viewer(
                    json!({
                        "operationName": "PlaybackAccessToken",
                        "query": "query PlaybackAccessToken($id: ID!, $playerType: String!) { \
                            videoPlaybackAccessToken(id: $id, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) \
                            { value signature } }",
                        "variables": { "id": id, "playerType": "site" }
                    }),
                    token,
                )
                .await?;
            let tok = &json["data"]["videoPlaybackAccessToken"];
            let (Some(value), Some(sig)) = (tok["value"].as_str(), tok["signature"].as_str()) else {
                return Err(json["errors"][0]["message"].as_str().unwrap_or("no VOD playback token").to_string());
            };
            let usher = format!(
                "https://usher.ttvnw.net/vod/{id}.m3u8?sig={}&token={}&allow_source=true&allow_audio_only=false\
&p={}&player_backend=mediaplayer&playlist_include_framerate=true",
                crate::stream_relay::pct_encode(sig),
                crate::stream_relay::pct_encode(value),
                rand::random::<u32>() % 10_000_000,
            );
            let master = self.get_playlist(&usher).await?;
            // and the smallest rendition's playlist, as the player loads one right after
            if let Some(variant) = master.lines().map(str::trim).filter(|l| l.starts_with("https://")).last() {
                self.get_playlist(variant).await?;
            }
            Ok("VOD playlist ok".into())
        }
    }

    // one GQL request with the viewer's (device login) token
    async fn gql_as_viewer(&self, body: serde_json::Value, token: &str) -> Result<serde_json::Value, String> {
        let resp = self
            .client
            .post(GQL_URL)
            .header("Client-Id", crate::twitch_device_auth::device_client_id())
            .header("Authorization", format!("OAuth {token}"))
            .json(&body)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
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

// Twitch's answer when the connection's token is no good any more (revoked, expired, or issued under rules
// that changed): GQL says 401 or names the token. Network trouble and other failures don't count
fn is_auth_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("401") || e.contains("unauthorized") || e.contains("invalid oauth") || e.contains("oauth token")
}

// the stream being credited right now, for the Drops hub to put the campaign you're earning first:
// { login, game_id, game_name, playing, health }, or null when nothing is (health: see the field). game_* fill in after the first minute
#[tauri::command]
pub async fn heartbeat_watching(state: State<'_, Arc<WatchHeartbeatService>>) -> Result<serde_json::Value, String> {
    let playing = state.playing.load(Ordering::SeqCst);
    Ok(match state.target.read().await.as_ref() {
        Some(t) => json!({ "login": t.login, "game_id": t.game_id, "game_name": t.game_name, "playing": playing, "health": state.health() }),
        None => serde_json::Value::Null,
    })
}

// see WatchHeartbeatService::repair. playing: whether the player on screen is actually playing right now
#[tauri::command]
pub async fn heartbeat_repair(playing: bool, state: State<'_, Arc<WatchHeartbeatService>>) -> Result<String, String> {
    Ok(state.repair(playing).await.to_string())
}

// what the last heartbeat minute did, e.g. "21:04:12 somechannel: sendSpadeEvents 204". for checking that
// watching is being credited (devtools: __TAURI_INTERNALS__.invoke("heartbeat_status"))
#[tauri::command]
pub fn heartbeat_status(state: State<'_, Arc<WatchHeartbeatService>>) -> String {
    let replay = state.replay_status.lock().map(|g| g.clone()).unwrap_or_default();
    format!("points: {} | drops: {} | clips & VODs: {replay}", state.status(), state.drops_status())
}

// a Twitch clip or VOD playing in Mosaic: one report (see WatchHeartbeatService::report_replay; timed by
// replay-watch.js). Returns Twitch's answer ("204") or "not connected"
#[tauri::command]
pub async fn heartbeat_replay(
    kind: String,
    id: String,
    event: String,
    minutes: u32,
    position: f64,
    muted: bool,
    state: State<'_, Arc<WatchHeartbeatService>>,
) -> Result<String, String> {
    if !replay_args_ok(&kind, &id, &event) {
        return Err("invalid clip or VOD".into());
    }
    state.report_replay(&kind, &id, &event, minutes.min(100_000), position, muted).await
}

fn replay_args_ok(kind: &str, id: &str, event: &str) -> bool {
    let id_ok = match kind {
        "clip" => !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "vod" => !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit()),
        _ => false,
    };
    id_ok && (event == "start" || event == "minute")
}

#[cfg(test)]
mod replay_tests {
    use super::replay_args_ok;
    #[test]
    fn only_real_clips_and_vods() {
        assert!(replay_args_ok("clip", "TrappedAgitatedShieldWholeWheat-NxKTIA1OqLXrwI9D", "start"));
        assert!(replay_args_ok("vod", "2904279037", "minute"));
        assert!(!replay_args_ok("vod", "29042abc", "minute"));
        assert!(!replay_args_ok("clip", "a/b", "start"));
        assert!(!replay_args_ok("clip", "", "start"));
        assert!(!replay_args_ok("live", "123", "minute"));
        assert!(!replay_args_ok("vod", "123", "claim"));
    }
}

#[cfg(test)]
mod health_tests {
    use super::is_auth_error;

    #[test]
    fn only_token_trouble_means_reconnect() {
        assert!(is_auth_error("HTTP 401 Unauthorized: no statusCode in reply"));
        assert!(is_auth_error("HTTP 200 OK: Invalid OAuth token"));
        assert!(!is_auth_error("error sending request: connection reset"));
        assert!(!is_auth_error("HTTP 500 Internal Server Error: no statusCode in reply"));
        assert!(!is_auth_error("playlist answered 404 Not Found"));
    }
}
