// Kick chat client (read-only), the chat half of the Twitch -> Kick failover (see kick.rs and
// tryKickFailover in main.js).
//
// Transport (since 10-16-26): Kick moved chat off Pusher (the old public app key now gets "4001 App key
// not in this cluster" on every cluster) onto its own Centrifugo server. The handshake, as kick.com does it:
//   1. POST web.kick.com/api/v1/realtime/connection {client:{id,type:"web"},capabilities:{...}}
//      -> the websocket URL (provider "centrifugo")
//   2. POST web.kick.com/api/v1/realtime/auth/connection {client_id} -> a guest token (JWT, ~45 min)
//   3. websocket: {"connect":{"token","name":"js"},"id":1}, then {"subscribe":{"channel":
//      "chatrooms.{chatroom_id}.v2"},"id":2}
// Messages arrive as {"push":{"channel","pub":{"data":{"event","data"}}}} where event/data are the same
// App\Events\ChatMessageEvent payloads Pusher used to carry, so the parsing below is unchanged. The server
// pings with "{}" every ~25 s and expects "{}" back; the token is refreshed in place before it expires.
// No login needed to read. In Rust because WebView2 Tracking Prevention kills webview-opened WebSockets.
// sending is a separate, login-gated path (kick_oauth.rs). messages are emitted as the same
// "chat-message" event the IRC client uses, so the renderer works unchanged; inline emote tokens become
// id-carrying markers (flatten_emote_tokens) the frontend renders directly

use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

use crate::chat::{ChatClearMsgEvent, ChatMessageEvent, ChatSystemEvent};

// where the handshake goes. unofficial, like everything Kick-web; if Kick moves again, every failure
// below ends in a visible system line rather than a silent empty chat
const REALTIME_API: &str = "https://web.kick.com/api/v1/realtime";
// used if the connection lookup fails but a token was still issued (the URL has been stable)
const DEFAULT_WS_URL: &str = "wss://realtime.us-west-2.platform.kick.com/connection/websocket";
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// max reconnect backoff. kept short-ish: dead chat is worse than a few extra requests
const MAX_BACKOFF_SECS: u64 = 15;

// the server pings every `ping` seconds (25 today, sent in the connect reply). if nothing at all arrives
// for ping + this, the socket is wedged: reconnect instead of waiting minutes for TCP to notice
const IDLE_GRACE_SECS: u64 = 20;
// refresh the token this long before it expires
const REFRESH_EARLY_SECS: u64 = 120;
// connect + subscribe confirmations must arrive within this
const HANDSHAKE_SECS: u64 = 15;

