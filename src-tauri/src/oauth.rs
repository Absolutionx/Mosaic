// Twitch OAuth, browser-based implicit grant (RFC 8252 native-app flow).
//
// a webview login popup doesn't work: the app CSP blocks Twitch's login CDNs, and the global
// prevent_close handler breaks the popup's close button. instead we open the auth URL in the system
// browser and catch the redirect on a local tokio server (127.0.0.1:17543). the token comes back in
// the URL #fragment (never sent to the server), so the server serves a one-shot bridge page whose JS
// reads the fragment and GETs /token?t=<token>&s=<state>; Rust then validates and keeps the token (the page
// never sees it) and emits "oauth-login" with who logged in
// and shut down. port 17543 must match the redirect URI registered at dev.twitch.tv
//
// the state value: every login attempt sends Twitch a fresh random `state`, Twitch hands it back in the
// fragment next to the token, and the local server only accepts a token that arrives with it. without
// that, any web page open in the browser while a login was pending could call /token itself and sign
// Mosaic into an account of its choosing

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const TOKEN_FILE: &str = "oauth_token.json";

#[derive(Serialize, Deserialize, Default, Clone)]
struct PersistedToken {
    access_token: String,
    // only logins made with a code (device_login, Android) have these: they last about 4 hours and are
    // renewed with the refresh token. a browser login's token lasts about 60 days and has neither
    #[serde(default, skip_serializing_if = "String::is_empty")]
    refresh_token: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    expires_at: i64, // unix seconds
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

fn save_persisted(app: &AppHandle, t: &PersistedToken) {
    if let Ok(json) = serde_json::to_string(t) {
        let _ = crate::secret_store::save(app, TOKEN_FILE, &json);
    }
}

fn load_persisted(app: &AppHandle) -> Option<PersistedToken> {
    let json = crate::secret_store::load(app, TOKEN_FILE)?;
    serde_json::from_str(&json).ok()
}

// stored via secret_store: Windows Credential Manager on Windows, a file elsewhere
pub fn save_token(app: &AppHandle, access_token: &str) {
    save_persisted(app, &PersistedToken { access_token: access_token.to_string(), ..Default::default() });
}


pub fn clear_token(app: &AppHandle) {
    crate::secret_store::delete(app, TOKEN_FILE);
}

// this app's Client-ID, registered at dev.twitch.tv. OAuth client IDs (unlike client secrets) are
// public identifiers by design in the native-app/implicit flow used here, there is no client secret
// anywhere in this codebase, on purpose, since one embedded in a distributed binary couldn't stay
// secret. safe in source control; see the flow description above
pub const CLIENT_ID: &str = "i2tkeryeipoljcoh8sjtxtcfd43guv";
const REDIRECT_URI: &str = "http://localhost:17543";
const REDIRECT_PORT: &str = "17543";

// The OAuth scopes the app requests at login. This is the single source of truth: start_oauth_login
// requests exactly these, and the frontend compares a token's granted scopes against these to decide
// whether a re-login is needed (an older token, from before a scope was added, will be missing some).
// Add new scopes HERE when a feature needs them, and existing users will be prompted to re-login.
pub const REQUIRED_SCOPES: &[&str] = &[
    "chat:read",
    "chat:edit",
    "channel:read:redemptions",
    "user:read:follows",
    "moderator:manage:banned_users",
    "moderator:manage:chat_messages",
    "moderator:manage:automod",
    "moderator:read:chatters",
    "clips:edit",
    "moderator:read:blocked_terms",
    "moderator:read:chat_settings",
    "moderator:manage:chat_settings",
    "user:read:whispers",
    "user:manage:whispers",
    "moderator:read:unban_requests",
    "moderator:read:warnings",
    "moderator:read:moderators",
    "moderator:read:vips",
];


#[derive(Deserialize, Debug)]
struct ValidateResponse {
    login: String,
    user_id: String,
    #[serde(default)]
    scopes: Vec<String>,
}

// the state of the login attempt that is waiting for its redirect, if any. kept here (not only inside the
// server task) so that pressing Log in again while the first attempt is still pending opens the same
// login: either browser tab then completes it
static PENDING_STATE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

// true while OUR redirect server holds the port. if the port is busy and this is false, some other program
// has it, and opening the login would hand that program the token (Twitch redirects it there), so the
// login is refused with an explanation instead
static SERVER_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn pending_state() -> Option<String> {
    PENDING_STATE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_pending_state(v: Option<String>) {
    *PENDING_STATE.lock().unwrap_or_else(|e| e.into_inner()) = v;
}

// 122 random bits from the OS, as 32 hex characters (nothing in it needs URL-encoding)
fn new_state() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn authorize_url(state: &str) -> String {
    format!(
        "https://id.twitch.tv/oauth2/authorize\
         ?response_type=token\
         &client_id={}\
         &redirect_uri={}\
         &scope={}\
         &state={}",
        CLIENT_ID,
        urlencoding_lite(REDIRECT_URI),
        urlencoding_lite(&REQUIRED_SCOPES.join(" ")),
        urlencoding_lite(state),
    )
}

// opens the Twitch login page in the default browser and starts a local HTTP server to catch the OAuth redirect. on success it emits "oauth-login" (login, user id; never the token) and shuts down
#[tauri::command]
pub async fn start_oauth_login(app: AppHandle) -> Result<(), String> {
    // try to bind the port before opening the browser. if it's already in use a previous login attempt is still running, just open the URL again so the user can retry without restarting the app
    let listener = match TcpListener::bind(format!("127.0.0.1:{REDIRECT_PORT}")).await {
        Ok(l) => l,
        Err(_) => {
            // port busy. ours (an earlier attempt still waiting): open the login it's waiting for. anyone else's:
            // stop, Twitch would deliver the token to that program
            match pending_state().filter(|_| SERVER_RUNNING.load(std::sync::atomic::Ordering::SeqCst)) {
                Some(state) => {
                    open_browser(&app, &authorize_url(&state))?;
                    return Ok(());
                }
                None => return Err(format!(
                    "Another program is using port {REDIRECT_PORT}, which Mosaic's Twitch login needs. Close it and try again."
                )),
            }
        }
    };
    // the redirect says "localhost", which a browser may reach over IPv6 ([::1]) first. listen there too, so
    // the token can't land at another program sitting on [::1]:17543 while Mosaic waits on 127.0.0.1 only.
    // that address taken by someone else: stop, like a busy 127.0.0.1 above. no IPv6 on this computer: fine
    let listener_v6 = match TcpListener::bind(format!("[::1]:{REDIRECT_PORT}")).await {
        Ok(l) => Some(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(format!(
                "Another program is using port {REDIRECT_PORT}, which Mosaic's Twitch login needs. Close it and try again."
            ));
        }
        Err(_) => None,
    };
    SERVER_RUNNING.store(true, std::sync::atomic::Ordering::SeqCst);

    let state = new_state();
    set_pending_state(Some(state.clone()));
    let auth_url = authorize_url(&state);

    // spawn the redirect-catcher; open the browser in parallel
    let app2 = app.clone();
    let app_timeout = app.clone();
    tauri::async_runtime::spawn(async move {
        let mine = state.clone();
        // 5-minute timeout in case the user abandons the flow
        let finished = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            run_redirect_server(listener, listener_v6, state, move |token| {
                // the token stays in Rust: validated, stored and handed to chat here; the page only hears
                // who logged in ("oauth-login"), or that it failed ("oauth-login-failed")
                let app3 = app2.clone();
                tauri::async_runtime::spawn(async move {
                    match accept_token(&app3, token).await {
                        Ok(info) => { let _ = app3.emit("oauth-login", info); }
                        Err(e) => { let _ = app3.emit("oauth-login-failed", e); }
                    }
                });
            }),
        )
        .await;
        // abandoned (no login within 5 minutes): tell the page, so the button stops saying "Logging in…"
        if finished.is_err() {
            let _ = app_timeout.emit("oauth-login-failed", "login timed out");
        }
        // finished or abandoned: this state is spent (unless a newer attempt has already replaced it)
        if pending_state().as_deref() == Some(mine.as_str()) {
            set_pending_state(None);
        }
        SERVER_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    });

    open_browser(&app, &auth_url)?;
    Ok(())
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))
}

