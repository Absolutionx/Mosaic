// Twitch IRC chat client, in Rust (Tokio + tokio-tungstenite) because WebView2 Tracking Prevention
// silently kills the WebSocket to irc-ws.chat.twitch.tv from JS. two modes: anonymous (read-only,
// justinfan nick) or authenticated (NICK + PASS oauth:<token>, enabling send via chat:edit). parsed
// messages are emitted as Tauri events; 7TV emote fetching stays in JS

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

const TWITCH_IRC_WS: &str = "wss://irc-ws.chat.twitch.tv:443";

// credentials for an authenticated (read+write) IRC connection. not persisted, in memory only for the duration of the session
#[derive(Clone)]
pub struct AuthCredentials {
    pub access_token: String,
    pub login: String,
    pub user_id: String,
}

#[derive(Serialize, Clone)]
pub struct ChatMessageEvent {
    pub username: String,
    pub color: Option<String>,
    pub message: String,
    // raw value of the IRC badges tag, e.g. "broadcaster/1,subscriber/12". parsing and image resolution happen in chat.js
    pub badges: Option<String>,
    // bits cheered in this message (from the bits IRC tag). present only on cheer messages
    pub bits: Option<u32>,
    // set when the message was sent as a channel-point redemption that includes a chat message (custom-reward-id tag). only the UUID is in IRC, not the reward name, the frontend uses it to apply a visual indicator regardless of which reward
    pub custom_reward_id: Option<String>,
    // display name of the user being replied to (reply-parent-display-name tag). None if not a reply
    pub reply_parent_user: Option<String>,
    // truncated body of the parent message (reply-parent-msg-body tag). IRC escapes (\s -> space, \: -> semicolon) are unescaped before sending
    pub reply_parent_body: Option<String>,
    // id of the parent message (reply-parent-msg-id tag), so the UI can jump to the original if it's still in the buffer
    pub reply_parent_msg_id: Option<String>,
    // id of the thread's ROOT message (reply-thread-parent-msg-id tag), used to group a whole reply thread
    pub reply_thread_parent_msg_id: Option<String>,
    // true when the message was a /me (CTCP ACTION) command
    pub is_action: bool,
    // raw IRC @emotes tag value (e.g. "25:0-4/86:6-11"). used by the frontend to render Twitch native emotes by position
    pub emotes_tag: Option<String>,
    // Twitch-assigned message ID (IRC "id" tag). used by the frontend to send @reply-parent-msg-id when the user hits Reply
    pub msg_id: Option<String>,
    // sender's Twitch user id (IRC "user-id" tag), distinct from username (their display name). mod actions (timeout/ban) need this numeric id, so it's captured even though nothing used it before mod tools existed
    pub user_id: Option<String>,
    // true when this is the user's very first message ever in the channel (IRC "first-msg" tag, sent on every PRIVMSG, no extra capability beyond the tags one already requested). drives the purple first-time-chatter highlight on twitch.tv
    pub is_first_msg: bool,
    // true when the message carries msg-id=highlighted-message (the "Highlight My Message" channel-points
    // reward). Twitch renders these with an accent left border + tint.
    pub is_highlighted: bool,
}

