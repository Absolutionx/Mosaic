// 7TV cosmetics — Stage 1: animated username paints. Connects to the 7TV EventAPI websocket, subscribes
// to the watched channel's entitlement events, and POSTs a passive presence so 7TV back-fills the
// cosmetics of users already present. Each paint/badge entitlement is emitted to the frontend as
// "seventv-cosmetic" {twitch_id, kind, ref_id, action}. Paint DEFINITIONS (gradients/shadows) are fetched
// separately via get_all_seventv_paints. Ported/simplified from StreamNook's seventv_eventapi.

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

const EVENTAPI_URL: &str = "wss://events.7tv.io/v3";

pub struct SevenTvCosmetics {
    app: AppHandle,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl SevenTvCosmetics {
    pub fn new(app: AppHandle) -> Self {
        Self { app, task: Mutex::new(None) }
    }

    pub async fn set_channel(&self, channel_twitch_id: String) {
        self.stop().await;
        if channel_twitch_id.is_empty() {
            return;
        }
        let app = self.app.clone();
        let handle = tauri::async_runtime::spawn(async move {
            Self::run(app, channel_twitch_id).await;
        });
        *self.task.lock().await = Some(handle);
    }

    pub async fn stop(&self) {
        if let Some(h) = self.task.lock().await.take() {
            h.abort();
        }
    }

    // the presence POST subject is the channel's 7TV user id, not its Twitch id
    async fn resolve_7tv_user_id(http: &reqwest::Client, twitch_id: &str) -> Option<String> {
        let url = format!("https://7tv.io/v3/users/twitch/{twitch_id}");
        let resp = http.get(&url).send().await.ok()?;
        let j: serde_json::Value = resp.json().await.ok()?;
        j.pointer("/user/id")
            .and_then(|v| v.as_str())
            .or_else(|| j.get("id").and_then(|v| v.as_str()))
            .map(String::from)
    }

    async fn run(app: AppHandle, channel_twitch_id: String) {
        let http = reqwest::Client::new();
        let seventv_user_id = Self::resolve_7tv_user_id(&http, &channel_twitch_id).await;
        loop {
            if let Err(e) =
                Self::connect_once(&app, &http, &channel_twitch_id, seventv_user_id.as_deref()).await
            {
                eprintln!("[7tv-cosmetics] connection ended: {e}");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn connect_once(
        app: &AppHandle,
        http: &reqwest::Client,
        channel_twitch_id: &str,
        seventv_user_id: Option<&str>,
    ) -> Result<(), String> {
        let (ws, _) = tokio_tungstenite::connect_async(EVENTAPI_URL)
            .await
            .map_err(|e| e.to_string())?;
        let (mut write, mut read) = ws.split();

        loop {
            match read.next().await {
                Some(Ok(Message::Text(text))) => {
                    let v: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    match v.get("op").and_then(|o| o.as_u64()).unwrap_or(999) {
                        1 => {
                            // HELLO — grab the session id, subscribe, then bootstrap presence
                            let session_id = v
                                .pointer("/d/session_id")
                                .and_then(|s| s.as_str())
                                .map(String::from);
                            for t in ["entitlement.create", "entitlement.update", "entitlement.delete"] {
                                let sub = json!({
                                    "op": 35,
                                    "d": { "type": t, "condition": {
                                        "ctx": "channel", "platform": "TWITCH", "id": channel_twitch_id
                                    } }
                                });
                                write
                                    .send(Message::Text(sub.to_string()))
                                    .await
                                    .map_err(|e| e.to_string())?;
                            }
                            if let (Some(uid), Some(sid)) = (seventv_user_id, session_id.as_deref()) {
                                let http2 = http.clone();
                                let (uid, sid, cid) =
                                    (uid.to_string(), sid.to_string(), channel_twitch_id.to_string());
                                tokio::spawn(async move {
                                    let url = format!("https://7tv.io/v3/users/{uid}/presences");
                                    let body = json!({
                                        "kind": 1, "passive": true, "session_id": sid,
                                        "data": { "platform": "TWITCH", "id": cid }
                                    });
                                    let _ = http2.post(&url).json(&body).send().await;
                                });
                            }
                        }
                        0 => {
                            // DISPATCH
                            if let Some(d) = v.get("d") {
                                let dtype = d.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                if dtype.starts_with("entitlement.") {
                                    Self::handle_entitlement(app, d, dtype);
                                }
                            }
                        }
                        4 => return Ok(()), // RECONNECT
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Err(e)) => return Err(e.to_string()),
                _ => {}
            }
        }
    }

    fn handle_entitlement(app: &AppHandle, d: &serde_json::Value, dtype: &str) {
        let Some(body) = d.get("body") else { return };
        let kind = body.pointer("/object/kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "PAINT" && kind != "BADGE" {
            return; // stage 1 handles paints (badges ride the same stream for a later stage)
        }
        let twitch_id = body
            .pointer("/object/user/connections")
            .and_then(|c| c.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|c| c.get("platform").and_then(|p| p.as_str()) == Some("TWITCH"))
            })
            .and_then(|c| c.get("id"))
            .and_then(|i| i.as_str());
        let ref_id = body.pointer("/object/ref_id").and_then(|v| v.as_str());
        let action = dtype.strip_prefix("entitlement.").unwrap_or("update");
        if let Some(tid) = twitch_id {
            let _ = app.emit("seventv-cosmetic", json!({
                "twitch_id": tid, "kind": kind, "ref_id": ref_id, "action": action
            }));
        }
    }
}

#[tauri::command]
pub async fn seventv_cosmetics_set_channel(
    channel_id: String,
    state: State<'_, Arc<SevenTvCosmetics>>,
) -> Result<(), String> {
    state.set_channel(channel_id).await;
    Ok(())
}

#[tauri::command]
pub async fn seventv_cosmetics_clear(
    state: State<'_, Arc<SevenTvCosmetics>>,
) -> Result<(), String> {
    state.stop().await;
    Ok(())
}

// All 7TV badge definitions (id + image urls), matched against per-user badge ids from "seventv-cosmetic".
#[tauri::command]
pub async fn get_all_seventv_badges() -> Result<serde_json::Value, String> {
    const Q: &str = "query AllBadges { badges { badges { id name images { url scale width height } } } }";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://7tv.io/v4/gql")
        .json(&json!({ "query": Q }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(errs) = j.get("errors").and_then(|v| v.as_array()) {
        if !errs.is_empty() {
            let msg = errs[0].pointer("/message").and_then(|v| v.as_str()).unwrap_or("GraphQL error");
            return Err(format!("AllBadges: {msg}"));
        }
    }
    Ok(j.pointer("/data/badges/badges").cloned().unwrap_or(json!([])))
}

// All 7TV paint definitions (gradients/colors/shadows), fetched once and cached by the frontend, then
// matched against the per-user paint ids that arrive over "seventv-cosmetic".
#[tauri::command]
pub async fn get_all_seventv_paints() -> Result<serde_json::Value, String> {
    const Q: &str = "query AllPaints { paints { paints { id data { layers { opacity ty { __typename ... on PaintLayerTypeLinearGradient { angle repeating stops { at color { r g b a } } } ... on PaintLayerTypeRadialGradient { repeating stops { at color { r g b a } } } ... on PaintLayerTypeSingleColor { color { r g b a } } } } shadows { color { r g b a } offsetX offsetY blur } } } } }";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://7tv.io/v4/gql")
        .json(&json!({ "query": Q }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(errs) = j.get("errors").and_then(|v| v.as_array()) {
        if !errs.is_empty() {
            let msg = errs[0].pointer("/message").and_then(|v| v.as_str()).unwrap_or("GraphQL error");
            return Err(format!("AllPaints: {msg}"));
        }
    }
    Ok(j.pointer("/data/paints/paints").cloned().unwrap_or(json!([])))
}
