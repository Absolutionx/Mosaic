// 7TV EventAPI WebSocket client: subscribes to a channel's emote set for real-time
// add/remove/rename, since chat.js only fetches the set once at join. push-based, like eventsub.rs
// but against 7TV's unauthenticated EventAPI.
//
// protocol (github.com/SevenTV/EventAPI): connect wss://events.7tv.io/v3; Hello (op 1) gives
// heartbeat_interval; Subscribe (op 35) to "emote_set.update" keyed on the set's object_id; Dispatch
// (op 0) carries pushed/pulled/updated; reconnect on Reconnect (op 4) or 3 missed heartbeats. we re-subscribe from scratch rather than Resume

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

const EVENTAPI_WS: &str = "wss://events.7tv.io/v3";

#[derive(Deserialize)]
struct Envelope {
    op: u8,
    #[serde(default)]
    d: Value,
}

const OP_DISPATCH: u8 = 0;
const OP_HELLO: u8 = 1;
const OP_HEARTBEAT: u8 = 2;
const OP_RECONNECT: u8 = 4;
const OP_ACK: u8 = 5;
const OP_ERROR: u8 = 6;
const OP_END_OF_STREAM: u8 = 7;
const OP_SUBSCRIBE: u8 = 35;

// runs the 7TV EventAPI WebSocket loop in a background Tokio task, subscribed to one emote set's changes. exits when stop_rx fires. unlike eventsub::run, needs no access token, the EventAPI is public for this kind of subscription
pub async fn run(
    app: AppHandle,
    emote_set_id: String,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    'reconnect: loop {
        let ws = match tokio_tungstenite::connect_async(EVENTAPI_WS).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                eprintln!("[seventv-events] connect failed: {e}");
                return;
            }
        };

        let (mut write, mut read) = ws.split();

        // set once Hello arrives; None beforehand means "use a generous default while we wait", since the
        // spec doesn't guarantee Hello is the very first byte on the wire
        let mut heartbeat_interval_ms: u64 = 30_000;
        let mut missed_heartbeats: u32 = 0;

        loop {
            let timeout_duration =
                std::time::Duration::from_millis(heartbeat_interval_ms);

            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = write.send(Message::Close(None)).await;
                    return;
                }
                msg = tokio::time::timeout(timeout_duration, read.next()) => {
                    let msg = match msg {
                        Ok(m) => m,
                        Err(_) => {
                            // no traffic at all within one full interval, per spec 3 missed heartbeats means the connection is dead
                            missed_heartbeats += 1;
                            if missed_heartbeats >= 3 {
                                eprintln!(
                                    "[seventv-events] no heartbeat after {missed_heartbeats} intervals, reconnecting"
                                );
                                continue 'reconnect;
                            }
                            continue;
                        }
                    };

                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            missed_heartbeats = 0;
                            let env: Envelope = match serde_json::from_str(&text) {
                                Ok(e) => e,
                                Err(_) => continue,
                            };

                            match env.op {
                                OP_HELLO => {
                                    if let Some(ms) = env.d.get("heartbeat_interval").and_then(|v| v.as_u64()) {
                                        heartbeat_interval_ms = ms;
                                    }
                                    let sub = json!({
                                        "op": OP_SUBSCRIBE,
                                        "d": {
                                            "type": "emote_set.update",
                                            "condition": { "object_id": emote_set_id }
                                        }
                                    });
                                    if let Ok(text) = serde_json::to_string(&sub) {
                                        if let Err(e) = write.send(Message::Text(text)).await {
                                            eprintln!("[seventv-events] subscribe send failed: {e}");
                                            return;
                                        }
                                    }
                                }
                                OP_HEARTBEAT => {
                                }
                                OP_DISPATCH => {
                                    // the 7TV Dispatch envelope is:
                                    //   { "op": 0, "d": { "type": "emote_set.update", "body": { "pushed": [...], ... } } }
                                    // pushed/pulled/updated live in d.body, not d itself
                                    if let Some(inner_body) = env.d.get("body") {
                                        dispatch_event(&app, inner_body);
                                    }
                                }
                                OP_RECONNECT => {
                                    eprintln!("[seventv-events] server requested reconnect");
                                    let _ = write.send(Message::Close(None)).await;
                                    continue 'reconnect;
                                }
                                OP_ACK => {
                                    // confirms our Subscribe was accepted, nothing to act on, just useful in logs
                                }
                                OP_ERROR => {
                                    eprintln!("[seventv-events] server error: {}", env.d);
                                }
                                OP_END_OF_STREAM => {
                                    // server is about to close on its own terms, d.code says whether/how to reconnect (see EventAPI's
                                    // close-codes table), but reconnecting after a short pause is a fine default for the cases this app
                                    // cares about (restarts, maintenance); it'll fail fast and retry if the server really isn't coming back
                                    eprintln!("[seventv-events] end of stream: {}", env.d);
                                    let _ = write.send(Message::Close(None)).await;
                                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                    continue 'reconnect;
                                }
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            eprintln!("[seventv-events] connection closed, reconnecting");
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                            continue 'reconnect;
                        }
                        Some(Err(e)) => {
                            eprintln!("[seventv-events] read error: {e}, reconnecting");
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                            continue 'reconnect;
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

// extracts emote add/remove/update entries from an emote_set.update Dispatch's INNER body (d.body
// from the wire envelope, not d itself, the caller drills to the right level first). emits them to
// the frontend as seventv-emote-set-update; chat.js merges pushed+updated into its emote map and removes pulled entries
fn dispatch_event(app: &AppHandle, body: &Value) {
    // body.id is the emote SET's id (what we subscribed with); not forwarded, since the frontend only
    // ever has one channel's set active and doesn't need to re-check which set this was for
    let extract_emotes = |field: &str| -> Vec<Value> {
        body.get(field)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|change_field| change_field.get("value").cloned())
                    .collect()
            })
            .unwrap_or_default()
    };

    let pushed = extract_emotes("pushed");
    let updated = extract_emotes("updated");
    let pulled = extract_emotes("pulled");

    if pushed.is_empty() && updated.is_empty() && pulled.is_empty() {
        return;
    }

    let _ = app.emit("seventv-emote-set-update", json!({
        "added": pushed.into_iter().chain(updated).collect::<Vec<_>>(),
        "removed": pulled,
    }));
}