pub struct KickChatState {
    // stop-channel for the running client task, if any. dropping or firing it ends the loop cleanly; replaced on every start
    stop_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Default for KickChatState {
    fn default() -> Self {
        KickChatState { stop_tx: Mutex::new(None) }
    }
}

// which Kick chat client may still emit: stopping or replacing one moves this on, so a client that is still
// finishing a batch of lines can't put its last messages into the next chat
static KICK_CHAT_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct KickEmitter {
    app: AppHandle,
    gen: u64,
}

impl KickEmitter {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()> {
        if KICK_CHAT_GEN.load(std::sync::atomic::Ordering::SeqCst) != self.gen {
            return Ok(());
        }
        self.app.emit(event, payload)
    }
}

fn stop_current(state: &KickChatState) {
    KICK_CHAT_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
    let gen = KICK_CHAT_GEN.load(std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn(run(KickEmitter { app, gen }, chatroom_id, rx));
    Ok(())
}

// stops the Kick chat client if one is running. safe to call anytime
#[tauri::command]
pub async fn stop_kick_chat(state: tauri::State<'_, KickChatState>) -> Result<(), String> {
    stop_current(&state);
    Ok(())
}

fn system_line(app: &KickEmitter, text: impl Into<String>) {
    let _ = app.emit("chat-system", ChatSystemEvent { text: text.into(), msg_id: None });
}

// ---- handshake over HTTP -------------------------------------------------------------------------

// POST a JSON body to web.kick.com and parse the JSON reply. curl first, like kick.rs (Cloudflare fingerprints
// TLS and is friendlier to curl's), reqwest only when curl isn't installed
async fn post_kick_json(url: &str, body: &Value) -> Result<Value, String> {
    match post_via_curl(url, body).await {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => post_via_reqwest(url, body).await,
        Err(e) => Err(format!("failed to run curl: {e}")),
    }
}

async fn post_via_curl(url: &str, body: &Value) -> Result<Result<Value, String>, std::io::Error> {
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args([
        "-s", "-w", "\n%{http_code}", "--max-time", "10", "-X", "POST",
        "-H", "Accept: application/json",
        "-H", "Content-Type: application/json",
        "-H", "Origin: https://kick.com",
        "-H", "Referer: https://kick.com/",
        "-H", "x-app-platform: web",
        // body on stdin, so nothing from it ever lands on a command line
        "--data-binary", "@-",
    ]);
    cmd.arg("-H").arg(format!("User-Agent: {BROWSER_UA}"));
    cmd.arg(url);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(body.to_string().as_bytes()).await;
        // dropped here, closing stdin so curl sends
    }
    let output = child.wait_with_output().await?;
    Ok((|| {
        if !output.status.success() {
            return Err(format!("curl exited with code {:?}", output.status.code()));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let (text, code) = stdout.rsplit_once('\n').ok_or_else(|| "no reply".to_string())?;
        if code.trim() != "200" {
            return Err(format!("Kick returned {}", code.trim()));
        }
        serde_json::from_str(text).map_err(|e| format!("unreadable reply: {e}"))
    })())
}

async fn post_via_reqwest(url: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .header("Accept", "application/json")
        .header("Origin", "https://kick.com")
        .header("Referer", "https://kick.com/")
        .header("x-app-platform", "web")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Kick returned {}", resp.status().as_u16()));
    }
    resp.json::<Value>().await.map_err(|e| format!("unreadable reply: {e}"))
}

// the websocket URL from the connection reply. only a wss:// URL on a kick.com host is accepted: this
// value decides where the app connects, so a tampered or odd reply can't point it anywhere else
fn ws_url_from(reply: &Value) -> Option<String> {
    let conns = reply.pointer("/data/connections")?.as_array()?;
    let url = conns
        .iter()
        .find(|c| c.get("provider").and_then(|v| v.as_str()) == Some("centrifugo"))?
        .pointer("/credentials/url")?
        .as_str()?;
    let rest = url.strip_prefix("wss://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    let host_ok = !host.contains(['@', ':'])
        && (host == "kick.com" || host.ends_with(".kick.com"))
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    host_ok.then(|| url.to_string())
}

fn token_from(reply: &Value) -> Option<String> {
    let t = reply.pointer("/data/token")?.as_str()?;
    // a JWT: base64url segments and dots, nothing else
    let ok = !t.is_empty()
        && t.len() <= 4096
        && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then(|| t.to_string())
}

async fn fetch_ws_url(client_id: &str) -> Result<String, String> {
    let body = json!({
        "client": { "id": client_id, "type": "web" },
        "capabilities": { "accepted_providers": [{ "provider": "centrifugo" }] },
    });
    let reply = post_kick_json(&format!("{REALTIME_API}/connection"), &body).await?;
    ws_url_from(&reply).ok_or_else(|| "no usable chat server in Kick's reply".to_string())
}

async fn fetch_token(client_id: &str) -> Result<String, String> {
    let reply = post_kick_json(
        &format!("{REALTIME_API}/auth/connection"),
        &json!({ "client_id": client_id }),
    )
    .await?;
    token_from(&reply).ok_or_else(|| "no chat token in Kick's reply".to_string())
}

// ---- websocket loop ------------------------------------------------------------------------------

async fn run(
    app: KickEmitter,
    chatroom_id: u64,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    // one guest identity per client, like a browser tab's anon id; tokens are issued for it
    let client_id = uuid::Uuid::new_v4().to_string();
    let channel = format!("chatrooms.{chatroom_id}.v2");
    let mut attempt: u32 = 0;
    let mut announced = false;
    // pane lines are rate-limited so a persistent failure doesn't scroll chat with a line per retry:
    // one "couldn't connect" per client until it recovers, one "lost" per healthy session that drops
    let mut warned_failing = false;
    let mut lost_after_healthy = false;
    let mut confirmed_drops: u32 = 0;
    let mut last_drop_at: Option<std::time::Instant> = None;
    let mut flap_warned = false;

    // NOTE on stop_rx: a oneshot receiver must not be polled after completing. every select! below returns the moment it fires
    loop {
        attempt += 1;

        // 1+2: where to connect, and a token. both quick POSTs; stop is honored while they run
        let handshake = async {
            let url = match fetch_ws_url(&client_id).await {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("[kick-chat] connection lookup failed ({e}); using the default server");
                    DEFAULT_WS_URL.to_string()
                }
            };
            let token = fetch_token(&client_id).await?;
            Ok::<_, String>((url, token))
        };
        let (ws_url, token) = tokio::select! {
            _ = &mut stop_rx => return,
            r = handshake => match r {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[kick-chat] token request failed (attempt {attempt}): {e}");
                    if !warned_failing {
                        warned_failing = true;
                        system_line(&app, format!("Couldn't reach Kick chat ({e}) - retrying…"));
                    }
                    if backoff_or_stop(&mut stop_rx, attempt).await { return; }
                    continue;
                }
            },
        };

        let request = match build_ws_request(&ws_url) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[kick-chat] bad websocket URL {ws_url}: {e}");
                if backoff_or_stop(&mut stop_rx, attempt).await { return; }
                continue;
            }
        };
        let connected = tokio::select! {
            _ = &mut stop_rx => return,
            r = tokio::time::timeout(
                std::time::Duration::from_secs(HANDSHAKE_SECS),
                tokio_tungstenite::connect_async(request),
            ) => r,
        };
        let mut ws = match connected {
            Ok(Ok((ws, _))) => ws,
            other => {
                let why = match other {
                    Ok(Err(e)) => e.to_string(),
                    _ => "timed out".to_string(),
                };
                eprintln!("[kick-chat] connect failed (attempt {attempt}): {why}");
                if !warned_failing {
                    warned_failing = true;
                    system_line(&app, "Couldn't reach Kick chat - retrying…");
                }
                if backoff_or_stop(&mut stop_rx, attempt).await { return; }
                continue;
            }
        };

        // 3: connect with the token; subscribe once the server accepts it
        let connect = json!({ "connect": { "token": token, "name": "js" }, "id": 1 });
        if ws.send(Message::Text(connect.to_string())).await.is_err() {
            if backoff_or_stop(&mut stop_rx, attempt).await { return; }
            continue;
        }

        let mut subscribed = false;
        let mut next_id: u64 = 3;
        let mut ping_secs: u64 = 25;
        let handshake_deadline = tokio::time::sleep(std::time::Duration::from_secs(HANDSHAKE_SECS));
        tokio::pin!(handshake_deadline);
        let idle = tokio::time::sleep(std::time::Duration::from_secs(ping_secs + IDLE_GRACE_SECS));
        tokio::pin!(idle);
        // armed once the connect reply says when the token expires
        let mut refresh_at: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;

        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = ws.close(None).await;
                    return;
                }
                _ = &mut handshake_deadline, if !subscribed => {
                    eprintln!("[kick-chat] handshake unconfirmed after {HANDSHAKE_SECS}s (attempt {attempt})");
                    if !warned_failing {
                        warned_failing = true;
                        system_line(&app, "Kick chat isn't confirming the connection - retrying…");
                    }
                    let _ = ws.close(None).await;
                    break;
                }
                _ = &mut idle => {
                    eprintln!("[kick-chat] nothing received for {}s - reconnecting", ping_secs + IDLE_GRACE_SECS);
                    let _ = ws.close(None).await;
                    break;
                }
                _ = async { refresh_at.as_mut().unwrap().as_mut().await }, if refresh_at.is_some() => {
                    refresh_at = None;
                    match fetch_token(&client_id).await {
                        Ok(t) => {
                            let msg = json!({ "refresh": { "token": t }, "id": next_id });
                            next_id += 1;
                            if ws.send(Message::Text(msg.to_string())).await.is_err() { break; }
                        }
                        // no fresh token: the server will end the session at expiry and the reconnect path takes over
                        Err(e) => eprintln!("[kick-chat] token refresh failed: {e}"),
                    }
                }
                frame = ws.next() => {
                    idle.as_mut().reset(
                        tokio::time::Instant::now() + std::time::Duration::from_secs(ping_secs + IDLE_GRACE_SECS),
                    );
                    match frame {
                        Some(Ok(Message::Text(txt))) => {
                            let mut reconnect = false;
                            // the server batches several replies into one frame, one JSON object per line
                            for line in txt.split('\n').filter(|l| !l.trim().is_empty()) {
                                match handle_line(&app, line) {
                                    LineAction::Ping => {
                                        if ws.send(Message::Text("{}".into())).await.is_err() { reconnect = true; }
                                    }
                                    LineAction::Connected { ping, ttl } => {
                                        if let Some(p) = ping.filter(|p| (5..=300).contains(p)) { ping_secs = p; }
                                        if let Some(t) = ttl {
                                            let wait = t.saturating_sub(REFRESH_EARLY_SECS).max(30);
                                            refresh_at = Some(Box::pin(tokio::time::sleep(std::time::Duration::from_secs(wait))));
                                        }
                                        let sub = json!({ "subscribe": { "channel": channel }, "id": 2 });
                                        if ws.send(Message::Text(sub.to_string())).await.is_err() { reconnect = true; }
                                    }
                                    LineAction::Refreshed { ttl } => {
                                        if let Some(t) = ttl {
                                            let wait = t.saturating_sub(REFRESH_EARLY_SECS).max(30);
                                            refresh_at = Some(Box::pin(tokio::time::sleep(std::time::Duration::from_secs(wait))));
                                        }
                                    }
                                    LineAction::Subscribed => {
                                        subscribed = true;
                                        attempt = 0;
                                        warned_failing = false;
                                        if !announced {
                                            announced = true;
                                            system_line(&app, "Kick chat connected.");
                                        } else if lost_after_healthy {
                                            lost_after_healthy = false;
                                            system_line(&app, if flap_warned { "Kick chat recovered." } else { "Kick chat reconnected." });
                                            flap_warned = false;
                                            confirmed_drops = 0;
                                        }
                                    }
                                    LineAction::Failed(why) => {
                                        eprintln!("[kick-chat] server error: {why}");
                                        if !warned_failing {
                                            warned_failing = true;
                                            system_line(&app, format!("Kick chat refused the connection ({why}) - retrying…"));
                                        }
                                        reconnect = true;
                                    }
                                    LineAction::Disconnect => reconnect = true,
                                    LineAction::None => {}
                                }
                                if reconnect { break; }
                            }
                            if reconnect {
                                let _ = ws.close(None).await;
                                break;
                            }
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            let _ = ws.send(Message::Pong(payload)).await;
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        Some(Ok(_)) => {}
                    }
                }
            }
        }

        // the connection is gone and a reconnect is coming. only a CONFIRMED session dropping is worth a line
        if subscribed {
            lost_after_healthy = true;
            let now = std::time::Instant::now();
            if last_drop_at.map_or(true, |t| now.duration_since(t).as_secs() > 60) {
                confirmed_drops = 0;
            }
            confirmed_drops += 1;
            last_drop_at = Some(now);
            if confirmed_drops >= 3 && !flap_warned {
                flap_warned = true;
                system_line(&app, "Kick chat keeps dropping - there may be a connection problem.");
            } else if confirmed_drops < 3 {
                system_line(&app, "Kick chat connection lost - reconnecting…");
            }
        }

        if backoff_or_stop(&mut stop_rx, attempt.max(1)).await { return; }
    }
}