#[derive(Serialize, Clone)]
pub struct ChatSystemEvent {
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct ChatRoomEvent {
    pub room_id: String,
}

// fired on ROOMSTATE. carries the channel's chat modes; each field is None when that tag wasn't in this
// particular ROOMSTATE (deltas only include what changed), so the frontend merges into its running state.
#[derive(serde::Serialize, Clone)]
pub struct ChatRoomStateEvent {
    pub emote_only: Option<bool>,
    pub followers_only: Option<i64>, // -1 = off, 0 = any follower, N = N minutes required
    pub subs_only: Option<bool>,
    pub slow: Option<i64>, // seconds between messages, 0 = off
    pub r9k: Option<bool>, // "unique chat"
}

// fired on USERSTATE (after JOIN and each sent message). carries the logged-in user's current badge
// string and chosen chat color for the channel, so the frontend can show both next to the input AND
// reuse them for the optimistic local echo of the user's own sent messages (Twitch's IRC never echoes a client's own PRIVMSG back, so USERSTATE is the only source for this account's own color/badges)
#[derive(Serialize, Clone)]
pub struct UserStateEvent {
    pub badges: String,
    pub color: Option<String>,
}

// fired on CLEARCHAT. either one user's messages were cleared (target_user_id/target_username set; ban_duration_secs set only for a timeout, not a permanent ban) or the whole chat was cleared (all three None)
#[derive(Serialize, Clone)]
pub struct ChatClearChatEvent {
    pub target_user_id: Option<String>,
    pub target_username: Option<String>,
    pub ban_duration_secs: Option<u32>,
}

// fired on CLEARMSG, one message deleted. target_msg_id matches the msg_id already sent on ChatMessageEvent for that message
#[derive(Serialize, Clone)]
pub struct ChatClearMsgEvent {
    pub target_msg_id: String,
}

#[derive(Serialize, Clone)]
pub struct ChatStatusEvent {
    pub status: String,
}

// fired on USERNOTICE, Twitch's channel events (subs, resubs, gift subs, raids, announcements).
// msg_id identifies the kind ("sub", "resub", "subgift", "raid", "announcement", etc). system_msg is
// Twitch's own formatted description as a fallback. the remaining fields are structured params, each present only for the kinds that carry them. chat-events.js turns this into a banner
#[derive(Serialize, Clone)]
pub struct ChatUsernoticeEvent {
    pub msg_id: String,
    pub system_msg: String,
    pub display_name: String,
    pub user_message: Option<String>,
    pub emotes_tag: Option<String>,
    pub sub_plan: Option<String>,
    pub cumulative_months: Option<u32>,
    pub streak_months: Option<u32>,
    pub recipient: Option<String>,
    pub gift_count: Option<u32>,
    pub raider_count: Option<u32>,
    pub announcement_color: Option<String>,
}

// parses a Twitch IRC tag string ("key1=val1;key2=val2") into a map
fn parse_tags(tag_str: &str) -> HashMap<String, String> {
    let mut tags = HashMap::new();
    for pair in tag_str.split(';') {
        if let Some(eq) = pair.find('=') {
            tags.insert(pair[..eq].to_string(), pair[eq + 1..].to_string());
        }
    }
    tags
}

// connects to Twitch IRC for the channel and streams parsed events to the frontend, RECONNECTING
// automatically until stop_rx fires.
//
// the reconnect loop exists because every way this connection can die used to just be accepted: a
// closed/errored socket broke the read loop (chat silently dead until a channel switch); Twitch's own
// RECONNECT command (sent routinely before it restarts an IRC edge server) wasn't recognized; and a
// half-open TCP connection after a network blip is the worst, no Close frame, no error, read.next()
// just never resolves while the status still says connected. confirmed as the cause of "live chat
// occasionally just stops." so now:
//   - any disconnect (close, error, RECONNECT, or silence timeout) tears down the socket and reconnects
//     with exponential backoff (1s doubling to a 30s cap, reset after any connection surviving 60s, so
//     a flapping network doesn't hammer Twitch while a one-off blip recovers in a second).
//   - a keepalive PINGs Twitch every 60s and treats 3 minutes with no inbound frames of ANY kind as
//     dead, that bound converts the silent half-open case into an ordinary reconnect. (Twitch's own
//     PINGs arrive ~every 5 min; ours provoke PONG traffic well inside the timeout on a healthy
//     connection, so 3 quiet minutes really means dead.)
//   - stop_rx still ends everything immediately, including mid-backoff.
//
// reconnects re-run the full handshake and JOIN; room_id_sent resets so the frontend re-receives
// chat-room and re-loads channel emotes/badges, all idempotent there. outgoing_rx receives messages to
// send (e.g. the user's own PRIVMSG); the caller keeps the paired Sender and uses it from
// send_chat_message to push messages in without direct WebSocket access, and messages arriving during a
// reconnect gap wait in the channel until the next connection is up. runs inside a spawned Tokio task,
// errors are emitted as chat-system events rather than propagated, since there's no caller left to receive a Result once this runs in the background
pub async fn run_chat_client(
    app: AppHandle,
    channel: String,
    auth: Option<AuthCredentials>,
    mut outgoing_rx: tokio::sync::mpsc::UnboundedReceiver<OutgoingMessage>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let emit_status = |status: &str| {
        let _ = app.emit("chat-status", ChatStatusEvent { status: status.into() });
    };
    let emit_system = |text: String| {
        let _ = app.emit("chat-system", ChatSystemEvent { text });
    };

    let channel_lower = channel.to_lowercase();
    let mut backoff_secs: u64 = 1;
    let mut first_attempt = true;

    // macro-free helper for "wait out the backoff unless stop fires first", used from two places below. returns true if stop fired (caller must return)
    async fn backoff_or_stop(
        stop_rx: &mut tokio::sync::oneshot::Receiver<()>,
        secs: u64,
    ) -> bool {
        tokio::select! {
            _ = stop_rx => true,
            _ = tokio::time::sleep(std::time::Duration::from_secs(secs)) => false,
        }
    }

    'outer: loop {
        if first_attempt {
            emit_status("connecting");
            emit_system(format!("Connecting to chat for #{channel}..."));
        } else {
            emit_status("reconnecting");
        }

        let (ws_stream, _) = match tokio_tungstenite::connect_async(TWITCH_IRC_WS).await {
            Ok(pair) => pair,
            Err(e) => {
                emit_status("reconnecting");
                emit_system(format!(
                    "Failed to connect to Twitch chat ({e}) - retrying in {backoff_secs}s..."
                ));
                if backoff_or_stop(&mut stop_rx, backoff_secs).await {
                    emit_status("disconnected");
                    return;
                }
                backoff_secs = (backoff_secs * 2).min(30);
                first_attempt = false;
                continue 'outer;
            }
        };

        let (mut write, mut read) = ws_stream.split();

        let handshake = match &auth {
            Some(creds) => vec![
                format!("PASS oauth:{}", creds.access_token),
                format!("NICK {}", creds.login),
                "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
                format!("JOIN #{channel_lower}"),
            ],
            None => {
                let anon_nick = format!("justinfan{}", 10000 + (rand_u32() % 89999));
                vec![
                    "PASS SCHMOOPIIE".to_string(),
                    format!("NICK {anon_nick}"),
                    "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
                    format!("JOIN #{channel_lower}"),
                ]
            }
        };

        let mut handshake_failed = false;
        for line in handshake {
            if let Err(e) = write.send(Message::Text(line)).await {
                emit_system(format!(
                    "Failed to send IRC handshake ({e}) - retrying in {backoff_secs}s..."
                ));
                handshake_failed = true;
                break;
            }
        }
        if handshake_failed {
            emit_status("reconnecting");
            if backoff_or_stop(&mut stop_rx, backoff_secs).await {
                emit_status("disconnected");
                return;
            }
            backoff_secs = (backoff_secs * 2).min(30);
            first_attempt = false;
            continue 'outer;
        }

        if !first_attempt {
            emit_system("Chat reconnected.".into());
        }

        let connected_at = std::time::Instant::now();
        let mut last_inbound = std::time::Instant::now();
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(60));
        // a tokio interval's first tick fires immediately, skip it so the first keepalive PING goes out at t+60s, not t+0
        keepalive.tick().await;

