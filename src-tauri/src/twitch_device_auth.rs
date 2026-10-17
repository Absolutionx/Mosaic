// Twitch device-code login against the Android app client id, used ONLY to mint a token that
// integrity-free GQL ops (currently just GetPinnedChat, for pinned messages) will accept. the regular
// web-login token is minted for a different client id and Twitch rejects it with these ops (HTTP 401),
// so pins need their own token. mirrors the StreamNook project's approach: no scopes, device-code grant,
// file-persisted token with refresh. this is a SEPARATE one-time authorization from the main Twitch
// login (same account); the token is stored in app_local_data_dir and refreshed on demand.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

// the client a device token belongs to; GQL wants the matching Client-Id with it. tokens used to be minted for
// the Android app's id, but on 10-16-26 Twitch answered its device-code login with "invalid client" (new
// sign-ins failed; existing tokens kept working), while the TV app's id still offers device-code login. new
// sign-ins use the TV id; a saved Android token keeps working (with its own id) until Twitch rejects it
pub const ANDROID_CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
pub const TV_CLIENT_ID: &str = "ue6666qo983tsx6so1t0vnawi233wa";
const NEW_LOGIN_CLIENT_ID: &str = TV_CLIENT_ID;

// the client id of the token currently in use, for the Client-Id header of every request made with it
static ACTIVE_IS_TV: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

pub fn device_client_id() -> &'static str {
    if ACTIVE_IS_TV.load(std::sync::atomic::Ordering::Relaxed) { TV_CLIENT_ID } else { ANDROID_CLIENT_ID }
}

fn client_of(t: &StoredToken) -> &'static str {
    // tokens saved before client_id was recorded were all Android ones
    if t.client_id == TV_CLIENT_ID { TV_CLIENT_ID } else { ANDROID_CLIENT_ID }
}

fn set_active(t: &StoredToken) {
    ACTIVE_IS_TV.store(client_of(t) == TV_CLIENT_ID, std::sync::atomic::Ordering::Relaxed);
}
const TOKEN_FILE: &str = "twitch_device_token.json";
const DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";

#[derive(Serialize, Deserialize, Default, Clone)]
struct StoredToken {
    access_token: String,
    refresh_token: String,
    expires_at: i64, // unix seconds; 0 = unknown
    // the client id it was minted for (empty: an older Android token)
    #[serde(default)]
    client_id: String,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// stored via secret_store: Windows Credential Manager on Windows, a file elsewhere
fn load(app: &AppHandle) -> Option<StoredToken> {
    let raw = crate::secret_store::load(app, TOKEN_FILE)?;
    let t: StoredToken = serde_json::from_str(&raw).ok()?;
    if t.access_token.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn save(app: &AppHandle, token: &StoredToken) -> Result<(), String> {
    let raw = serde_json::to_string(token).map_err(|e| e.to_string())?;
    crate::secret_store::save(app, TOKEN_FILE, &raw)
}

fn delete(app: &AppHandle) {
    crate::secret_store::delete(app, TOKEN_FILE);
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
    let client = crate::http::client();
    let params = [("client_id", NEW_LOGIN_CLIENT_ID), ("scopes", "")];
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
    let client = crate::http::client();
    let deadline = now_secs() + expires_in as i64;
    let mut wait = interval.max(1);
    loop {
        if now_secs() >= deadline {
            return Err("Authorization timed out. Please try again.".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;

        let params = [
            ("client_id", NEW_LOGIN_CLIENT_ID),
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
                client_id: NEW_LOGIN_CLIENT_ID.to_string(),
            };
            save(&app, &stored)?;
            set_active(&stored);
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

async fn refresh(app: &AppHandle, old: &StoredToken) -> Option<StoredToken> {
    if old.refresh_token.is_empty() {
        return None;
    }
    let client_id = client_of(old);
    let client = crate::http::client();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", old.refresh_token.as_str()),
        ("client_id", client_id),
    ];
    let resp = client.post(TOKEN_URL).form(&params).send().await.ok()?;
    if !resp.status().is_success() {
        // Twitch refused the refresh itself (revoked, or a client id it no longer accepts): forget the token so
        // the app shows "Enable" again, instead of looking connected while every request quietly fails. a
        // network error (above) keeps it for the next try
        if resp.status() == reqwest::StatusCode::BAD_REQUEST || resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            delete(app);
        }
        return None;
    }
    let t: TokenResponse = resp.json().await.ok()?;
    let stored = StoredToken {
        access_token: t.access_token,
        // Twitch rotates the refresh token; fall back to the old one if none returned
        refresh_token: t.refresh_token.unwrap_or_else(|| old.refresh_token.clone()),
        expires_at: if let Some(secs) = t.expires_in {
            now_secs() + secs
        } else {
            0
        },
        client_id: client_id.to_string(),
    };
    let _ = save(app, &stored);
    Some(stored)
}

// internal: a valid device token, refreshing if it's within a minute of expiry. None if not connected
// sets the Client-Id that goes with it (device_client_id)
pub async fn get_device_token(app: &AppHandle) -> Option<String> {
    let t = load(app)?;
    set_active(&t);
    if t.expires_at > 0 && now_secs() >= t.expires_at - 60 {
        return refresh(app, &t).await.map(|nt| nt.access_token);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_tokens_are_android_new_ones_tv() {
        let old: StoredToken = serde_json::from_str(r#"{"access_token":"a","refresh_token":"r","expires_at":0}"#).unwrap();
        assert_eq!(client_of(&old), ANDROID_CLIENT_ID);
        set_active(&old);
        assert_eq!(device_client_id(), ANDROID_CLIENT_ID);
        let new = StoredToken { client_id: TV_CLIENT_ID.into(), ..old.clone() };
        set_active(&new);
        assert_eq!(device_client_id(), TV_CLIENT_ID);
        let round: StoredToken = serde_json::from_str(&serde_json::to_string(&new).unwrap()).unwrap();
        assert_eq!(client_of(&round), TV_CLIENT_ID);
    }
}