// bridge page served when the browser reaches http://localhost:17543. its JS reads location.hash
// (fragments aren't sent to the server, which is why the implicit grant needs this extra hop), pulls
// out the access_token and the state, and GETs /token?t=<token>&s=<state> so the server can pick it up.
// the look is login_page.html, shared with Kick's login
fn bridge_html() -> String {
    use crate::login_page::{render, State, CLOSE_HINT, ICON_ERR, ICON_OK};
    let js = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    let script = format!(
        r#"<script>
(function () {{
  var ICONS = {{ ok: {ok}, err: {err} }};
  var HINT = {hint};
  var params = new URLSearchParams(location.hash.substring(1));
  var token = params.get('access_token');
  var state = params.get('state') || '';

  // the address of this page contains the login token: take it out of the address bar and the
  // browser history now that it has been read
  try {{ history.replaceState(null, '', location.pathname); }} catch (e) {{}}

  function show(cls, title, body) {{
    document.getElementById('card').className = 'card ' + cls;
    document.getElementById('status').innerHTML = ICONS[cls];
    document.getElementById('title').textContent = title;
    document.getElementById('body').textContent = body;
    document.getElementById('foot').innerHTML = HINT;
    document.title = (cls === 'ok' ? 'Signed in' : "Sign-in didn't finish") + ' - Mosaic';
  }}

  if (!token) {{
    show('err', 'Sign-in was canceled', "Twitch didn't send a sign-in. Go back to Mosaic and press Log in again.");
    return;
  }}

  fetch('/token?t=' + encodeURIComponent(token) + '&s=' + encodeURIComponent(state))
    .then(function (r) {{
      if (r.ok) {{
        show('ok', "You're signed in", 'Mosaic is now connected to your Twitch account.');
      }} else if (r.status === 403) {{
        show('err', "This sign-in wasn't started by Mosaic", 'Close this tab and press Log in again in Mosaic.');
      }} else {{
        show('err', 'Something went wrong', 'Go back to Mosaic and try logging in again.');
      }}
    }})
    .catch(function () {{
      show('err', 'Something went wrong', 'Go back to Mosaic and try logging in again.');
    }});
}})();
</script>"#,
        ok = js(ICON_OK),
        err = js(ICON_ERR),
        hint = js(CLOSE_HINT),
    );
    render(State::Wait, "Finishing sign-in", "One moment, connecting Mosaic to your Twitch account.", &script)
}