        let mut room_id_sent = false;

        // inner connection loop. breaks with a human-readable reason when the connection should be re-established; returns outright when stop_rx fires
        let disconnect_reason: String = loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = write.send(Message::Close(None)).await;
                    emit_status("disconnected");
                    return;
                }
                _ = keepalive.tick() => {
                    if last_inbound.elapsed() > std::time::Duration::from_secs(180) {
                        // see the doc comment: the half-open TCP case, no frames of any kind in 3 minutes on a connection that should carry Twitch PINGs every ~5 min and our PING every 60s
                        break "went silent (no data for 3 minutes)".to_string();
                    }
                    // provoke a PONG so a healthy-but-quiet channel keeps last_inbound fresh. a send error here is itself a dead-connection signal
                    if write.send(Message::Text("PING :keepalive".to_string())).await.is_err() {
                        break "keepalive send failed".to_string();
                    }
                }
                outgoing = outgoing_rx.recv() => {
                    match outgoing {
                        Some(OutgoingMessage::Privmsg(text)) => {
                            let line = format!("PRIVMSG #{channel_lower} :{text}");
                            if let Err(e) = write.send(Message::Text(line)).await {
                                emit_system(format!("Failed to send message: {e}"));
                            }
                        }
                        Some(OutgoingMessage::ReplyPrivmsg { reply_to_id, text }) => {
                            // Twitch IRC replies require the reply-parent-msg-id IRCv3 tag on the PRIVMSG line itself
                            let line = format!(
                                "@reply-parent-msg-id={reply_to_id} PRIVMSG #{channel_lower} :{text}"
                            );
                            if let Err(e) = write.send(Message::Text(line)).await {
                                emit_system(format!("Failed to send reply: {e}"));
                            }
                        }
                        None => {
                            // sender side dropped, shouldn't happen while the connection is alive, and isn't fatal; stop_rx or the read side ends the loop well before the theoretical busy-loop would matter
                        }
                    }
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            last_inbound = std::time::Instant::now();
                            let mut reconnect_requested = false;
                            for line in text.split("\r\n").filter(|l| !l.is_empty()) {
                                // Twitch sends RECONNECT before restarting an IRC edge server; the connection is about to die whether we cooperate or not, so treat it as an immediate (no-backoff-growth) rebuild
                                if is_reconnect_command(line) {
                                    reconnect_requested = true;
                                    continue;
                                }
                                handle_irc_line(
                                    line,
                                    &app,
                                    &mut write,
                                    &channel_lower,
                                    &mut room_id_sent,
                                ).await;
                            }
                            if reconnect_requested {
                                backoff_secs = 1;
                                break "was asked to reconnect by Twitch (server restarting)".to_string();
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            break "connection closed".to_string();
                        }
                        Some(Err(e)) => {
                            break format!("connection error: {e}");
                        }
                        Some(Ok(_)) => {
                            // Ping/Pong/Binary, tungstenite handles protocol replies itself; all that matters here is that the connection demonstrably isn't dead
                            last_inbound = std::time::Instant::now();
                        }
                    }
                }
            }
        };

        // a connection that held for a while proves the network/server is fine, don't make the NEXT blip pay this one's accumulated backoff
        if connected_at.elapsed() > std::time::Duration::from_secs(60) {
            backoff_secs = 1;
        }
        emit_status("reconnecting");
        emit_system(format!("Chat {disconnect_reason} - reconnecting in {backoff_secs}s..."));
        if backoff_or_stop(&mut stop_rx, backoff_secs).await {
            emit_status("disconnected");
            return;
        }
        backoff_secs = (backoff_secs * 2).min(30);
        first_attempt = false;
    }
}

