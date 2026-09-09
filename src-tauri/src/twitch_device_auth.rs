// Twitch device-code login against the Android app client id, used ONLY to mint a token that
// integrity-free GQL ops (currently just GetPinnedChat, for pinned messages) will accept. the regular
// web-login token is minted for a different client id and Twitch rejects it with these ops (HTTP 401),
// so pins need their own token. mirrors the StreamNook project's approach: no scopes, device-code grant,
// file-persisted token with refresh. this is a SEPARATE one-time authorization from the main Twitch
// login (same account); the token is stored in app_local_data_dir and refreshed on demand.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const ANDROID_CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const TOKEN_FILE: &str = "twitch_device_token.json";
const DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";

#[derive(Serialize, Deserialize, Default, Clone)]
struct StoredToken {
    access_token: String,
    refresh_token: String,
    expires_at: i64, // unix seconds; 0 = unknown
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn token_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(TOKEN_FILE))
}

fn load(app: &AppHandle) -> Option<StoredToken> {
    let path = token_path(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    let t: StoredToken = serde_json::from_str(&raw).ok()?;
    if t.access_token.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn save(app: &AppHandle, token: &StoredToken) -> Result<(), String> {
    let path = token_path(app).ok_or_else(|| "no data dir".to_string())?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let raw = serde_json::to_string(token).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

fn delete(app: &AppHandle) {
    if let Some(path) = token_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// Twitch's device + token endpoint response shapes (only the fields we use)
#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

// what the frontend needs to show the activation prompt
#[derive(Serialize)]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
    pub expires_in: u64,
}

// step 1: start the device-code flow. NO scopes (matches StreamNook; the integrity-free read needs none)
#[tauri::command]
pub async fn twitch_device_start() -> Result<DeviceCodeInfo, String> {
    let client = reqwest::Client::new();
    let params = [("client_id", ANDROID_CLIENT_ID), ("scopes", "")];
    let resp = client
        .post(DEVICE_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "device start failed ({}): {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }
    let d: DeviceCodeResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(DeviceCodeInfo {
        user_code: d.user_code,
        verification_uri: d.verification_uri,
        device_code: d.device_code,
        interval: d.interval,
        expires_in: d.expires_in,
    })
}

// step 2: poll until the user authorizes at twitch.tv/activate (or the code expires). stores the token
// on success. long-running: the frontend awaits it while showing the code
#[tauri::command]
pub async fn twitch_device_poll(
    app: AppHandle,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<bool, String> {
    let client = reqwest::Client::new();
    let deadline = now_secs() + expires_in as i64;
    let mut wait = interval.max(1);
    loop {
        if now_secs() >= deadline {
            return Err("Authorization timed out. Please try again.".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;

        let params = [
            ("client_id", ANDROID_CLIENT_ID),
            ("scopes", ""),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ];
        let resp = client
            .post(TOKEN_URL)
            .form(&params)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().is_success() {
            let t: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
            let stored = StoredToken {
                access_token: t.access_token,
                refresh_token: t.refresh_token.unwrap_or_default(),
                expires_at: if let Some(secs) = t.expires_in {
                    now_secs() + secs
                } else {
                    0
                },
            };
            save(&app, &stored)?;
            return Ok(true);
        }

        let err = resp.text().await.unwrap_or_default();
        if err.contains("authorization_pending") {
            continue; // not authorized yet
        } else if err.contains("slow_down") {
            wait += 2; // back off as Twitch asks
            continue;
        } else if err.contains("expired_token") {
            return Err("Authorization code expired. Please try again.".into());
        } else {
            return Err(format!("Authorization failed: {err}"));
        }
    }
}

async fn refresh(app: &AppHandle, refresh_token: &str) -> Option<StoredToken> {
    if refresh_token.is_empty() {
        return None;
    }
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", ANDROID_CLIENT_ID),
    ];
    let resp = client.post(TOKEN_URL).form(&params).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let t: TokenResponse = resp.json().await.ok()?;
    let stored = StoredToken {
        access_token: t.access_token,
        // Twitch rotates the refresh token; fall back to the old one if none returned
        refresh_token: t.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_at: if let Some(secs) = t.expires_in {
            now_secs() + secs
        } else {
            0
        },
    };
    let _ = save(app, &stored);
    Some(stored)
}

// internal: a valid device token, refreshing if it's within a minute of expiry. None if not connected
pub async fn get_device_token(app: &AppHandle) -> Option<String> {
    let t = load(app)?;
    if t.expires_at > 0 && now_secs() >= t.expires_at - 60 {
        return refresh(app, &t.refresh_token).await.map(|nt| nt.access_token);
    }
    Some(t.access_token)
}

#[tauri::command]
pub fn twitch_device_connected(app: AppHandle) -> bool {
    load(&app).is_some()
}

#[tauri::command]
pub fn twitch_device_logout(app: AppHandle) {
    delete(&app);
}