// serves the bridge page and waits for it to hand over the token. `expected_state` is what this login
// attempt sent to Twitch: a /token request without it is refused and the server keeps waiting for the
// real one. `on_token` runs once, with the accepted token, and then the server stops
async fn run_redirect_server<F: Fn(String)>(
    listener: TcpListener,
    listener_v6: Option<TcpListener>,
    expected_state: String,
    on_token: F,
) {
    loop {
        // whichever address the browser came in on (127.0.0.1, or [::1] when there is one)
        let accepted = tokio::select! {
            r = listener.accept() => r,
            r = async {
                match &listener_v6 {
                    Some(l) => l.accept().await,
                    None => std::future::pending().await,
                }
            } => r,
        };
        let (mut socket, _) = match accepted {
            Ok(s) => s,
            Err(_) => break,
        };

        // read enough of the request to identify it. bounded in time: connections are handled one at a time,
        // so one that never sends anything must not hold up the browser's real redirect
        let mut buf = vec![0u8; 4096];
        let n = match tokio::time::timeout(std::time::Duration::from_secs(5), socket.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => 0,
        };
        if n == 0 {
            continue;
        }
        let request = String::from_utf8_lossy(&buf[..n]);
        let first_line = request.lines().next().unwrap_or("");

        if first_line.starts_with("GET /token?") {
            // the bridge page handing us the token, or some other page pretending to be it
            let token = query_param(first_line, "t").filter(|t| !t.is_empty());
            let state_ok = query_param(first_line, "s").as_deref() == Some(expected_state.as_str());
            match token {
                Some(token) if state_ok => {
                    on_token(token);
                    let resp = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
                    let _ = socket.write_all(resp).await;
                    break; // done, shut down the server
                }
                _ => {
                    let resp = b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nForbidden";
                    let _ = socket.write_all(resp).await;
                }
            }
        } else if first_line.starts_with("GET /") {
            // probably the initial Twitch redirect, serve the bridge page (ignore favicon.ico, etc.)
            if !first_line.contains("favicon") {
                let page = bridge_html();
                let body = page.as_bytes();
                let header = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: text/html; charset=utf-8\r\n\
                     Cache-Control: no-store\r\n\
                     Content-Length: {}\r\n\
                     Connection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(body).await;
            }
        }
        // any other request (favicon, etc.) just drops the connection
    }
}

