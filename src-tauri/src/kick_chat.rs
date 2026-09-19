// Kick chat client (read-only), the chat half of the Twitch -> Kick failover (see kick.rs and
// tryKickFailover in main.js).
//
// Kick chat rides Pusher WebSockets: subscribe to the public chatrooms.{chatroom_id}.v2 (no auth to
// read); messages arrive as ChatMessageEvent frames. in Rust because WebView2 Tracking Prevention kills
// webview-opened WebSockets. sending is a separate, login-gated path (kick_oauth.rs); this client is
// read-only. messages are emitted as the same "chat-message" event the IRC client uses, so the renderer
// works unchanged. fields with no Kick equivalent (badges, bits, emote positions) are None; inline emote tokens become id-carrying markers (flatten_emote_tokens) the frontend renders directly

use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

use crate::chat::{ChatClearMsgEvent, ChatMessageEvent, ChatSystemEvent};

// Kick's public Pusher endpoint (app key + us2 cluster), as used by kick.com's own frontend. unofficial; the key has rotated before and may again, a connect failure is reported as a system line and retried, nothing more
const PUSHER_URL: &str = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679\
                          ?protocol=7&client=js&version=8.4.0&flash=false";

// max reconnect backoff. kept short-ish: this client only runs during an active failover session, so a long backoff just means dead chat
const MAX_BACKOFF_SECS: u64 = 15;

// how often WE ping Pusher to keep the socket alive. Pusher closes a connection idle past the
// activity_timeout it sends in pusher:connection_established (typically 120s); the client must ping
// before then, not just pong server pings. without this, a quiet channel (most notably right after a
// stream ENDS, when a failover session's chat goes silent) would idle out and drop, reconnect, idle
// out again, in a visible loop. 30s stays comfortably under Pusher's default; if the server advertises a shorter timeout we tighten to it
const PING_INTERVAL_SECS: u64 = 30;

// if a ping we sent goes this long with no pong (or any other frame) back, treat the socket as dead and reconnect rather than waiting minutes for TCP to time out. any inbound frame (pong, chat message, Pusher ping) counts as liveness and clears this
const PONG_TIMEOUT_SECS: u64 = 10;

