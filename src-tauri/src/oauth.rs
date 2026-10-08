// Twitch OAuth, browser-based implicit grant (RFC 8252 native-app flow).
//
// a webview login popup doesn't work: the app CSP blocks Twitch's login CDNs, and the global
// prevent_close handler breaks the popup's close button. instead we open the auth URL in the system
// browser and catch the redirect on a local tokio server (127.0.0.1:17543). the token comes back in
// the URL #fragment (never sent to the server), so the server serves a one-shot bridge page whose JS
// reads the fragment and GETs /token?t=<token>&s=<state>; we then emit "oauth-token" to the main window
// and shut down. port 17543 must match the redirect URI registered at dev.twitch.tv
//
// the state value: every login attempt sends Twitch a fresh random `state`, Twitch hands it back in the
// fragment next to the token, and the local server only accepts a token that arrives with it. without
// that, any web page open in the browser while a login was pending could call /token itself and sign
// Mosaic into an account of its choosing

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const TOKEN_FILE: &str = "oauth_token.json";

#[derive(Serialize, Deserialize)]
struct PersistedToken {
    access_token: String,
}

pub fn save_token(app: &AppHandle, access_token: &str) {
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let path = dir.join(TOKEN_FILE);
    if let Ok(json) = serde_json::to_string(&PersistedToken {
        access_token: access_token.to_string(),
    }) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, json);
    }
}

pub fn load_token(app: &AppHandle) -> Option<String> {
    let dir = app.path().app_local_data_dir().ok()?;
    let json = std::fs::read_to_string(dir.join(TOKEN_FILE)).ok()?;
    let persisted: PersistedToken = serde_json::from_str(&json).ok()?;
    Some(persisted.access_token)
}

pub fn clear_token(app: &AppHandle) {
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = std::fs::remove_file(dir.join(TOKEN_FILE));
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

#[derive(Serialize, Clone)]
pub struct OAuthTokenEvent {
    pub access_token: String,
}

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

// opens the Twitch login page in the default browser and starts a local HTTP server to catch the OAuth redirect. on success it emits "oauth-token" to the main window and shuts down
#[tauri::command]
pub async fn start_oauth_login(app: AppHandle) -> Result<(), String> {
    // try to bind the port before opening the browser. if it's already in use a previous login attempt is still running, just open the URL again so the user can retry without restarting the app
    let listener = match TcpListener::bind(format!("127.0.0.1:{REDIRECT_PORT}")).await {
        Ok(l) => l,
        Err(_) => {
            // port busy: don't spawn a second server, open the login the running one is waiting for.
            // (no pending state means something else holds the port; the page still opens, as before)
            let state = pending_state().unwrap_or_else(new_state);
            open_browser(&app, &authorize_url(&state))?;
            return Ok(());
        }
    };

    let state = new_state();
    set_pending_state(Some(state.clone()));
    let auth_url = authorize_url(&state);

    // spawn the redirect-catcher; open the browser in parallel
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mine = state.clone();
        // 5-minute timeout in case the user abandons the flow
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(300),
            run_redirect_server(listener, state, move |token| {
                let _ = app2.emit("oauth-token", OAuthTokenEvent { access_token: token });
            }),
        )
        .await;
        // finished or abandoned: this state is spent (unless a newer attempt has already replaced it)
        if pending_state().as_deref() == Some(mine.as_str()) {
            set_pending_state(None);
        }
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

// bridge HTML served when the browser reaches http://localhost:17543. its JS reads location.hash
// (fragments aren't sent to the server, which is why the implicit grant needs this extra hop), pulls
// out the access_token and the state, and GETs /token?t=<token>&s=<state> so the server can pick it up. styled to match the app's dark theme
const BRIDGE_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Mosaic - Logging in</title>
  <style>
    body {
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #0e0e10;
      font-family: Inter, system-ui, sans-serif;
      color: #efeff1;
    }
    .card {
      text-align: center;
      padding: 40px;
      border-radius: 10px;
      background: #1f1f23;
      border: 1px solid #3a3a3d;
      max-width: 360px;
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p  { font-size: 14px; color: #adadb8; margin: 0; }
    .ok  { color: #00b341; }
    .err { color: #e91916; }
  </style>
</head>
<body>
<div class="card" id="card">
  <h1>Completing login…</h1>
  <p>One moment please.</p>
</div>
<script>
(function () {
  var hash = location.hash.substring(1);
  var params = new URLSearchParams(hash);
  var token = params.get('access_token');
  var state = params.get('state') || '';
  var card = document.getElementById('card');

  // the address of this page contains the login token: take it out of the address bar and the
  // browser history now that it has been read
  try { history.replaceState(null, '', location.pathname); } catch (e) {}

  function show(title, body, cls) {
    card.innerHTML =
      '<h1 class="' + cls + '">' + title + '</h1>' +
      '<p>' + body + '</p>';
  }

  if (!token) {
    show('Login cancelled', 'No token received. You can close this tab.', 'err');
    return;
  }

  fetch('/token?t=' + encodeURIComponent(token) + '&s=' + encodeURIComponent(state))
    .then(function (r) {
      if (r.ok) {
        show('Login successful!',
             'You can close this tab and return to Mosaic.', 'ok');
      } else if (r.status === 403) {
        show('This login wasn\'t started by Mosaic',
             'Close this tab and press Log in again in the app.', 'err');
      } else {
        show('Something went wrong', 'Please try logging in again.', 'err');
      }
    })
    .catch(function () {
      show('Something went wrong', 'Please try logging in again.', 'err');
    });
})();
</script>
</body>
</html>"#;

// serves the bridge page and waits for it to hand over the token. `expected_state` is what this login
// attempt sent to Twitch: a /token request without it is refused and the server keeps waiting for the
// real one. `on_token` runs once, with the accepted token, and then the server stops
async fn run_redirect_server<F: Fn(String)>(listener: TcpListener, expected_state: String, on_token: F) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => break,
        };

        // read enough of the request to identify it
        let mut buf = vec![0u8; 4096];
        let n = socket.read(&mut buf).await.unwrap_or(0);
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
                let body = BRIDGE_HTML.as_bytes();
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

#[tauri::command]
pub async fn validate_oauth_token(
    app: AppHandle,
    access_token: String,
) -> Result<serde_json::Value, String> {
    let body = reqwest_lite_get(
        "https://id.twitch.tv/oauth2/validate",
        &[("Authorization", &format!("OAuth {access_token}"))],
    )
    .await?;

    let parsed: ValidateResponse =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse validate response: {e}"))?;

    save_token(&app, &access_token);

    let missing = missing_scopes(&parsed.scopes);
    Ok(serde_json::json!({
        "login": parsed.login,
        "user_id": parsed.user_id,
        "missing_scopes": missing,
    }))
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
    clear_token(&app);
}

#[tauri::command]
pub async fn restore_session(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(token) = load_token(&app) else {
        return Ok(serde_json::Value::Null);
    };

    match reqwest_lite_get(
        "https://id.twitch.tv/oauth2/validate",
        &[("Authorization", &format!("OAuth {token}"))],
    )
    .await
    {
        Ok(body) => match serde_json::from_str::<ValidateResponse>(&body) {
            Ok(parsed) => Ok(serde_json::json!({
                "access_token": token,
                "login": parsed.login,
                "user_id": parsed.user_id,
                "missing_scopes": missing_scopes(&parsed.scopes),
            })),
            Err(e) => {
                clear_token(&app);
                Err(format!("Failed to parse validate response: {e}"))
            }
        },
        Err(_) => {
            clear_token(&app);
            Ok(serde_json::Value::Null)
        }
    }
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