// one query parameter from a GET request line like `GET /token?t=abc123&s=... HTTP/1.1`, percent-decoded
fn query_param(line: &str, name: &str) -> Option<String> {
    let path = line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    query.split('&').find_map(|param| {
        let (k, v) = param.split_once('=')?;
        (k == name).then(|| url_decode(v))
    })
}

// percent-decodes a URL-encoded string (the token passed from the bridge)
fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn urlencoding_lite(input: &str) -> String {
    input
        .replace(' ', "%20")
        .replace(':', "%3A")
        .replace('/', "%2F")
}

// validates a token from the login redirect, stores it and makes it the session's (chat, Helix). returns
// what the page may know: login, user id and missing scopes, never the token
async fn accept_token(app: &AppHandle, access_token: String) -> Result<serde_json::Value, String> {
    let body = reqwest_lite_get(
        "https://id.twitch.tv/oauth2/validate",
        &[("Authorization", &format!("OAuth {access_token}"))],
    )
    .await?;
    let parsed: ValidateResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse validate response: {e}"))?;
    save_token(app, &access_token);
    stop_refreshing();
    set_session(app, Some((access_token, &parsed)));
    Ok(session_info(&parsed))
}

fn session_info(parsed: &ValidateResponse) -> serde_json::Value {
    serde_json::json!({
        "login": parsed.login,
        "user_id": parsed.user_id,
        "missing_scopes": missing_scopes(&parsed.scopes),
    })
}

// the in-memory credentials chat and the Helix commands use (None = logged out)
fn set_session(app: &AppHandle, session: Option<(String, &ValidateResponse)>) {
    use tauri::Manager;
    let state = app.state::<crate::ChatState>();
    if let Ok(mut guard) = state.auth.lock() {
        *guard = session.map(|(access_token, v)| crate::chat::AuthCredentials {
            access_token,
            login: v.login.clone(),
            user_id: v.user_id.clone(),
        });
    };
}

// Which required scopes this token is missing (empty = all present). Used by the frontend to decide
// whether to prompt a re-login after a new feature added a scope.
fn missing_scopes(granted: &[String]) -> Vec<String> {
    REQUIRED_SCOPES
        .iter()
        .filter(|req| !granted.iter().any(|g| g == *req))
        .map(|s| s.to_string())
        .collect()
}

#[tauri::command]
pub fn logout(app: AppHandle) {
    stop_refreshing();
    clear_token(&app);
    set_session(&app, None);
}

#[tauri::command]
pub async fn restore_session(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(mut saved) = load_persisted(&app) else {
        return Ok(serde_json::Value::Null);
    };
    // a code login that has run out (or nearly) is renewed first. offline: carry on and try the old one
    if !saved.refresh_token.is_empty() && saved.expires_at > 0 && now_secs() > saved.expires_at - 120 {
        if let Ok(Some(t)) = refresh_now(&app).await {
            saved = t;
        }
    }
    let mut token = saved.access_token.clone();
    let mut refreshed_after_401 = false;
    // only Twitch saying the token is no good (401) logs you out. starting Mosaic offline, or while Twitch's
    // login service has a hiccup, used to delete the saved login too, so you had to log in again afterwards.
    // a few tries a few seconds apart (Wi-Fi coming up after a cold boot), then the token is kept for next time
    let mut last_err = String::new();
    for wait in [0u64, 2, 5] {
        if wait > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
        }
        let resp = crate::http::client()
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {token}"))
            .timeout(std::time::Duration::from_secs(6))
            .send()
            .await;
        let resp = match resp {
            Ok(r) => r,
            Err(e) => { last_err = e.to_string(); continue; }
        };
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::BAD_REQUEST {
            // a code login's token ran out: renew it once and check the new one
            if !saved.refresh_token.is_empty() && !refreshed_after_401 {
                refreshed_after_401 = true;
                if let Ok(Some(t)) = refresh_now(&app).await {
                    token = t.access_token.clone();
                    saved = t;
                    continue;
                }
            }
            // expired or revoked: this one is done
            clear_token(&app);
            return Ok(serde_json::Value::Null);
        }
        if !status.is_success() {
            last_err = format!("Twitch answered {status}");
            continue;
        }
        let body = resp.text().await.map_err(|e| e.to_string())?;
        return match serde_json::from_str::<ValidateResponse>(&body) {
            Ok(parsed) => {
                set_session(&app, Some((token, &parsed)));
                if !saved.refresh_token.is_empty() {
                    keep_refreshing(app.clone());
                }
                Ok(session_info(&parsed))
            }
            Err(e) => Err(format!("Failed to parse validate response: {e}")),
        };
    }
    Err(format!("Couldn't reach Twitch to restore your login ({last_err}); it's kept for next time"))
}