pub struct KickChatState {
    // stop-channel for the running client task, if any. dropping or firing it ends the loop cleanly; replaced on every start
    stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for KickChatState {
    fn default() -> Self {
        KickChatState { stop_tx: Mutex::new(None) }
    }
}

fn stop_current(state: &KickChatState) {
    if let Ok(mut guard) = state.stop_tx.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}

// starts (or restarts) the Kick chat client for the chatroom. any previously running client is stopped first, there is at most one
#[tauri::command]
pub async fn start_kick_chat(
    app: AppHandle,
    state: tauri::State<'_, KickChatState>,
    chatroom_id: u64,
) -> Result<(), String> {
    stop_current(&state);
    let (tx, rx) = tokio::sync::oneshot::channel();
    *state.stop_tx.lock().map_err(|e| e.to_string())? = Some(tx);
    tauri::async_runtime::spawn(run(app, chatroom_id, rx));
    Ok(())
}

// stops the Kick chat client if one is running. safe to call anytime
#[tauri::command]
pub async fn stop_kick_chat(state: tauri::State<'_, KickChatState>) -> Result<(), String> {
    stop_current(&state);
    Ok(())
}

fn system_line(app: &AppHandle, text: impl Into<String>) {
    let _ = app.emit("chat-system", ChatSystemEvent { text: text.into() });
}

async fn run(
    app: AppHandle,
    chatroom_id: u64,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let mut attempt: u32 = 0;
    let mut announced = false;
    // pane-visible diagnostics (system_line), added because the release build is windows_subsystem =
    // "windows": eprintln! goes to a stderr nobody sees unless the exe was launched with a redirect, so
    // failures here used to be invisible in the built app. the eprintln!s stay (more detail, useful in
    // dev); these flags keep the PANE lines rate-limited so a persistent failure doesn't scroll chat with a
    // system line every retry: warned_unconfirmed (at most one "subscription not confirming" line per
    // client) and lost_after_healthy ("connection lost" only when a CONFIRMED session drops, paired with one "reconnected" on recovery)
    let mut warned_unconfirmed = false;
    let mut lost_after_healthy = false;
    // flap detection for the pane messages. the keepalive ping means a healthy offline chat basically
    // never drops, so a drop now is worth surfacing, but a single blip the reconnect swallows in a second
    // isn't. so: announce the FIRST confirmed drop, then stay quiet unless drops keep coming in a short window, THAT (repeated drops) is the real problem, and exactly what the old silent code hid
    let mut confirmed_drops: u32 = 0;
    let mut last_drop_at: Option<std::time::Instant> = None;
    let mut flap_warned = false;

    // NOTE on stop_rx: a oneshot receiver must not be polled after completing. every select! below breaks/returns the moment it fires, so it's only re-polled while still pending
    loop {
        attempt += 1;

        let connected = tokio::select! {
            _ = &mut stop_rx => return,
            r = tokio_tungstenite::connect_async(PUSHER_URL) => r,
        };
        let mut ws = match connected {
            Ok((ws, _)) => ws,
            Err(e) => {
                eprintln!("[kick-chat] connect failed (attempt {attempt}): {e}");
                if attempt == 1 {
                    system_line(&app, "Couldn't reach Kick chat - retrying…");
                }
                if backoff_or_stop(&mut stop_rx, attempt).await { return; }
                continue;
            }
        };

        // subscribe only AFTER pusher:connection_established arrives. this originally subscribed immediately,
        // on the theory that connection_established only matters for private/presence channels (which need its
        // socket_id), but Pusher silently DROPS a pusher:subscribe sent before the connection is established,
        // public channel or not. maximally quiet failure: socket up, pings answered, subscription never
        // confirmed, zero messages, no reconnect because nothing errored. waiting is also what the working kick-api crate does before subscribing to this same channel
        let mut subscribed = false;

        // client keepalive: fire the first tick one interval out (not immediately, the handshake frames prove liveness), then every PING_INTERVAL_SECS. only SENDS once subscribed, so a stalled handshake is left to confirm_deadline
        let mut ping_interval = tokio::time::interval_at(
            tokio::time::Instant::now() + std::time::Duration::from_secs(PING_INTERVAL_SECS),
            std::time::Duration::from_secs(PING_INTERVAL_SECS),
        );
        // watchdog: Some(deadline) only while a ping is outstanding. any inbound frame clears it back to None (see the frame arm)
        let mut awaiting_pong: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;

        // belt to the ordering fix's suspenders: if the subscription isn't CONFIRMED within this window (subscribe frame lost some other way, Kick renames the channel someday, whatever) force a reconnect instead of hanging silently forever (the trap the old code fell into). generous window: covers established + subscribe + confirmation, each normally <1s
        let confirm_deadline = tokio::time::sleep(std::time::Duration::from_secs(15));
        tokio::pin!(confirm_deadline);

        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = ws.close(None).await;
                    return;
                }
                // `if !subscribed` disarms this branch once the subscription is confirmed, the deadline only polices the handshake, never a healthy connection
                _ = &mut confirm_deadline, if !subscribed => {
                    eprintln!(
                        "[kick-chat] subscription unconfirmed after 15s \
                         (attempt {attempt}) - reconnecting"
                    );
                    if !warned_unconfirmed {
                        warned_unconfirmed = true;
                        system_line(
                            &app,
                            "Kick chat isn't confirming the subscription - retrying…",
                        );
                    }
                    let _ = ws.close(None).await;
                    break; // reconnect
                }
                // time to send our keepalive ping (only once healthy)
                _ = ping_interval.tick(), if subscribed => {
                    let ping = json!({"event": "pusher:ping", "data": {}});
                    if ws.send(Message::Text(ping.to_string())).await.is_err() {
                        break; // reconnect
                    }
                    // arm the watchdog if it isn't already: the next inbound frame of ANY kind disarms it
                    if awaiting_pong.is_none() {
                        awaiting_pong = Some(Box::pin(tokio::time::sleep(
                            std::time::Duration::from_secs(PONG_TIMEOUT_SECS),
                        )));
                    }
                }
                // pong (or anything) never came back in time: socket is wedged, reconnect now instead of waiting on TCP
                _ = async { awaiting_pong.as_mut().unwrap().as_mut().await },
                    if awaiting_pong.is_some() =>
                {
                    eprintln!("[kick-chat] ping timed out - reconnecting");
                    let _ = ws.close(None).await;
                    break; // reconnect
                }
                frame = ws.next() => {
                    // any inbound frame proves the socket is alive, our pong arrives as a Text frame, but so does a chat message or a server ping, all equally valid liveness. clear the watchdog before handling it
                    awaiting_pong = None;
                    match frame {
                    Some(Ok(Message::Text(txt))) => {
                        match handle_frame(&app, &txt) {
                            FrameAction::Pong => {
                                let pong = json!({"event": "pusher:pong", "data": {}});
                                let _ = ws.send(Message::Text(pong.to_string())).await;
                            }
                            // connection established, NOW the server will honor a subscribe (see the comment above the loop for why not earlier)
                            FrameAction::Established => {
                                let sub = json!({
                                    "event": "pusher:subscribe",
                                    "data": {
                                        "auth": "",
                                        "channel": format!("chatrooms.{chatroom_id}.v2"),
                                    },
                                });
                                if ws.send(Message::Text(sub.to_string())).await.is_err() {
                                    break; // reconnect
                                }
                            }
                            FrameAction::Subscribed => {
                                subscribed = true;
                                attempt = 0; // healthy, reset the backoff budget
                                // announce once per client, not once per reconnect, a flaky network shouldn't spam the pane. the one exception: recovery from a drop the pane was told about deserves its closing bracket
                                if !announced {
                                    announced = true;
                                    // whether sending is possible depends on Kick login state, which this read-side client can't see, an unconditional "(read-only)" here was wrong for a logged-in user, and duplicated (or contradicted) the specific reason chat.js's connectKick already prints when sending genuinely isn't available
                                    system_line(&app, "Kick chat connected.");
                                } else if lost_after_healthy {
                                    lost_after_healthy = false;
                                    // close the bracket on whichever message the drop emitted: a sustained-trouble warning gets an explicit "recovered", a routine blip gets the matching "reconnected". either way, reset the flap state so a future problem warns afresh
                                    if flap_warned {
                                        system_line(&app, "Kick chat recovered.");
                                    } else {
                                        system_line(&app, "Kick chat reconnected.");
                                    }
                                    flap_warned = false;
                                    confirmed_drops = 0;
                                }
                            }
                            FrameAction::None => {}
                        }
                    }
                    // Pusher also sends protocol-level pings
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break, // reconnect
                    Some(Ok(_)) => {}
                    }
                }
            }
        }

        // fell out of the read loop -> the connection is gone and a reconnect is coming. only tell the pane when a CONFIRMED session dropped: a mid-handshake break is either already covered (warned_unconfirmed) or transient noise the retry absorbs. intentional stops return from inside the select! and never reach here
        if subscribed {
            lost_after_healthy = true;

            // flap accounting: reset the counter if the last drop was a while ago (an isolated blip long past doesn't count toward "keeps dropping"); otherwise it's part of a cluster
            let now = std::time::Instant::now();
            if last_drop_at.map_or(true, |t| now.duration_since(t).as_secs() > 60) {
                confirmed_drops = 0;
            }
            confirmed_drops += 1;
            last_drop_at = Some(now);

            if confirmed_drops >= 3 && !flap_warned {
                // repeated drops in a short window = a real, ongoing problem (Kick trouble, network, a rotated Pusher key). say so ONCE, distinctly, so it's not mistaken for the routine single reconnect below
                flap_warned = true;
                system_line(
                    &app,
                    "Kick chat keeps dropping - there may be a connection problem.",
                );
            } else if confirmed_drops < 3 {
                // first/second drop: the normal, reassuring pair. paired with a "reconnected" on recovery (see the Subscribed arm)
                system_line(&app, "Kick chat connection lost - reconnecting…");
            }
            // between the flap warning and recovery, stay quiet, one warning stands until chat is healthy again; no per-cycle spam
        }

        if backoff_or_stop(&mut stop_rx, attempt.max(1)).await { return; }
    }
}