// the websocket upgrade request, with the headers a browser on kick.com would send
fn build_ws_request(
    url: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    let h = req.headers_mut();
    h.insert("Origin", HeaderValue::from_static("https://kick.com"));
    h.insert("User-Agent", HeaderValue::from_static(BROWSER_UA));
    Ok(req)
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

#[derive(Debug, PartialEq)]
enum LineAction {
    None,
    // the server's "{}" ping, answered with "{}"
    Ping,
    // reply to our connect (id 1): ping interval and token lifetime, in seconds
    Connected { ping: Option<u64>, ttl: Option<u64> },
    // reply to a token refresh
    Refreshed { ttl: Option<u64> },
    // reply to our subscribe (id 2)
    Subscribed,
    // an error reply: the server's message
    Failed(String),
    // the server is ending the session
    Disconnect,
}

// one line of a frame: a reply to one of our commands, a ping, or a push (chat message etc.)
fn classify_line(line: &str) -> (LineAction, Option<Value>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return (LineAction::None, None) };
    let Some(obj) = v.as_object() else { return (LineAction::None, None) };
    if obj.is_empty() {
        return (LineAction::Ping, None);
    }
    if let Some(err) = obj.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("error");
        let code = err.get("code").and_then(|c| c.as_u64()).unwrap_or(0);
        let msg: String = msg.chars().filter(|c| !c.is_control()).take(80).collect();
        return (LineAction::Failed(format!("{code} {msg}")), None);
    }
    if let Some(c) = obj.get("connect") {
        return (
            LineAction::Connected {
                ping: c.get("ping").and_then(|x| x.as_u64()),
                ttl: c.get("ttl").and_then(|x| x.as_u64()),
            },
            None,
        );
    }
    if let Some(r) = obj.get("refresh") {
        return (LineAction::Refreshed { ttl: r.get("ttl").and_then(|x| x.as_u64()) }, None);
    }
    if obj.contains_key("subscribe") && obj.get("id").and_then(|i| i.as_u64()) == Some(2) {
        return (LineAction::Subscribed, None);
    }
    if let Some(push) = obj.get("push") {
        if push.get("disconnect").is_some() {
            return (LineAction::Disconnect, None);
        }
        if let Some(data) = push.pointer("/pub/data") {
            return (LineAction::None, Some(data.clone()));
        }
    }
    (LineAction::None, None)
}