// ---- logging in with a code (Android) ----
// On a phone the browser login above can't finish: while the browser is in front Android freezes Mosaic, so
// nothing answers at localhost and the login times out. Instead Mosaic shows a code, you enter it at
// twitch.tv/activate (or open the link, which fills it in), and Mosaic asks Twitch every few seconds whether
// it was approved. Twitch treats Mosaic as a public app, so this works without a client secret (checked
// 10-28-26: its token endpoint answers "authorization_pending" for Mosaic's id). These tokens last about 4
// hours and come with a refresh token, which keep_refreshing uses to renew them before they run out.

const DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";

// the code login waiting to be approved. the device code stays here; the page only gets the short user code
static DEVICE_PENDING: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

#[derive(Serialize)]
pub struct DeviceLoginInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

fn twitch_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string())
}

#[tauri::command]
pub async fn start_device_login() -> Result<DeviceLoginInfo, String> {
    let scopes = REQUIRED_SCOPES.join(" ");
    let resp = crate::http::client()
        .post(DEVICE_URL)
        .form(&[("client_id", CLIENT_ID), ("scopes", scopes.as_str())])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Twitch: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Twitch didn't start the login: {}", twitch_message(&body)));
    }
    let d: DeviceCodeResponse = serde_json::from_str(&body).map_err(|e| format!("Twitch sent an answer Mosaic couldn't read: {e}"))?;
    *DEVICE_PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(d.device_code);
    Ok(DeviceLoginInfo {
        user_code: d.user_code,
        verification_uri: d.verification_uri,
        interval: d.interval.max(1),
        expires_in: d.expires_in,
    })
}

/// one check: Ok(None) while it waits for approval, Ok(Some(who logged in)) once approved. the page calls it
/// every few seconds (a frozen app just checks again when it comes back)
#[tauri::command]
pub async fn poll_device_login(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let device_code = DEVICE_PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("This login code is no longer active. Start again.")?;
    let scopes = REQUIRED_SCOPES.join(" ");
    let resp = crate::http::client()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("scopes", scopes.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    // no network for a moment (the phone switching networks): keep waiting
    let Ok(resp) = resp else { return Ok(None) };
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let t: TokenResponse = serde_json::from_str(&body).map_err(|e| format!("Twitch sent an answer Mosaic couldn't read: {e}"))?;
        *DEVICE_PENDING.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let info = accept_refreshable(&app, t).await?;
        return Ok(Some(info));
    }
    let msg = twitch_message(&body);
    match msg.as_str() {
        "authorization_pending" | "slow_down" => Ok(None),
        _ => {
            *DEVICE_PENDING.lock().unwrap_or_else(|e| e.into_inner()) = None;
            Err(if msg.contains("expired") || msg.contains("invalid device code") {
                "The code expired. Start again for a new one.".into()
            } else if msg.contains("denied") {
                "The login was declined on Twitch.".into()
            } else {
                format!("Twitch didn't finish the login: {msg}")
            })
        }
    }
}