// sleeps the backoff for attempt, returning true if stop fired first
async fn backoff_or_stop(
    stop_rx: &mut tokio::sync::oneshot::Receiver<()>,
    attempt: u32,
) -> bool {
    let secs = (1u64 << attempt.min(4)).min(MAX_BACKOFF_SECS); // 2,4,8,16 -> 15
    tokio::select! {
        _ = stop_rx => true,
        _ = tokio::time::sleep(std::time::Duration::from_secs(secs)) => false,
    }
}

enum FrameAction {
    None,
    Pong,
    // pusher:connection_established, the earliest moment a subscribe is honored rather than silently dropped
    Established,
    Subscribed,
}

// parses one Pusher text frame and emits the matching frontend event. anything unrecognized or malformed is silently skipped, an unofficial protocol drifting must degrade to dropped frames
fn handle_frame(app: &AppHandle, txt: &str) -> FrameAction {
    let Ok(env) = serde_json::from_str::<Value>(txt) else { return FrameAction::None };
    let event = env.get("event").and_then(|v| v.as_str()).unwrap_or("");

    match event {
        "pusher:ping" => FrameAction::Pong,
        "pusher:connection_established" => FrameAction::Established,
        "pusher_internal:subscription_succeeded" => FrameAction::Subscribed,
        // Pusher double-encodes: data is a STRING whose content is the actual event JSON, hence the from_str on a str field below
        "App\\Events\\ChatMessageEvent" => {
            let Some(m) = env
                .get("data")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            else { return FrameAction::None };

            let username = m
                .pointer("/sender/username")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if username.is_empty() || content.is_empty() {
                return FrameAction::None;
            }

            let _ = app.emit(
                "chat-message",
                ChatMessageEvent {
                    username,
                    color: m
                        .pointer("/sender/identity/color")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string),
                    message: flatten_emote_tokens(content),
                    // Kick badge identity, serialized in the kick/-prefixed form renderBadges (chat-badges.js) tells apart from Twitch's set/version pairs, see kick_badges_tag below. the remaining Twitch-specific fields have no Kick equivalent; the renderer treats None like a plain Twitch message without them
                    badges: kick_badges_tag(&m),
                    bits: None,
                    custom_reward_id: None,
                    reply_parent_user: None,
                    reply_parent_body: None,
                    is_action: false,
                    emotes_tag: None,
                    msg_id: m.get("id").and_then(|v| v.as_str()).map(str::to_string),
                    user_id: m
                        .pointer("/sender/id")
                        .and_then(|v| v.as_u64())
                        .map(|id| id.to_string()),
                    is_first_msg: false,
                    is_highlighted: false,
                    reply_parent_msg_id: None,
                    reply_thread_parent_msg_id: None,
                },
            );
            FrameAction::None
        }
        // mod deletions, map onto the existing clearmsg path so deleted Kick messages disappear from the pane like Twitch ones do
        "App\\Events\\MessageDeletedEvent" => {
            if let Some(target) = env
                .get("data")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|d| {
                    d.pointer("/message/id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
            {
                let _ = app.emit("chat-clearmsg", ChatClearMsgEvent { target_msg_id: target });
            }
            FrameAction::None
        }
        _ => FrameAction::None,
    }
}

// Kick embeds emotes in message content as [emote:12345:KEKW] tokens. the id alone determines the CDN
// image (files.kick.com/emotes/{id}/fullsize), so each token is rewritten to a \x01{id}\x01{name}\x01
// marker that renderMessageBody turns straight into an <img>, using the id from the token rather than
// looking the name up in a locally-fetched map. this matters because Kick lets a subscriber use emotes
// from ANY channel they subscribe to, not just the one being watched, so a message can carry a token
// for a channel whose emote set this app never fetched (it only loads the watched channel's native set
// via kick_channel_emotes). an earlier version flattened tokens to their bare name and relied on the
// frontend matching that name, which silently failed for cross-channel emotes: they rendered as plain
// text with no error. carrying the id forward removes that dependency. \x01 (SOH) is the delimiter
// because it can't appear in a Kick display name or be typed in the chat input, so it can't collide
// with real text. a token with no closing bracket is passed through untouched.
//
// also serializes the sender's Kick badge identity (sender.identity.badges, an array of {type, text,
// count?}) into ChatMessageEvent's badges string, in a form the shared renderer tells apart from
// Twitch's set/version pairs: each entry is kick/{type}/{count}, comma-joined (e.g.
// "kick/moderator/1,kick/subscriber/9"). count carries the badge's own number when Kick states one
// (subscriber months, gifted-sub totals), else 1, so the frontend can pick tiered art / the
// months-matched custom subscriber badge. types are restricted to the [a-z0-9_] charset Kick uses, they
// end up in DOM titles and lookup keys, so anything weirder off the wire is dropped. None (not an empty string) when the sender has no badges, matching a badge-less Twitch message
fn kick_badges_tag(m: &serde_json::Value) -> Option<String> {
    let arr = m.pointer("/sender/identity/badges")?.as_array()?;
    let mut parts: Vec<String> = Vec::new();
    for b in arr {
        let Some(t) = b.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        if t.is_empty()
            || !t
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            continue;
        }
        let count = b.get("count").and_then(|v| v.as_u64()).unwrap_or(1);
        parts.push(format!("kick/{t}/{count}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

fn flatten_emote_tokens(content: &str) -> String {
    const SEP: char = '\u{1}';
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("[emote:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + "[emote:".len()..];
        match after.find(']') {
            Some(end) => {
                // token body is "12345:KEKW", id is everything before the first ':', name everything after (emote names can't contain ':')
                let body = &after[..end];
                let mut parts = body.splitn(2, ':');
                let id = parts.next().unwrap_or("");
                let name = parts.next().unwrap_or(body);
                if id.chars().all(|c| c.is_ascii_digit()) && !id.is_empty() {
                    out.push(SEP);
                    out.push_str(id);
                    out.push(SEP);
                    out.push_str(name);
                    out.push(SEP);
                } else {
                    // malformed id, degrade to the old text-only behavior rather than emit a marker chat.js can't use
                    out.push_str(name);
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::flatten_emote_tokens;

    #[test]
    fn flattens_tokens_to_id_name_markers() {
        assert_eq!(
            flatten_emote_tokens("hi [emote:37226:KEKW] lol"),
            "hi \u{1}37226\u{1}KEKW\u{1} lol"
        );
        assert_eq!(
            flatten_emote_tokens("[emote:1:a][emote:2:b]"),
            "\u{1}1\u{1}a\u{1}\u{1}2\u{1}b\u{1}"
        );
        assert_eq!(flatten_emote_tokens("no emotes here"), "no emotes here");
        assert_eq!(flatten_emote_tokens("broken [emote:12"), "broken [emote:12");
        assert_eq!(flatten_emote_tokens(""), "");
    }

    #[test]
    fn non_numeric_id_degrades_to_text() {
        assert_eq!(flatten_emote_tokens("hi [emote:abc:KEKW] lol"), "hi KEKW lol");
    }

    #[test]
    fn serializes_badge_identity() {
        let m = serde_json::json!({
            "sender": { "identity": { "badges": [
                { "type": "moderator", "text": "Moderator" },
                { "type": "subscriber", "text": "Subscriber", "count": 9 },
                { "type": "sub_gifter", "text": "Sub Gifter", "count": 50 },
                { "type": "we<ird", "text": "dropped, unsafe charset" },
                { "text": "dropped, no type" }
            ]}}
        });
        assert_eq!(
            kick_badges_tag(&m).as_deref(),
            Some("kick/moderator/1,kick/subscriber/9,kick/sub_gifter/50")
        );
    }

    #[test]
    fn badge_tag_none_when_absent_or_empty() {
        let no_badges = serde_json::json!({ "sender": { "identity": { "badges": [] } } });
        assert_eq!(kick_badges_tag(&no_badges), None);
        let no_identity = serde_json::json!({ "sender": { "username": "x" } });
        assert_eq!(kick_badges_tag(&no_identity), None);
    }
}
