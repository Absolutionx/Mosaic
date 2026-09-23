// Twitch PubSub connection for the watched channel + the logged-in user. Ported/simplified from
// StreamNook's channel_points_websocket_service (they run many connections for the whole followed list;
// Mosaic watches one channel, so one connection is enough). Listens for real channel-point redemptions
// (community-points-channel-v1) and live balance changes (community-points-user-v1), and emits them to
// the frontend. Uses the device-login token. PubSub is deprecated by Twitch but still functioning;
// StreamNook relies on it. This is also the foundation for real-time predictions/polls later.

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

const PUBSUB_URL: &str = "wss://pubsub-edge.twitch.tv";

pub struct PubSubService {
    app: AppHandle,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl PubSubService {
    pub fn new(app: AppHandle) -> Self {
        Self { app, task: Mutex::new(None) }
    }

    pub async fn set_channel(&self, channel_login: String) {
        self.stop().await;
        if channel_login.is_empty() {
            return;
        }
        let app = self.app.clone();
        let handle = tauri::async_runtime::spawn(async move {
            Self::run(app, channel_login).await;
        });
        *self.task.lock().await = Some(handle);
    }

    pub async fn stop(&self) {
        if let Some(h) = self.task.lock().await.take() {
            h.abort();
        }
    }

    async fn validate_user_id(token: &str) -> Option<String> {
        let client = reqwest::Client::new();
        let resp = client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {token}"))
            .send()
            .await
            .ok()?;
        let j: serde_json::Value = resp.json().await.ok()?;
        j["user_id"].as_str().map(|s| s.to_string())
    }

    async fn run(app: AppHandle, channel_login: String) {
        loop {
            let token = match crate::twitch_device_auth::get_device_token(&app).await {
                Some(t) => t,
                None => {
                    // not device-connected -> nothing to listen with; retry later in case they connect
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
            };
            let user_id = match Self::validate_user_id(&token).await {
                Some(u) => u,
                None => {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    continue;
                }
            };
            // resolve the numeric channel id from the login (IRC room-id isn't reliably available)
            let channel_id = match crate::helix::resolve_broadcaster_id(&channel_login, &token).await {
                Ok(id) => id,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    continue;
                }
            };
            if let Err(e) = Self::connect_once(&app, &channel_id, &user_id, &token).await {
                eprintln!("[pubsub] connection ended: {e}");
            }
            tokio::time::sleep(Duration::from_secs(3)).await; // reconnect backoff
        }
    }

    async fn connect_once(
        app: &AppHandle,
        channel_id: &str,
        user_id: &str,
        token: &str,
    ) -> Result<(), String> {
        let (ws, _) = tokio_tungstenite::connect_async(PUBSUB_URL)
            .await
            .map_err(|e| e.to_string())?;
        let (mut write, mut read) = ws.split();

        let topics = vec![
            format!("community-points-user-v1.{user_id}"),
            format!("community-points-channel-v1.{channel_id}"),
        ];
        let listen = json!({
            "type": "LISTEN",
            "nonce": uuid::Uuid::new_v4().to_string(),
            "data": { "topics": topics, "auth_token": token }
        });
        write
            .send(Message::Text(listen.to_string()))
            .await
            .map_err(|e| e.to_string())?;

        // Moderation actions taken against the logged-in user (the topic Twitch's own site uses to lift a
        // "you're banned / timed out" state live). IRC announces bans (CLEARCHAT) but never unbans, so
        // without this an unbanned user stayed locked out until they reloaded. Undocumented topic, so it
        // gets its OWN LISTEN: if Twitch ever rejects it, that error can't take the channel-points topics
        // above down with it.
        let listen_self_mod = json!({
            "type": "LISTEN",
            "nonce": uuid::Uuid::new_v4().to_string(),
            "data": { "topics": [format!("chatrooms-user-v1.{user_id}")], "auth_token": token }
        });
        let _ = write.send(Message::Text(listen_self_mod.to_string())).await;

        // PubSub wants a PING within every 5 min; we send every 4
        let mut ping = tokio::time::interval(Duration::from_secs(240));
        ping.tick().await; // consume the immediate tick
        loop {
            tokio::select! {
                _ = ping.tick() => {
                    if write.send(Message::Text(json!({ "type": "PING" }).to_string())).await.is_err() {
                        return Ok(());
                    }
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if Self::handle(app, &text) {
                                return Ok(()); // RECONNECT requested
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => return Ok(()),
                        Some(Err(e)) => return Err(e.to_string()),
                        _ => {}
                    }
                }
            }
        }
    }

    // returns true if Twitch asked us to RECONNECT
    fn handle(app: &AppHandle, text: &str) -> bool {
        let outer: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return false,
        };
        match outer["type"].as_str() {
            Some("RECONNECT") => return true,
            Some("MESSAGE") => {
                let topic = outer["data"]["topic"].as_str().unwrap_or("");
                let inner_str = outer["data"]["message"].as_str().unwrap_or("");
                let inner: serde_json::Value = match serde_json::from_str(inner_str) {
                    Ok(v) => v,
                    Err(_) => return false,
                };
                if topic.starts_with("community-points-channel-v1") {
                    if inner["type"].as_str() == Some("reward-redeemed") {
                        let r = &inner["data"]["redemption"];
                        let user = &r["user"];
                        let reward = &r["reward"];
                        let _ = app.emit("pubsub-redemption", json!({
                            "redemption_id": r["id"].as_str().unwrap_or(""),
                            "user_login": user["login"].as_str().unwrap_or(""),
                            "user_name": user["display_name"].as_str().or_else(|| user["login"].as_str()).unwrap_or(""),
                            "reward_title": reward["title"].as_str().unwrap_or(""),
                            "reward_cost": reward["cost"].as_i64().unwrap_or(0),
                            "user_input": r["user_input"].as_str().unwrap_or(""),
                        }));
                    }
                } else if topic.starts_with("chatrooms-user-v1") {
                    // e.g. {"type":"user_moderation_action","data":{"action":"unban","channel_id":"...",...}}
                    // read defensively (undocumented): accept the action under either key it's been seen with
                    if inner["type"].as_str() == Some("user_moderation_action") {
                        let d = &inner["data"];
                        let action = d["action"].as_str()
                            .or_else(|| d["moderation_action"].as_str())
                            .unwrap_or("");
                        let channel_id = d["channel_id"].as_str().unwrap_or("");
                        if !action.is_empty() && !channel_id.is_empty() {
                            let _ = app.emit("pubsub-self-moderation", json!({
                                "action": action,
                                "channel_id": channel_id,
                            }));
                        }
                    }
                } else if topic.starts_with("community-points-user-v1") {
                    // points-earned / claimed etc. carry the new balance for a channel
                    if let Some(bal) = inner["data"]["balance"]["balance"].as_i64() {
                        let ch = inner["data"]["balance"]["channel_id"].as_str().unwrap_or("");
                        let _ = app.emit("pubsub-points", json!({ "balance": bal, "channel_id": ch }));
                    }
                }
            }
            _ => {}
        }
        false
    }
}

#[tauri::command]
pub async fn pubsub_set_channel(
    channel_login: String,
    state: State<'_, Arc<PubSubService>>,
) -> Result<(), String> {
    state.set_channel(channel_login).await;
    Ok(())
}

#[tauri::command]
pub async fn pubsub_clear(state: State<'_, Arc<PubSubService>>) -> Result<(), String> {
    state.stop().await;
    Ok(())
}