#[tauri::command]
pub fn cancel_device_login() {
    *DEVICE_PENDING.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

// a token with a refresh token: validated, saved, made the session's, and kept renewed
async fn accept_refreshable(app: &AppHandle, t: TokenResponse) -> Result<serde_json::Value, String> {
    let body = reqwest_lite_get(
        "https://id.twitch.tv/oauth2/validate",
        &[("Authorization", &format!("OAuth {}", t.access_token))],
    )
    .await?;
    let parsed: ValidateResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse validate response: {e}"))?;
    save_persisted(app, &PersistedToken {
        access_token: t.access_token.clone(),
        refresh_token: t.refresh_token.unwrap_or_default(),
        expires_at: t.expires_in.map(|s| now_secs() + s).unwrap_or(0),
    });
    set_session(app, Some((t.access_token, &parsed)));
    keep_refreshing(app.clone());
    Ok(session_info(&parsed))
}

// renews the saved code login. Ok(Some(new)) renewed, Ok(None) Twitch refused it for good (logged out),
// Err could not ask (offline)
async fn refresh_now(app: &AppHandle) -> Result<Option<PersistedToken>, String> {
    let Some(saved) = load_persisted(app) else { return Ok(None) };
    if saved.refresh_token.is_empty() {
        return Ok(None);
    }
    let resp = crate::http::client()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", saved.refresh_token.as_str()),
        ])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("Twitch answered {status}"));
    }
    let t: TokenResponse = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let new = PersistedToken {
        access_token: t.access_token.clone(),
        // Twitch may hand back a new refresh token; keep the old one if it doesn't
        refresh_token: t.refresh_token.filter(|r| !r.is_empty()).unwrap_or(saved.refresh_token),
        expires_at: t.expires_in.map(|s| now_secs() + s).unwrap_or(0),
    };
    save_persisted(app, &new);
    // chat and Helix read the token from the session on each use, so swapping it here is enough
    use tauri::Manager;
    let state = app.state::<crate::ChatState>();
    if let Ok(mut guard) = state.auth.lock() {
        if let Some(creds) = guard.as_mut() {
            creds.access_token = t.access_token;
        }
    };
    Ok(Some(new))
}

// one renewing task at a time: each start (and logout, and a browser login) moves the generation on, and an
// older task sees that and stops
static REFRESH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn stop_refreshing() {
    REFRESH_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

// checks once a minute against the wall clock (a phone's sleep doesn't count toward tokio's timers) and renews
// the code login about 10 minutes before it runs out. if Twitch refuses the refresh token, the login is over:
// the page hears "oauth-expired" and shows Log in again
fn keep_refreshing(app: AppHandle) {
    use std::sync::atomic::Ordering;
    let gen = REFRESH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            if REFRESH_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            let Some(saved) = load_persisted(&app) else { return };
            if saved.refresh_token.is_empty() {
                return;
            }
            if saved.expires_at > 0 && now_secs() < saved.expires_at - 600 {
                continue;
            }
            match refresh_now(&app).await {
                Ok(Some(_)) => {}
                Ok(None) => {
                    if REFRESH_GEN.load(Ordering::SeqCst) == gen {
                        clear_token(&app);
                        set_session(&app, None);
                        let _ = app.emit("oauth-expired", ());
                    }
                    return;
                }
                Err(_) => {} // offline: try again next minute
            }
        }
    });
}

async fn reqwest_lite_get(url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
    let client = crate::http::client();
    let mut request = client.get(url);
    for (key, value) in headers {
        request = request.header(*key, *value);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod fuzz_tests {
    #[test]
    fn redirect_parsing_never_panics() {
        for s in crate::fuzz_support::strings(6, 60_000, 24) {
            let _ = super::url_decode(&s);
            let _ = super::query_param(&s, "t");
            let _ = super::query_param(&format!("GET /token?{s} HTTP/1.1"), "s");
        }
    }
}

#[cfg(test)]
mod redirect_server_tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    async fn get(addr: std::net::SocketAddr, path: &str) -> String {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
        out
    }

    // a silent connection can't block the real redirect; a forged token (wrong or missing state) is
    // refused and the server keeps waiting; the real one is accepted exactly once
    #[tokio::test]
    async fn redirect_server_resists_silence_and_forgery() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let got2 = got.clone();
        let server = tokio::spawn(super::run_redirect_server(listener, None, "STATE123".into(), move |t| got2.lock().unwrap().push(t)));

        let _silent = TcpStream::connect(addr).await.unwrap(); // connects, never sends
        let t0 = std::time::Instant::now();
        let forged = get(addr, "/token?t=evil&s=WRONG").await;
        assert!(forged.starts_with("HTTP/1.1 403"), "{forged}");
        assert!(t0.elapsed() < std::time::Duration::from_secs(7), "silent connection held the server {:?}", t0.elapsed());
        assert!(get(addr, "/token?t=evil").await.starts_with("HTTP/1.1 403"));
        assert!(get(addr, "/").await.contains("Finishing sign-in"));
        assert!(get(addr, "/token?t=real%2Btoken&s=STATE123").await.starts_with("HTTP/1.1 200"));
        tokio::time::timeout(std::time::Duration::from_secs(2), server).await.expect("server should stop after the real token").unwrap();
        assert_eq!(*got.lock().unwrap(), vec!["real+token".to_string()]);
    }
}