fn handle_line(app: &KickEmitter, line: &str) -> LineAction {
    let (action, event) = classify_line(line);
    if let Some(env) = event {
        if let Some(e) = chat_event_from(&env) {
            match e {
                KickEvent::Message(m) => { let _ = app.emit("chat-message", *m); }
                KickEvent::Deleted(id) => {
                    let _ = app.emit("chat-clearmsg", ChatClearMsgEvent { target_msg_id: id });
                }
            }
        }
    }
    action
}

enum KickEvent {
    Message(Box<ChatMessageEvent>),
    Deleted(String),
}

// the event payload: {"event": "App\\Events\\ChatMessageEvent", "data": "<json string>"} (data may also
// arrive as an object; both are accepted). anything unrecognized or malformed is skipped, an unofficial
// protocol drifting must degrade to dropped messages, never a crash
fn chat_event_from(env: &Value) -> Option<KickEvent> {
    let event = env.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let data = env.get("data")?;
    let parsed;
    let m: &Value = match data.as_str() {
        Some(s) => {
            parsed = serde_json::from_str::<Value>(s).ok()?;
            &parsed
        }
        None => data,
    };
    match event {
        "App\\Events\\ChatMessageEvent" => {
            let username = m.pointer("/sender/username").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if username.is_empty() || content.is_empty() {
                return None;
            }
            Some(KickEvent::Message(Box::new(ChatMessageEvent {
                username,
                color: m
                    .pointer("/sender/identity/color")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                message: flatten_emote_tokens(content),
                // Kick badge identity, in the kick/-prefixed form renderBadges (chat-badges.js) tells apart from Twitch's set/version pairs
                badges: kick_badges_tag(m),
                bits: None,
                custom_reward_id: None,
                reply_parent_user: None,
                reply_parent_body: None,
                is_action: false,
                emotes_tag: None,
                msg_id: m.get("id").and_then(|v| v.as_str()).map(str::to_string),
                user_id: m.pointer("/sender/id").and_then(|v| v.as_u64()).map(|id| id.to_string()),
                is_first_msg: false,
                is_highlighted: false,
                reply_parent_msg_id: None,
                reply_thread_parent_msg_id: None,
            })))
        }
        // mod deletions, mapped onto the clearmsg path so deleted Kick messages disappear like Twitch ones
        "App\\Events\\MessageDeletedEvent" => m
            .pointer("/message/id")
            .and_then(|v| v.as_str())
            .map(|id| KickEvent::Deleted(id.to_string())),
        _ => None,
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
    use super::{chat_event_from, classify_line, flatten_emote_tokens, kick_badges_tag, token_from, ws_url_from, KickEvent, LineAction};
    use serde_json::json;

    // the exact shapes captured from kick.com on 10-16-26
    #[test]
    fn handshake_replies() {
        let conn = json!({"data":{"connections":[{"credentials":{"url":"wss://realtime.us-west-2.platform.kick.com/connection/websocket"},"provider":"centrifugo"}],"mode":"websocket"},"message":"success"});
        assert_eq!(ws_url_from(&conn).as_deref(), Some("wss://realtime.us-west-2.platform.kick.com/connection/websocket"));
        let tok = json!({"data":{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJndWVzdCJ9.sAH_WZjk68eokjw-qlQ"},"message":"success"});
        assert!(token_from(&tok).is_some());
    }

    #[test]
    fn ws_url_must_be_kick() {
        for bad in [
            "ws://realtime.kick.com/x", "wss://evil.com/kick.com", "wss://kick.com.evil.com/x",
            "wss://user@realtime.kick.com/x", "wss://realtime.kick.com:1/x", "https://realtime.kick.com/x", "wss://notkick.com/x",
        ] {
            let v = json!({"data":{"connections":[{"credentials":{"url":bad},"provider":"centrifugo"}]}});
            assert_eq!(ws_url_from(&v), None, "{bad}");
        }
        let pusher_only = json!({"data":{"connections":[{"credentials":{"url":"wss://realtime.kick.com/x"},"provider":"pusher"}]}});
        assert_eq!(ws_url_from(&pusher_only), None);
        assert_eq!(token_from(&json!({"data":{"token":"a b"}})), None);
        assert_eq!(token_from(&json!({"data":{"token":""}})), None);
    }

    #[test]
    fn protocol_lines() {
        assert_eq!(classify_line("{}").0, LineAction::Ping);
        assert_eq!(
            classify_line(r#"{"id":1,"connect":{"client":"x","version":"6.9.7 PRO","expires":true,"ttl":2699,"ping":25,"pong":true}}"#).0,
            LineAction::Connected { ping: Some(25), ttl: Some(2699) }
        );
        assert_eq!(classify_line(r#"{"id":2,"subscribe":{}}"#).0, LineAction::Subscribed);
        assert_eq!(classify_line(r#"{"id":5,"subscribe":{}}"#).0, LineAction::None);
        assert_eq!(classify_line(r#"{"id":3,"refresh":{"expires":true,"ttl":2699}}"#).0, LineAction::Refreshed { ttl: Some(2699) });
        assert_eq!(classify_line(r#"{"id":1,"error":{"code":109,"message":"token expired"}}"#).0, LineAction::Failed("109 token expired".into()));
        assert_eq!(classify_line(r#"{"push":{"disconnect":{"code":3005,"reason":"x"}}}"#).0, LineAction::Disconnect);
        assert_eq!(classify_line("not json").0, LineAction::None);
    }

    #[test]
    fn push_becomes_chat_message() {
        let line = r##"{"push":{"channel":"chatrooms.2393554.v2","pub":{"data":{"event":"App\\Events\\ChatMessageEvent","data":"{\"id\":\"5ac0820a\",\"chatroom_id\":2393554,\"content\":\"so fake [emote:493215:odablockCappp]\",\"type\":\"message\",\"sender\":{\"id\":42,\"username\":\"viewer1\",\"identity\":{\"color\":\"#FF9D00\",\"badges\":[{\"type\":\"subscriber\",\"text\":\"Subscriber\",\"count\":3}]}}}"}}}}"##;
        let (action, env) = classify_line(line);
        assert_eq!(action, LineAction::None);
        match chat_event_from(&env.unwrap()) {
            Some(KickEvent::Message(m)) => {
                assert_eq!(m.username, "viewer1");
                assert_eq!(m.message, "so fake \u{1}493215\u{1}odablockCappp\u{1}");
                assert_eq!(m.color.as_deref(), Some("#FF9D00"));
                assert_eq!(m.badges.as_deref(), Some("kick/subscriber/3"));
                assert_eq!(m.user_id.as_deref(), Some("42"));
                assert_eq!(m.msg_id.as_deref(), Some("5ac0820a"));
            }
            _ => panic!("expected a chat message"),
        }
        let del = json!({"event":"App\\Events\\MessageDeletedEvent","data":"{\"message\":{\"id\":\"abc\"}}"});
        assert!(matches!(chat_event_from(&del), Some(KickEvent::Deleted(id)) if id == "abc"));
    }

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

#[cfg(test)]
mod fuzz_tests {
    #[test]
    fn protocol_parsing_never_panics() {
        for s in crate::fuzz_support::strings(7, 20_000, 16) {
            let _ = super::classify_line(&s);
            let wrapped = serde_json::json!({"push":{"pub":{"data":{"event":"App\\Events\\ChatMessageEvent","data":s}}}}).to_string();
            if let (_, Some(env)) = super::classify_line(&wrapped) { let _ = super::chat_event_from(&env); }
            let _ = super::ws_url_from(&serde_json::json!({"data":{"connections":[{"provider":"centrifugo","credentials":{"url":s}}]}}));
        }
    }

    #[test]
    fn emote_flattening_never_panics() {
        for s in crate::fuzz_support::strings(2, 60_000, 24) {
            let _ = super::flatten_emote_tokens(&s);
            let _ = super::flatten_emote_tokens(&format!("[emote:{s}]"));
            let _ = super::flatten_emote_tokens(&format!("[emote:123:{s}]x[emote:{s}:{s}]"));
        }
    }
}