// true if line is Twitch's IRC RECONNECT command (optionally preceded by IRCv3 tags and/or a :prefix). sent shortly before Twitch restarts the edge server this connection is attached to
fn is_reconnect_command(line: &str) -> bool {
    let mut rest = line;
    if let Some(stripped) = rest.strip_prefix('@') {
        match stripped.find(' ') {
            Some(idx) => rest = &stripped[idx + 1..],
            None => return false,
        }
    }
    if let Some(stripped) = rest.strip_prefix(':') {
        match stripped.find(' ') {
            Some(idx) => rest = &stripped[idx + 1..],
            None => return false,
        }
    }
    rest.trim_start().split_whitespace().next() == Some("RECONNECT")
}

// messages that can be sent into a running connection's outgoing_rx from a separate Tauri command (send_chat_message) with no direct WebSocket access
pub enum OutgoingMessage {
    Privmsg(String),
    // reply to a specific message. Twitch IRC requires the reply-parent-msg-id IRCv3 tag as a leading @tag on the PRIVMSG line
    ReplyPrivmsg { reply_to_id: String, text: String },
}

async fn handle_irc_line<S>(
    line: &str,
    app: &AppHandle,
    write: &mut futures_util::stream::SplitSink<S, Message>,
    channel: &str,
    room_id_sent: &mut bool,
) where
    S: futures_util::Sink<Message> + Unpin,
{
    let mut tags = HashMap::new();
    let mut rest = line;

    if let Some(stripped) = rest.strip_prefix('@') {
        if let Some(space_idx) = stripped.find(' ') {
            tags = parse_tags(&stripped[..space_idx]);
            rest = &stripped[space_idx + 1..];
        }
    }

    // PING keepalive, Twitch drops the connection if we don't PONG back
    if rest.starts_with("PING") {
        let _ = write.send(Message::Text("PONG :tmi.twitch.tv".to_string())).await;
        return;
    }

    let mut prefix = "";
    if let Some(stripped) = rest.strip_prefix(':') {
        if let Some(space_idx) = stripped.find(' ') {
            prefix = &stripped[..space_idx];
            rest = &stripped[space_idx + 1..];
        }
    }

    let (head, trailing) = match rest.find(" :") {
        Some(idx) => (&rest[..idx], &rest[idx + 2..]),
        None => (rest, ""),
    };
    let command = head.split(' ').next().unwrap_or("");

    match command {
        "001" => {
            let _ = app.emit(
                "chat-status",
                ChatStatusEvent { status: format!("connected (#{channel})") },
            );
        }
        "ROOMSTATE" => {
            if !*room_id_sent {
                if let Some(room_id) = tags.get("room-id") {
                    *room_id_sent = true;
                    let _ = app.emit("chat-room", ChatRoomEvent { room_id: room_id.clone() });
                }
            }
            // ROOMSTATE carries the chat modes: on join all are present, on a change only the changed
            // tag(s) are, so the frontend merges. emit whatever is present this message.
            let _ = app.emit("chat-roomstate", ChatRoomStateEvent {
                emote_only: tags.get("emote-only").map(|v| v == "1"),
                followers_only: tags.get("followers-only").and_then(|v| v.parse::<i64>().ok()),
                subs_only: tags.get("subs-only").map(|v| v == "1"),
                slow: tags.get("slow").and_then(|v| v.parse::<i64>().ok()),
                r9k: tags.get("r9k").map(|v| v == "1"),
            });
        }
        "PRIVMSG" => {
            let username = tags
                .get("display-name")
                .cloned()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| prefix.split('!').next().unwrap_or("user").to_string());
            let color    = tags.get("color").cloned().filter(|s| !s.is_empty());
            let badges   = tags.get("badges").cloned().filter(|s| !s.is_empty());
            let bits     = tags.get("bits").and_then(|v| v.parse::<u32>().ok());
            let custom_reward_id = tags.get("custom-reward-id")
                .cloned().filter(|s| !s.is_empty());
            let reply_parent_user = tags.get("reply-parent-display-name")
                .cloned().filter(|s| !s.is_empty());
            let reply_parent_body = tags.get("reply-parent-msg-body")
                .cloned().filter(|s| !s.is_empty())
                .map(|s| {
                    // unescape IRC tag value encoding: \s -> space, \: -> semicolon, \\ -> backslash
                    s.replace("\\s", " ").replace("\\:", ";").replace("\\\\", "\\")
                });
            let reply_parent_msg_id = tags.get("reply-parent-msg-id")
                .cloned().filter(|s| !s.is_empty());
            let reply_thread_parent_msg_id = tags.get("reply-thread-parent-msg-id")
                .cloned().filter(|s| !s.is_empty());
            let msg_id    = tags.get("id").cloned().filter(|s| !s.is_empty());
            let emotes_tag = tags.get("emotes").cloned().filter(|s| !s.is_empty());
            let user_id = tags.get("user-id").cloned().filter(|s| !s.is_empty());
            let is_first_msg = tags.get("first-msg").map(|v| v == "1").unwrap_or(false);
            let is_highlighted = tags
                .get("msg-id")
                .map(|v| v == "highlighted-message")
                .unwrap_or(false);

            // strip the CTCP ACTION wrapper (\x01ACTION ...\x01) that bots and /me use. pass is_action so the frontend renders it in italics, matching Twitch
            let (message, is_action) = if trailing.starts_with("ACTION ")
                && trailing.ends_with('')
            {
                let body = &trailing[8..trailing.len() - 1]; // strip prefix+suffix
                (body.to_string(), true)
            } else {
                (trailing.to_string(), false)
            };

            let _ = app.emit(
                "chat-message",
                ChatMessageEvent {
                    username, color,
                    message,
                    badges, bits, custom_reward_id,
                    reply_parent_user, reply_parent_body,
                    reply_parent_msg_id,
                    reply_thread_parent_msg_id,
                    msg_id, user_id, is_action, emotes_tag,
                    is_first_msg,
                    is_highlighted,
                },
            );
        }
        "USERNOTICE" => {
            // USERNOTICE carries Twitch's "event" messages: subs, resubs, gift subs, raids, announcements, etc.
            // the msg-id tag identifies which. system-msg is Twitch's pre-formatted description, surfaced as a
            // fallback, but we also pull structured fields for a richer banner. trailing (if present) is the user's attached message (e.g. a resub message)
            let msg_id = tags.get("msg-id").cloned().unwrap_or_default();
            let system_msg = tags.get("system-msg")
                .cloned()
                .map(|s| s.replace("\\s", " ").replace("\\:", ";").replace("\\\\", "\\"))
                .unwrap_or_default();
            let display_name = tags.get("display-name").cloned()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| prefix.split('!').next().unwrap_or("someone").to_string());
            let user_message = if trailing.is_empty() { None } else { Some(trailing.to_string()) };
            let emotes_tag = tags.get("emotes").cloned().filter(|s| !s.is_empty());

            // sub-plan (1000/2000/3000/Prime) and cumulative months, present on sub/resub. gift subs carry recipient + gift count. raids carry the raider's viewer count. all optional depending on kind
            let sub_plan = tags.get("msg-param-sub-plan").cloned().filter(|s| !s.is_empty());
            let cumulative_months = tags.get("msg-param-cumulative-months")
                .and_then(|v| v.parse::<u32>().ok());
            let streak_months = tags.get("msg-param-streak-months")
                .and_then(|v| v.parse::<u32>().ok())
                .filter(|&m| m > 0);
            let recipient = tags.get("msg-param-recipient-display-name")
                .cloned().filter(|s| !s.is_empty());
            let gift_count = tags.get("msg-param-mass-gift-count")
                .and_then(|v| v.parse::<u32>().ok());
            let raider_count = tags.get("msg-param-viewerCount")
                .and_then(|v| v.parse::<u32>().ok());
            let announcement_color = tags.get("msg-param-color")
                .cloned().filter(|s| !s.is_empty());

            let _ = app.emit(
                "chat-usernotice",
                ChatUsernoticeEvent {
                    msg_id,
                    system_msg,
                    display_name,
                    user_message,
                    emotes_tag,
                    sub_plan,
                    cumulative_months,
                    streak_months,
                    recipient,
                    gift_count,
                    raider_count,
                    announcement_color,
                },
            );
        }
        "NOTICE" => {
            if !trailing.is_empty() {
                let _ = app.emit("chat-system", ChatSystemEvent { text: trailing.to_string() });
            }
        }
        "CLEARCHAT" => {
            // two shapes share this command:
            //   CLEARCHAT #channel :username  - one user's messages cleared (ban-duration tag present = timeout for
            //     that many seconds; absent = permanent ban)
            //   CLEARCHAT #channel            - entire chat cleared (the "Clear Chat" action; no trailing text)
            // emitted regardless of whether THIS client's user did it, any mod/the broadcaster clearing a user (via this app, the website, or any client) should grey out/remove that user's lines here too, same as twitch.tv
            if trailing.is_empty() {
                let _ = app.emit("chat-clearchat", ChatClearChatEvent {
                    target_user_id: None,
                    target_username: None,
                    ban_duration_secs: None,
                });
            } else {
                let ban_duration_secs = tags.get("ban-duration").and_then(|v| v.parse::<u32>().ok());
                let target_user_id = tags.get("target-user-id").cloned().filter(|s| !s.is_empty());
                let _ = app.emit("chat-clearchat", ChatClearChatEvent {
                    target_user_id,
                    target_username: Some(trailing.to_string()),
                    ban_duration_secs,
                });
            }
        }
        "CLEARMSG" => {
            // single-message delete (the "Delete" action on one line, vs CLEARCHAT's whole-user/whole-room clears). target-msg-id is the same id PRIVMSG's id tag carries as msg_id in ChatMessageEvent, the frontend matches them to know which line to grey out
            if let Some(target_msg_id) = tags.get("target-msg-id").cloned().filter(|s| !s.is_empty()) {
                let _ = app.emit("chat-clearmsg", ChatClearMsgEvent { target_msg_id });
            }
        }
        "USERSTATE" => {
            // sent after JOIN and after every PRIVMSG we send. contains the logged-in user's current badges/color
            // for this channel. previously emitted only when badges was non-empty, so a logged-in user with no
            // badges here but a real chosen chat color lost that color (the whole event was skipped), color and badges are independent tags, so this checks for either being present rather than gating on badges
            let badges = tags.get("badges").cloned().unwrap_or_default();
            let color = tags.get("color").cloned().filter(|s| !s.is_empty());
            if !badges.is_empty() || color.is_some() {
                let _ = app.emit("user-state", UserStateEvent { badges, color });
            }
        }
        _ => {
            // JOIN/PART/CAP ack/etc, not needed for display
        }
    }
}

// tiny dependency-free random source for the anonymous nick suffix. needn't be cryptographically random, just different enough to avoid nick collisions between concurrent anonymous connections
fn rand_u32() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(42);
    nanos
}
