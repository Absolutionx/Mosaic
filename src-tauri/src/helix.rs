// Twitch Helix REST API, proxied through Rust because api.twitch.tv fails inside WebView2. token
// comes from ChatState (where OAuth parks it); commands that require login go through require_auth(),
// the rest send whatever token is available and let the JS side handle a 401

use tauri::State;

use crate::oauth;
use crate::ChatState;

// shared HTTP fetch for both badge endpoints. always attaches Client-ID, and Authorization when a token is available
pub(crate) async fn helix_get(url: &str, access_token: Option<String>) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut req = client
        .get(url)
        .header("Client-ID", oauth::CLIENT_ID);
    if let Some(token) = access_token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let response = req.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}

pub(crate) fn require_auth(state: &State<'_, ChatState>) -> Result<(String, String), String> {
    let guard = state.auth.lock().map_err(|e| e.to_string())?;
    let creds = guard
        .as_ref()
        .ok_or_else(|| "Not logged in".to_string())?;
    Ok((creds.access_token.clone(), creds.user_id.clone()))
}

// every followed channel for the logged-in user, paging through /helix/channels/followed until the cursor runs out
#[tauri::command]
pub async fn get_followed_channels(state: State<'_, ChatState>) -> Result<String, String> {
    let (token, user_id) = require_auth(&state)?;

    let mut all = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        let url = match &cursor {
            Some(c) => format!(
                "https://api.twitch.tv/helix/channels/followed?user_id={user_id}&first=100&after={c}"
            ),
            None => format!(
                "https://api.twitch.tv/helix/channels/followed?user_id={user_id}&first=100"
            ),
        };
        let body = helix_get(&url, Some(token.clone())).await?;
        let parsed: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;

        if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
            all.extend(data.clone());
        }

        cursor = parsed
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
            .map(|c| c.to_string());

        if cursor.is_none() {
            break;
        }
    }

    serde_json::to_string(&all).map_err(|e| e.to_string())
}

// given broadcaster IDs, returns the subset currently live (with viewer_count/game_name/title/etc) via /helix/streams, chunked at 100 user_id params per request (Helix's max)
#[tauri::command]
pub async fn get_streams_for_users(
    state: State<'_, ChatState>,
    broadcaster_ids: Vec<String>,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;

    let fetches = broadcaster_ids
        .chunks(100)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            let token = token.clone();
            let params = chunk
                .iter()
                .map(|id| format!("user_id={id}"))
                .collect::<Vec<_>>()
                .join("&");
            async move {
                let url = format!("https://api.twitch.tv/helix/streams?{params}&first=100");
                let body = helix_get(&url, Some(token)).await?;
                let parsed: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|e| format!("Bad JSON from Helix: {e}"))?;
                Ok::<Vec<serde_json::Value>, String>(
                    parsed
                        .get("data")
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default(),
                )
            }
        });

    let chunked_results = futures_util::future::try_join_all(fetches).await?;
    let all: Vec<serde_json::Value> = chunked_results.into_iter().flatten().collect();

    serde_json::to_string(&all).map_err(|e| e.to_string())
}

// looks up the live-stream record (if any) for a single channel login via /helix/streams?user_login=,
// used by the manual "Watch" button, which (unlike the sidebar/home feed/browse page) starts with only
// a typed name and no stream object, so it has no tags array for the drops banner without a fresh
// lookup. returns "null" (not an error) if the channel isn't live, a normal case
#[tauri::command]
pub async fn get_stream_for_login(
    state: State<'_, ChatState>,
    login: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;
    let url = format!(
        "https://api.twitch.tv/helix/streams?user_login={}",
        urlencoding_encode(&login)
    );
    let body = helix_get(&url, Some(token)).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let first = parsed
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::to_string(&first).map_err(|e| e.to_string())
}

// single user lookup by login, used when a channel is offline and we have no stream object (hence no user_id) for get_users_info. returns the first user from /helix/users?login=, or an error if the request fails or the login isn't found
#[tauri::command]
pub async fn get_user_by_login(
    state: State<'_, ChatState>,
    login: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;
    let url = format!(
        "https://api.twitch.tv/helix/users?login={}",
        urlencoding_encode(&login)
    );
    let body = helix_get(&url, Some(token)).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let user = parsed
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    serde_json::to_string(&user).map_err(|e| e.to_string())
}

// batched profile lookup (avatars + display names) via /helix/users, chunked at 100 ids/request
#[tauri::command]
pub async fn get_users_info(
    state: State<'_, ChatState>,
    user_ids: Vec<String>,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;

    let fetches = user_ids
        .chunks(100)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            let token = token.clone();
            let params = chunk
                .iter()
                .map(|id| format!("id={id}"))
                .collect::<Vec<_>>()
                .join("&");
            async move {
                let url = format!("https://api.twitch.tv/helix/users?{params}");
                let body = helix_get(&url, Some(token)).await?;
                let parsed: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|e| format!("Bad JSON from Helix: {e}"))?;
                Ok::<Vec<serde_json::Value>, String>(
                    parsed
                        .get("data")
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default(),
                )
            }
        });

    let chunked_results = futures_util::future::try_join_all(fetches).await?;
    let all: Vec<serde_json::Value> = chunked_results.into_iter().flatten().collect();

    serde_json::to_string(&all).map_err(|e| e.to_string())
}

// fetches a channel's past broadcasts (VODs) from /helix/videos. resolves login -> user_id first (one extra Helix call) so the frontend passes only the login it already knows
#[tauri::command]
pub async fn get_videos_for_login(
    state: State<'_, ChatState>,
    login: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;

    // resolve login -> user_id via /helix/users
    let users_url = format!(
        "https://api.twitch.tv/helix/users?login={}",
        urlencoding_encode(&login)
    );
    let users_body = helix_get(&users_url, Some(token.clone())).await?;
    let users_json: serde_json::Value =
        serde_json::from_str(&users_body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let user_id = users_json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|u| u.get("id"))
        .and_then(|id| id.as_str())
        .ok_or_else(|| format!("No user found for login: {login}"))?
        .to_string();

    // fetch VODs for that user_id (archives only, most recent 20)
    let vods_url = format!(
        "https://api.twitch.tv/helix/videos?user_id={}&type=archive&first=20",
        user_id
    );
    let vods_body = helix_get(&vods_url, Some(token)).await?;
    let vods_json: serde_json::Value =
        serde_json::from_str(&vods_body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let data = vods_json
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    serde_json::to_string(&data).map_err(|e| e.to_string())
}

// fetches the muted (DMCA/copyright) segment ranges for one VOD via /helix/videos?id=. each segment
// is {duration, offset} in seconds, Twitch mutes the audio (not video) for that range rather than
// removing the VOD. per a confirmed Twitch bug (twitchdev/issues#501), muted_segments is only
// populated with a USER access token, an app token gets null even for VODs that visibly have muted
// segments; require_auth only succeeds with a real user token, so this avoids that trap naturally.
// still returns an empty list (not an error) if the caller isn't logged in
#[tauri::command]
pub async fn get_vod_muted_segments(
    state: State<'_, ChatState>,
    video_id: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;

    let url = format!("https://api.twitch.tv/helix/videos?id={}", video_id);
    let body = helix_get(&url, Some(token)).await?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;

    let segments = json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
        .and_then(|video| video.get("muted_segments"))
        .cloned()
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| serde_json::json!([]));

    serde_json::to_string(&segments).map_err(|e| e.to_string())
}

// returns the id and creation timestamp of the currently-recording VOD for a live channel, enabling
// live-DVR: seeking past the MSE relay's buffer by switching to HLS.js on the in-progress VOD. Twitch
// creates the VOD at stream start; it appears in /helix/videos as the most recent archive,
// distinguished from finished VODs by its thumbnail_url still containing the "%{width}x%{height}"
// template placeholder rather than a resolved URL. errors if the channel has no live VOD (VODs disabled, not live, or not created yet)
#[tauri::command]
pub async fn get_live_vod_info(
    state: State<'_, ChatState>,
    login: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;

    // resolve login -> user_id
    let users_url = format!(
        "https://api.twitch.tv/helix/users?login={}",
        urlencoding_encode(&login)
    );
    let users_body = helix_get(&users_url, Some(token.clone())).await?;
    let users_json: serde_json::Value =
        serde_json::from_str(&users_body).map_err(|e| format!("Bad JSON: {e}"))?;
    let user_id = users_json
        .get("data").and_then(|d| d.as_array()).and_then(|a| a.first())
        .and_then(|u| u.get("id")).and_then(|id| id.as_str())
        .ok_or_else(|| format!("No user found for login: {login}"))?
        .to_string();

    // fetch the most recent archive VOD, the in-progress one is always first
    let vods_url = format!(
        "https://api.twitch.tv/helix/videos?user_id={}&type=archive&first=1",
        user_id
    );
    let vods_body = helix_get(&vods_url, Some(token)).await?;
    let vods_json: serde_json::Value =
        serde_json::from_str(&vods_body).map_err(|e| format!("Bad JSON: {e}"))?;

    let video = vods_json
        .get("data").and_then(|d| d.as_array()).and_then(|a| a.first())
        .ok_or_else(|| "No VOD found - channel may have VODs disabled or not be live".to_string())?;

    // a currently-recording VOD has a template thumbnail URL, not a real one, which distinguishes it from a finished stream's VOD that happens to be the most recent archive
    let thumb = video.get("thumbnail_url").and_then(|t| t.as_str()).unwrap_or("");
    if !thumb.contains("%{width}") {
        return Err("Most recent VOD is not currently recording (stream may be offline or VODs disabled)".to_string());
    }

    let video_id = video.get("id").and_then(|v| v.as_str())
        .ok_or("VOD has no id")?;
    let created_at = video.get("created_at").and_then(|v| v.as_str())
        .ok_or("VOD has no created_at")?;

    Ok(serde_json::json!({
        "video_id": video_id,
        "created_at": created_at
    }).to_string())
}

// fetches a page of VOD chat replay from the (deprecated but still functional) Kraken v5 comments
// endpoint. returns the raw JSON so JS can render messages at the right timestamps. cursor is the
// pagination token from the previous call (empty for the first page); offset_seconds is where in the VOD to start (ignored after the first page, the cursor takes over)
#[tauri::command]
pub async fn get_vod_chat(
    _state: State<'_, ChatState>,
    video_id: String,
    offset_seconds: f64,
    cursor: String,
) -> Result<String, String> {
    // Twitch's Kraken v5 API was shut down in Feb 2023. VOD chat is now only available via Twitch's
    // internal GQL endpoint. we use the same public Client-ID the twitch.tv web app uses, with the
    // VideoCommentsByOffsetOrCursor persisted query that's been stable since mid-2021. no user token
    // needed for public VODs. GQL persisted query hash for VideoCommentsByOffsetOrCursor:
    const GQL_URL: &str = "https://gql.twitch.tv/gql";
    const GQL_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
    const QUERY_HASH: &str =
        "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";

    let body = if cursor.is_empty() {
        serde_json::json!([{
            "operationName": "VideoCommentsByOffsetOrCursor",
            "variables": {
                "videoID": video_id,
                "contentOffsetSeconds": offset_seconds as i64
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": QUERY_HASH
                }
            }
        }])
    } else {
        serde_json::json!([{
            "operationName": "VideoCommentsByOffsetOrCursor",
            "variables": {
                "videoID": video_id,
                "cursor": cursor
            },
            "extensions": {
                "persistedQuery": {
                    "version": 1,
                    "sha256Hash": QUERY_HASH
                }
            }
        }])
    };

    let client = reqwest::Client::new();
    let response = client
        .post(GQL_URL)
        .header("Client-ID", GQL_CLIENT_ID)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("GQL request failed: {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}

// ---- VOD chat heatmap ----
// Samples VOD chat activity at many positions for the seek-bar heatmap. For each requested offset,
// fetches ONE page of VOD chat starting there (same GQL query as get_vod_chat, first-page form) and
// returns only compact stats: how many comments the page had and the time span they cover. The frontend
// turns that into messages/second per sample. Parsing happens here so the webview never receives the
// full comment payloads (a couple hundred pages of them). Fetches run concurrently, capped at
// HEATMAP_CONCURRENCY to stay polite to Twitch. Per-sample failures are reported, not fatal.
const HEATMAP_CONCURRENCY: usize = 6;

async fn vod_chat_page_stats(
    client: &reqwest::Client,
    video_id: &str,
    offset_seconds: f64,
) -> Result<(usize, f64, f64), String> {
    const GQL_URL: &str = "https://gql.twitch.tv/gql";
    const GQL_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
    const QUERY_HASH: &str =
        "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a";
    let body = serde_json::json!([{
        "operationName": "VideoCommentsByOffsetOrCursor",
        "variables": { "videoID": video_id, "contentOffsetSeconds": offset_seconds as i64 },
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": QUERY_HASH } }
    }]);
    let resp = client
        .post(GQL_URL)
        .header("Client-ID", GQL_CLIENT_ID)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GQL request failed: {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let edges = json
        .pointer("/0/data/video/comments/edges")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    let offsets: Vec<f64> = edges
        .iter()
        .filter_map(|e| e.pointer("/node/contentOffsetSeconds").and_then(|v| v.as_f64()))
        .collect();
    let first = offsets.iter().cloned().fold(f64::INFINITY, f64::min);
    let last = offsets.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if offsets.is_empty() {
        Ok((0, offset_seconds, offset_seconds))
    } else {
        Ok((offsets.len(), first, last))
    }
}

#[tauri::command]
pub async fn get_vod_chat_density(
    video_id: String,
    offsets: Vec<f64>,
) -> Result<Vec<serde_json::Value>, String> {
    use futures_util::stream::{self, StreamExt};
    let client = reqwest::Client::new();
    let results: Vec<(f64, Result<(usize, f64, f64), String>)> = stream::iter(offsets.into_iter().map(|off| {
        let client = client.clone();
        let vid = video_id.clone();
        async move { (off, vod_chat_page_stats(&client, &vid, off).await) }
    }))
    .buffer_unordered(HEATMAP_CONCURRENCY)
    .collect()
    .await;
    Ok(results
        .into_iter()
        .map(|(off, r)| match r {
            Ok((count, first, last)) => serde_json::json!({
                "offset": off, "count": count, "first": first, "last": last
            }),
            Err(_) => serde_json::json!({ "offset": off, "error": true }),
        })
        .collect())
}

// how many live streams to sample when approximating per-category viewer counts (see
// get_category_viewer_counts). larger = more accurate for lower-ranked categories at the cost of more
// Helix requests (paged at 100) and a slower Browse load; 1000 covers every category visible before "Show more"
const CATEGORY_VIEWER_SAMPLE_SIZE: usize = 1000;

// approximates live viewer and channel count per category by aggregating a sample of top streams,
// NOT exhaustive, and NOT the number twitch.tv shows (that comes from an internal service Helix doesn't
// expose; the Twitch dev forums confirm this has never been in the public API). the closest honest
// substitute: real currently-live counts, only as complete as the sample. good enough to rank and size the Browse cards
#[tauri::command]
pub async fn get_category_viewer_counts(state: State<'_, ChatState>) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());

    let mut by_game: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    let mut cursor: Option<String> = None;
    let mut fetched = 0usize;

    while fetched < CATEGORY_VIEWER_SAMPLE_SIZE {
        let url = match &cursor {
            Some(c) => format!("https://api.twitch.tv/helix/streams?first=100&after={c}"),
            None => "https://api.twitch.tv/helix/streams?first=100".to_string(),
        };
        let body = helix_get(&url, token.clone()).await?;
        let parsed: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;

        let Some(data) = parsed.get("data").and_then(|d| d.as_array()) else { break };
        if data.is_empty() { break; }

        for stream in data {
            let Some(game_id) = stream.get("game_id").and_then(|v| v.as_str()) else { continue };
            if game_id.is_empty() { continue; }
            let viewers = stream.get("viewer_count").and_then(|v| v.as_i64()).unwrap_or(0);
            let entry = by_game.entry(game_id.to_string()).or_insert((0, 0));
            entry.0 += viewers;
            entry.1 += 1;
        }
        fetched += data.len();

        cursor = parsed
            .get("pagination")
            .and_then(|p| p.get("cursor"))
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
            .map(|c| c.to_string());
        if cursor.is_none() { break; }
    }

    // {game_id: {viewer_count, channel_count}}, aggregated server-side so the frontend never parses the ~1000 stream objects itself, just looks up its game_id
    let out: serde_json::Map<String, serde_json::Value> = by_game
        .into_iter()
        .map(|(game_id, (viewers, channels))| {
            (game_id, serde_json::json!({ "viewer_count": viewers, "channel_count": channels }))
        })
        .collect();
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

// top live channels overall, sorted by viewer count, the closest PUBLIC equivalent to the official
// site's personalized "Live Channels" rail. there's no public Helix endpoint for personalized
// recommendations (the real site's is an internal GraphQL service), so this substitutes general top-viewed live channels, needing only Client-ID
#[tauri::command]
pub async fn get_top_live_streams(state: State<'_, ChatState>) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());
    let body = helix_get("https://api.twitch.tv/helix/streams?first=100", token).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let data = parsed
        .get("data")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    serde_json::to_string(&data).map_err(|e| e.to_string())
}

// cursor-paginated sibling of get_top_live_streams, for the Browse page's Live Channels tab, which
// infinite-scrolls through every live channel like the Categories grid. kept separate rather than
// adding a cursor param to get_top_live_streams, which home.js and sidebar.js also call expecting a
// flat array; changing its shape would break them. same {"streams": [...], "cursor": ...} envelope as get_top_games
#[tauri::command]
pub async fn get_live_streams_page(
    state: State<'_, ChatState>,
    cursor: Option<String>,
) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());

    let url = match &cursor {
        Some(c) => format!("https://api.twitch.tv/helix/streams?first=100&after={c}"),
        None => "https://api.twitch.tv/helix/streams?first=100".to_string(),
    };
    let body = helix_get(&url, token).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;

    let streams = parsed
        .get("data")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    let next_cursor = parsed
        .get("pagination")
        .and_then(|p| p.get("cursor"))
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty());

    serde_json::to_string(&serde_json::json!({
        "streams": streams,
        "cursor": next_cursor,
    }))
    .map_err(|e| e.to_string())
}

// live streams for a hand-picked set of games, for home-feed rows like "RPGs". Twitch's directory
// groups by genre via an internal service not in public Helix, so the closest public equivalent is
// resolving a few representative names to game_ids (one request; Helix accepts multiple name params) and pulling /helix/streams for them together, sorted by viewer count
#[tauri::command]
pub async fn get_streams_for_game_names(
    state: State<'_, ChatState>,
    game_names: Vec<String>,
) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());

    if game_names.is_empty() {
        return Ok("[]".to_string());
    }

    let name_params = game_names
        .iter()
        .map(|n| format!("name={}", urlencoding_encode(n)))
        .collect::<Vec<_>>()
        .join("&");
    let games_url = format!("https://api.twitch.tv/helix/games?{name_params}");
    let games_body = helix_get(&games_url, token.clone()).await?;
    let games_parsed: serde_json::Value =
        serde_json::from_str(&games_body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let game_ids: Vec<String> = games_parsed
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|g| g.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    if game_ids.is_empty() {
        return Ok("[]".to_string());
    }

    let game_id_params = game_ids
        .iter()
        .map(|id| format!("game_id={id}"))
        .collect::<Vec<_>>()
        .join("&");
    let streams_url = format!("https://api.twitch.tv/helix/streams?{game_id_params}&first=100");
    let streams_body = helix_get(&streams_url, token).await?;
    let streams_parsed: serde_json::Value =
        serde_json::from_str(&streams_body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let mut data: Vec<serde_json::Value> = streams_parsed
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    // Helix returns each game_id's results in its own block, not merged by viewer count, re-sort across the combined set so the row reads highest-first like a real category page
    data.sort_by_key(|s| {
        std::cmp::Reverse(s.get("viewer_count").and_then(|v| v.as_i64()).unwrap_or(0))
    });

    serde_json::to_string(&data).map_err(|e| e.to_string())
}

// fuzzy category search, backing the Browse page's "Search Category Tags" box, matches by partial
// name, unlike get_streams_for_game_names (and /helix/games?name=) which resolve an EXACT name to its
// id. returns the same shape as get_top_games's cards (id/name/box_art_url) so the frontend reuses its card renderer
#[tauri::command]
pub async fn search_categories(
    state: State<'_, ChatState>,
    query: String,
) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());

    if query.trim().is_empty() {
        return Ok("[]".to_string());
    }

    let url = format!(
        "https://api.twitch.tv/helix/search/categories?query={}&first=40",
        urlencoding_encode(query.trim())
    );
    let body = helix_get(&url, token).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let data = parsed
        .get("data")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    serde_json::to_string(&data).map_err(|e| e.to_string())
}

// fetches one page of the top games/categories by current viewer count, the category-cards grid for
// the Browse page. cursor is the pagination token from the previous call (None for the first); a null
// cursor means Twitch has no more categories with a live viewer right now, the real end of the list.
// previously this returned a single fixed batch (200 items), so "Show more" could only reveal what was
// already fetched, even though Twitch's directory keeps going for thousands. this makes each page a fresh on-demand request, removing the cap
const GAMES_PAGE_SIZE: &str = "100"; // Helix's own max page size for this endpoint

#[tauri::command]
pub async fn get_top_games(
    state: State<'_, ChatState>,
    cursor: Option<String>,
) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());

    let url = match &cursor {
        Some(c) => format!("https://api.twitch.tv/helix/games/top?first={GAMES_PAGE_SIZE}&after={c}"),
        None => format!("https://api.twitch.tv/helix/games/top?first={GAMES_PAGE_SIZE}"),
    };
    let body = helix_get(&url, token).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;

    let games = parsed
        .get("data")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    let next_cursor = parsed
        .get("pagination")
        .and_then(|p| p.get("cursor"))
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty());

    serde_json::to_string(&serde_json::json!({
        "games": games,
        "cursor": next_cursor,
    }))
    .map_err(|e| e.to_string())
}

// live streams for a single game_id, sorted by viewer count, the streams grid after drilling into
// one category on Browse. separate from get_streams_for_game_names (which resolves names to ids first for the home feed's RPG list); here we already have the id from a get_top_games card
#[tauri::command]
pub async fn get_streams_for_game_id(
    state: State<'_, ChatState>,
    game_id: String,
) -> Result<String, String> {
    let token = state
        .auth
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.access_token.clone());
    let url = format!("https://api.twitch.tv/helix/streams?game_id={game_id}&first=100");
    let body = helix_get(&url, token).await?;
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad JSON from Helix: {e}"))?;
    let data = parsed
        .get("data")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    serde_json::to_string(&data).map_err(|e| e.to_string())
}

// minimal percent-encoding for game names in query params (spaces, etc.), avoids pulling in a full urlencoding/url crate for this one narrow use
pub(crate) fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

// pinned chat messages via Twitch's private GQL (GetPinnedChat). the official Helix pinned-message
// endpoint is moderator-only, so for a regular viewer this GQL op is the only way to read pins.
// PROBE: uses the Twitch Android client id (kd1unb4b3q4t58fwlpcbzcbnm76a8fp, which is integrity-free
// for this op) together with the logged-in user's existing OAuth token. that token was minted for a
// different client id, so Twitch may reject the pairing; if so we surface the exact error rather than
// failing silently, so we can decide whether an Android device-login flow is worth adding.
// hash captured by the StreamNook project (2026-03-25); response shape mirrors theirs.
#[tauri::command]
pub async fn get_pinned_chat_messages(
    channel_id: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    // uses the Android device-login token (see twitch_device_auth); the web-login token is rejected by
    // this GQL op. not connected -> no pins (not an error)
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::json!([])),
    };

    const GQL_URL: &str = "https://gql.twitch.tv/gql";
    const ANDROID_CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
    const HASH: &str = "2d099d4c9b6af80a07d8440140c4f3dbb04d516b35c401aab7ce8f60765308d5";

    let body = serde_json::json!({
        "operationName": "GetPinnedChat",
        "variables": { "channelID": channel_id, "count": 10 },
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
    });

    let client = reqwest::Client::new();
    let response = client
        .post(GQL_URL)
        .header("Client-Id", ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .header("Accept", "*/*")
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("pinned request failed: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GetPinnedChat HTTP {status}: {text}"));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("GetPinnedChat parse error: {e}"))?;
    if let Some(errors) = json.get("errors") {
        return Err(format!("GetPinnedChat GQL errors: {errors}"));
    }

    let mut pins = Vec::new();
    if let Some(edges) = json
        .pointer("/data/channel/pinnedChatMessages/edges")
        .and_then(|v| v.as_array())
    {
        for edge in edges {
            let node = match edge.get("node") {
                Some(n) => n,
                None => continue,
            };
            let msg = node
                .pointer("/pinnedMessage/content/text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if msg.is_empty() {
                continue;
            }
            pins.push(serde_json::json!({
                "message_id": node.pointer("/pinnedMessage/id").and_then(|v| v.as_str()).unwrap_or(""),
                "text": msg,
                "sender_name": node.pointer("/pinnedMessage/sender/displayName").and_then(|v| v.as_str()).unwrap_or(""),
                "sender_color": node.pointer("/pinnedMessage/sender/chatColor").and_then(|v| v.as_str()).unwrap_or(""),
                "pinned_by": node.pointer("/pinnedBy/displayName").and_then(|v| v.as_str()).unwrap_or(""),
            }));
        }
    }
    Ok(serde_json::json!(pins))
}

// live hype train for a channel via GQL (GetHypeTrainExecution). web client id, read-only (NO auth
// token, unlike pins), so it works for ANY channel you watch, unlike EventSub channel.hype_train which
// needs broadcaster scope. returns {active, level, progress, goal, total, is_golden, expires_at}.
// operation hash from the StreamNook project.
#[tauri::command]
pub async fn get_hype_train(channel_login: String) -> Result<serde_json::Value, String> {
    const GQL_URL: &str = "https://gql.twitch.tv/gql";
    const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
    const HASH: &str = "8a39e843c94c5109a4cfb9badc641733e2205c60f5ee30e9b55edf0ad9db870a";

    // random device/session ids like the web client sends (StreamNook includes these; harmless if optional)
    let mut rnd = [0u8; 16];
    let _ = getrandom::getrandom(&mut rnd);
    let device_id: String = rnd.iter().map(|b| format!("{b:02x}")).collect();

    let body = serde_json::json!({
        "operationName": "GetHypeTrainExecution",
        "variables": { "userLogin": channel_login },
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(GQL_URL)
        .header("Client-ID", WEB_CLIENT_ID)
        .header("Content-Type", "application/json")
        .header("Accept", "*/*")
        .header("X-Device-Id", device_id.as_str())
        .header("Client-Session-Id", device_id.as_str())
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GetHypeTrainExecution HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let exec = match json.pointer("/data/user/channel/hypeTrain/execution") {
        Some(e) if !e.is_null() => e.clone(),
        _ => return Ok(serde_json::json!({ "active": false })),
    };
    let prog = exec.pointer("/progress");
    let geti = |p: Option<&serde_json::Value>, key: &str| {
        p.and_then(|v| v.get(key)).and_then(|v| v.as_i64()).unwrap_or(0)
    };
    let level = prog
        .and_then(|p| p.pointer("/level/value"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let progress = geti(prog, "progression");
    let goal = geti(prog, "goal");
    let total = geti(prog, "total");
    let expires_at = exec.get("expiresAt").and_then(|v| v.as_str()).unwrap_or("");
    let is_golden = exec
        .get("isGoldenKappaTrain")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Ok(serde_json::json!({
        "active": true,
        "level": level,
        "progress": progress,
        "goal": goal,
        "total": total,
        "is_golden": is_golden,
        "expires_at": expires_at,
    }))
}

// active channel prediction via GQL (raw GetChannelPrediction query, no persisted hash). uses the
// Android device-login token (same one pins use), so it works for any channel you watch. returns the
// prediction (title/status/outcomes with point+user totals/timing) or null when there's none / not
// device-connected. query + shape from the StreamNook project.
#[tauri::command]
pub async fn get_channel_prediction(
    channel_login: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::Value::Null),
    };

    const QUERY: &str = "query GetChannelPrediction($login: String!) { channel(name: $login) { id activePredictionEvent { id status title predictionWindowSeconds createdAt lockedAt endedAt winningOutcome { id } outcomes { id title color totalPoints totalUsers } } } }";

    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "GetChannelPrediction",
            "query": QUERY,
            "variables": { "login": channel_login.to_lowercase() }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GetChannelPrediction HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let pred = match json.pointer("/data/channel/activePredictionEvent") {
        Some(p) if !p.is_null() => p.clone(),
        _ => return Ok(serde_json::Value::Null),
    };

    let mut outcomes = Vec::new();
    if let Some(arr) = pred.get("outcomes").and_then(|v| v.as_array()) {
        for o in arr {
            outcomes.push(serde_json::json!({
                "id": o.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "title": o.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "color": o.get("color").and_then(|v| v.as_str()).unwrap_or("BLUE"),
                "total_points": o.get("totalPoints").and_then(|v| v.as_i64()).unwrap_or(0),
                "total_users": o.get("totalUsers").and_then(|v| v.as_i64()).unwrap_or(0),
            }));
        }
    }

    Ok(serde_json::json!({
        "id": pred.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "title": pred.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "status": pred.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE"),
        "window_seconds": pred.get("predictionWindowSeconds").and_then(|v| v.as_i64()).unwrap_or(60),
        "created_at": pred.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""),
        "winning_outcome_id": pred.pointer("/winningOutcome/id").and_then(|v| v.as_str()),
        "outcomes": outcomes,
    }))
}

#[derive(serde::Serialize)]
pub struct ClipResult {
    id: String,
    edit_url: String,
    ready: bool,
}

// creates a clip of the live stream via Helix (captures ~last 30s server-side). needs the web login
// token with the clips:edit scope (added to oauth.rs; requires a re-login to take effect). returns the
// clip id + edit_url (Twitch's trim/publish page). errors are made human-readable for a toast.
#[tauri::command]
pub async fn create_clip(
    broadcaster_id: String,
    state: State<'_, ChatState>,
) -> Result<ClipResult, String> {
    let token = {
        let guard = state.auth.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(c) => c.access_token.clone(),
            None => return Err("Log in to Twitch to create clips.".into()),
        }
    };

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.twitch.tv/helix/clips")
        .query(&[("broadcaster_id", broadcaster_id.as_str())])
        .header("Client-Id", oauth::CLIENT_ID)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Clip permission missing — log out and back in to Twitch to grant it.".into());
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err("Couldn't create a clip — the stream may be offline or have clips disabled.".into());
    }

    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let d = json
        .pointer("/data/0")
        .ok_or_else(|| "Twitch returned no clip.".to_string())?;
    let id = d.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let edit_url = d.get("edit_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return Err("Twitch returned no clip.".into());
    }

    // Create Clip is ASYNC: the edit_url is valid immediately but the clip's video isn't rendered yet,
    // so opening it right away shows a black/empty frame. poll Get Clips until the thumbnail is a real
    // one (Twitch serves a "...processing..." placeholder until the render finishes), up to ~24s.
    let mut ready = false;
    for _ in 0..12 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let g = client
            .get("https://api.twitch.tv/helix/clips")
            .query(&[("id", id.as_str())])
            .header("Client-Id", oauth::CLIENT_ID)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await;
        if let Ok(r) = g {
            if let Ok(t) = r.text().await {
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(&t) {
                    if let Some(thumb) = j
                        .pointer("/data/0/thumbnail_url")
                        .and_then(|v| v.as_str())
                    {
                        if !thumb.is_empty() && !thumb.contains("processing") {
                            ready = true;
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(ClipResult { id, edit_url, ready })
}

// --- Channel points + drops (device-login token; return empty/None when not connected) ---

// current channel-points balance for a channel (raw ChannelPointsContext query, like StreamNook)
#[tauri::command]
pub async fn get_channel_points(
    channel_login: String,
    app: tauri::AppHandle,
) -> Result<Option<i64>, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(None),
    };
    const QUERY: &str = "query ChannelPointsContext($channelLogin: String!) { user(login: $channelLogin) { channel { self { communityPoints { balance } } } } }";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "ChannelPointsContext",
            "query": QUERY,
            "variables": { "channelLogin": channel_login.to_lowercase() }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json
        .pointer("/data/user/channel/self/communityPoints/balance")
        .and_then(|v| v.as_i64()))
}

// active drops: campaigns in progress with per-drop minute progress + claimable state. Inventory
// persisted query + hashes from the StreamNook project.
#[tauri::command]
pub async fn get_drops_inventory(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::json!([])),
    };
    const HASH: &str = "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "Inventory",
            "variables": { "fetchRewardCampaigns": false },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(errors) = json.get("errors") {
        return Err(format!("Inventory GQL errors: {errors}"));
    }

    let mut out = Vec::new();
    if let Some(campaigns) = json
        .pointer("/data/currentUser/inventory/dropCampaignsInProgress")
        .and_then(|v| v.as_array())
    {
        for c in campaigns {
            let game = c
                .pointer("/game/displayName")
                .and_then(|v| v.as_str())
                .or_else(|| c.pointer("/game/name").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            let box_art = c.pointer("/game/boxArtURL").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let campaign = c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();

            let mut drops = Vec::new();
            if let Some(tbd) = c.get("timeBasedDrops").and_then(|v| v.as_array()) {
                for d in tbd {
                    let name = d.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let required = d.get("requiredMinutesWatched").and_then(|v| v.as_i64()).unwrap_or(0);
                    let current = d.pointer("/self/currentMinutesWatched").and_then(|v| v.as_i64()).unwrap_or(0);
                    let claimed = d.pointer("/self/isClaimed").and_then(|v| v.as_bool()).unwrap_or(false);
                    let instance = d.pointer("/self/dropInstanceID").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let image = d
                        .pointer("/benefitEdges/0/benefit/imageAssetURL")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let claimable = !instance.is_empty() && !claimed;
                    drops.push(serde_json::json!({
                        "name": name,
                        "current": current,
                        "required": required,
                        "claimed": claimed,
                        "claimable": claimable,
                        "drop_instance_id": instance,
                        "image": image,
                    }));
                }
            }
            if !drops.is_empty() {
                let cid = c
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{game}|{campaign}"));
                out.push(serde_json::json!({
                    "id": cid, "game": game, "campaign": campaign, "box_art": box_art, "drops": drops
                }));
            }
        }
    }
    Ok(serde_json::json!(out))
}

// claim an earned drop by its instance id (DropsPage_ClaimDropRewards)
#[tauri::command]
pub async fn claim_drop(drop_instance_id: String, app: tauri::AppHandle) -> Result<bool, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    const HASH: &str = "a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "DropsPage_ClaimDropRewards",
            "variables": { "input": { "dropInstanceID": drop_instance_id } },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("claim failed: HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json.get("errors").is_none())
}

// --- Watch streaks (RewardList / ShareMilestone), mirrored from StreamNook. Web client id + the
// device-login token; returns the current channel's streak milestone (count, share status, bonus). ---

fn watch_streak_headers(token: &str) -> reqwest::header::HeaderMap {
    let mut rnd = [0u8; 16];
    let _ = getrandom::getrandom(&mut rnd);
    let id: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("Client-ID", "kimne78kx3ncx6brgo4mv6wki5h1ko".parse().unwrap());
    h.insert(reqwest::header::ACCEPT, "*/*".parse().unwrap());
    h.insert("Authorization", format!("OAuth {token}").parse().unwrap());
    h.insert("X-Device-Id", id.parse().unwrap());
    h.insert("Client-Session-Id", id.parse().unwrap());
    h
}

#[allow(dead_code)]
// resolve a channel's numeric broadcaster id from its login (device token). used by the point/streak/
// redeem commands so they don't depend on the IRC room-id, which isn't reliably set on every channel.
pub(crate) async fn resolve_broadcaster_id(login: &str, token: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "query": "query R($login:String!){ user(login:$login){ id } }",
            "variables": { "login": login.to_lowercase() }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    j.pointer("/data/user/id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "couldn't resolve channel id".to_string())
}

#[tauri::command]
pub async fn get_watch_streak(
    channel_login: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::Value::Null),
    };
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    const HASH: &str = "0b1471876d7647993731b9e3c6a13bf304c67fb31d07f06a945d42286ee377c4";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .headers(watch_streak_headers(&token))
        .json(&serde_json::json!({
            "operationName": "RewardList",
            "variables": { "channelID": channel_id, "shouldIncludeAllSuspendedStreaks": false },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let milestone = match json.pointer("/data/channel/self/watchStreakMilestone") {
        Some(m) if !m.is_null() => m.clone(),
        _ => return Ok(serde_json::Value::Null),
    };
    let count = milestone
        .pointer("/watchStreakMilestone/value")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    if count <= 0 {
        return Ok(serde_json::Value::Null);
    }
    Ok(serde_json::json!({
        "count": count,
        "milestone_id": milestone.pointer("/watchStreakMilestone/id").and_then(|v| v.as_str()).unwrap_or(""),
        "share_status": milestone.pointer("/watchStreakMilestone/shareStatus").and_then(|v| v.as_str()).unwrap_or(""),
        "threshold": milestone.get("watchStreakThreshold").and_then(|v| v.as_i64()).unwrap_or(0),
        "bonus": milestone.get("watchStreakCopoBonus").and_then(|v| v.as_i64()).unwrap_or(0),
    }))
}

// share the streak milestone to chat -> grants the channel-points bonus
#[tauri::command]
pub async fn share_watch_streak(
    channel_login: String,
    milestone_id: String,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    const HASH: &str = "25d20e60945d10123e8d466e30f21a1f1f578dfdea52c72095030b118eda9f39";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .headers(watch_streak_headers(&token))
        .json(&serde_json::json!({
            "operationName": "ShareMilestone",
            "variables": { "input": { "milestoneID": milestone_id, "channelID": channel_id } },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("share failed: HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(json.get("errors").is_none())
}

// --- Spending channel points: list a channel's custom rewards + redeem one (mirrored from StreamNook) ---

#[tauri::command]
pub async fn get_channel_rewards(
    channel_login: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::json!([])),
    };
    const HASH: &str = "374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "ChannelPointsContext",
            "variables": { "channelLogin": channel_login.to_lowercase(), "includeGoalTypes": ["CREATOR", "BOOST"] },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let settings = json
        .pointer("/data/community/channel/communityPointsSettings")
        .or_else(|| json.pointer("/data/channel/communityPointsSettings"));
    let mut out = Vec::new();
    if let Some(rewards) = settings
        .and_then(|s| s.get("customRewards"))
        .and_then(|v| v.as_array())
    {
        for r in rewards {
            let id = match r.get("id").and_then(|v| v.as_str()) {
                Some(i) => i.to_string(),
                None => continue,
            };
            let image = r
                .pointer("/image/url")
                .and_then(|v| v.as_str())
                .or_else(|| r.pointer("/defaultImage/url").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            // isEnabled is the field Twitch actually enforces (a disabled reward redeem returns DISABLED);
            // isPaused/isInStock were unreliable in this response, so don't gate on them here.
            let available = r.get("isEnabled").and_then(|v| v.as_bool()).unwrap_or(true);
            out.push(serde_json::json!({
                "id": id,
                "title": r.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "cost": r.get("cost").and_then(|v| v.as_i64()).unwrap_or(0),
                "prompt": r.get("prompt").and_then(|v| v.as_str()).unwrap_or(""),
                "requires_input": r.get("isUserInputRequired").and_then(|v| v.as_bool()).unwrap_or(false),
                "image": image,
                "available": available,
                "automatic": false,
                "reward_type": "",
            }));
        }
    }
    // Twitch's built-in "automatic" rewards (Highlight My Message, Unlock a Random Sub Emote, etc.).
    // These aren't customRewards; they use per-type mutations. Cost is `cost` (streamer override) else
    // `defaultCost` — NOT minimumCost, which causes a server-side cost mismatch. Mirrors StreamNook.
    if let Some(autos) = settings
        .and_then(|s| s.get("automaticRewards"))
        .and_then(|v| v.as_array())
    {
        for r in autos {
            let id = match r.get("id").and_then(|v| v.as_str()) {
                Some(i) => i.to_string(),
                None => continue,
            };
            let rtype = r.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if r.get("pricingType").and_then(|v| v.as_str()) == Some("BITS") {
                continue;
            }
            let title = match rtype {
                "SEND_HIGHLIGHTED_MESSAGE" => "Highlight My Message".to_string(),
                "SINGLE_MESSAGE_BYPASS_SUB_MODE" => "Send a Message in Sub-Only Mode".to_string(),
                "RANDOM_SUB_EMOTE_UNLOCK" => "Unlock a Random Sub Emote".to_string(),
                "CHOSEN_SUB_EMOTE_UNLOCK" => "Choose an Emote to Unlock".to_string(),
                "CHOSEN_MODIFIED_SUB_EMOTE_UNLOCK" => "Modify a Single Emote".to_string(),
                "SEND_GIGANTIFIED_EMOTE" => "Gigantify an Emote".to_string(),
                other => other.replace('_', " "),
            };
            let cost = r
                .get("cost")
                .and_then(|v| v.as_i64())
                .or_else(|| r.get("defaultCost").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            if cost == 0 {
                continue;
            }
            let available = r.get("isEnabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let image = r
                .pointer("/image/url")
                .and_then(|v| v.as_str())
                .or_else(|| r.pointer("/defaultImage/url").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            let requires_input =
                rtype == "SEND_HIGHLIGHTED_MESSAGE" || rtype == "SINGLE_MESSAGE_BYPASS_SUB_MODE";
            out.push(serde_json::json!({
                "id": id,
                "title": title,
                "cost": cost,
                "prompt": "",
                "requires_input": requires_input,
                "image": image,
                "available": available,
                "automatic": true,
                "reward_type": rtype,
            }));
        }
    }
    out.sort_by(|a, b| a["cost"].as_i64().unwrap_or(0).cmp(&b["cost"].as_i64().unwrap_or(0)));
    Ok(serde_json::json!(out))
}

// Fetch the emotes the logged-in user can actually use in this channel (subscriber, follower, unlocked,
// and modified emotes) via AvailableEmotesForChannel. Reverse-engineered — StreamNook defines this hash
// but never calls it — so the response shape is parsed defensively: we recursively collect every object
// that has both a string `id` and a string `token`, which is what an emote node looks like regardless of
// the exact nesting.
#[tauri::command]
pub async fn get_available_emotes(
    channel_login: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::json!([])),
    };
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    const HASH: &str = "6c45e0ecaa823cc7db3ecdd1502af2223c775bdcfb0f18a3a0ce9a0b7db8ef6c";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "AvailableEmotesForChannel",
            "variables": { "channelID": channel_id, "withOwner": true },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // surface a GQL error (wrong hash/variables) instead of silently returning nothing
    if let Some(errs) = json.get("errors").and_then(|v| v.as_array()) {
        if !errs.is_empty() {
            let msg = errs[0]
                .pointer("/message")
                .and_then(|v| v.as_str())
                .unwrap_or("GraphQL error");
            return Err(format!("AvailableEmotesForChannel: {msg}"));
        }
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect_emotes(&json, &mut out, &mut seen);
    Ok(serde_json::json!(out))
}

fn collect_emotes(
    v: &serde_json::Value,
    out: &mut Vec<serde_json::Value>,
    seen: &mut std::collections::HashSet<String>,
) {
    match v {
        serde_json::Value::Object(map) => {
            let id = map.get("id").and_then(|x| x.as_str());
            let token = map.get("token").and_then(|x| x.as_str());
            if let (Some(id), Some(token)) = (id, token) {
                if !id.is_empty() && !token.is_empty() && seen.insert(id.to_string()) {
                    out.push(serde_json::json!({ "id": id, "token": token }));
                }
            }
            for (_, val) in map {
                collect_emotes(val, out, seen);
            }
        }
        serde_json::Value::Array(arr) => {
            for val in arr {
                collect_emotes(val, out, seen);
            }
        }
        _ => {}
    }
}

// Redeem the two simplest automatic rewards. Others (emote picker / gigantify) need more UI and aren't
// wired yet. Mirrors StreamNook's per-type mutations.
#[tauri::command]
pub async fn redeem_highlight_message(
    channel_login: String,
    message: String,
    cost: i64,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    const HASH: &str = "bb187d763156dc5c25c6457e1b32da6c5033cb7504854e6d33a8b876d10444b6";
    automatic_redeem(
        &token,
        "SendHighlightedChatMessage",
        HASH,
        serde_json::json!({
            "channelID": channel_id, "cost": cost, "message": message,
            "transactionID": rand_hex(),
        }),
    )
    .await
}

#[tauri::command]
pub async fn redeem_random_emote(
    channel_login: String,
    cost: i64,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    const HASH: &str = "f548e89966b21d0094f3dc35233232eb6ec76d63e02594c8a494407712a85350";
    let json = post_redeem_json(
        &token,
        serde_json::json!({
            "operationName": "UnlockRandomSubscriberEmote",
            "variables": { "input": { "channelID": channel_id, "cost": cost, "transactionID": rand_hex() } },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }),
    )
    .await?;
    // surface which emote was unlocked so the UI can reveal it
    let data = json.pointer("/data/unlockRandomSubscriberEmote");
    let emote = data
        .and_then(|d| d.get("unlockedEmote").or_else(|| d.get("emote")))
        .and_then(|e| {
            let id = e.get("id").and_then(|v| v.as_str())?;
            let token_name = e
                .get("token")
                .and_then(|v| v.as_str())
                .or_else(|| e.get("name").and_then(|v| v.as_str()))
                .unwrap_or(id);
            Some(serde_json::json!({ "id": id, "token": token_name }))
        });
    Ok(emote.unwrap_or(serde_json::Value::Null))
}

fn rand_hex() -> String {
    let mut r = [0u8; 16];
    let _ = getrandom::getrandom(&mut r);
    r.iter().map(|b| format!("{b:02x}")).collect()
}

async fn automatic_redeem(
    token: &str,
    op: &str,
    hash: &str,
    input: serde_json::Value,
) -> Result<bool, String> {
    post_redeem(
        token,
        serde_json::json!({
            "operationName": op,
            "variables": { "input": input },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } }
        }),
    )
    .await
}

// core POST for the automatic/emote reward mutations: sends the given GQL payload with the device token
// + dashless ids, turns a nested `error.code` into a friendly message, and returns the response JSON.
async fn post_redeem_json(token: &str, payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let did = rand_hex();
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .header("X-Device-Id", did.as_str())
        .header("Client-Session-Id", &did[..16])
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(errs) = json.get("errors").and_then(|v| v.as_array()) {
        if !errs.is_empty() {
            let msg = errs[0].pointer("/message").and_then(|v| v.as_str()).unwrap_or("rejected");
            return Err(msg.to_string());
        }
    }
    if let Some(code) = find_error_code(&json) {
        let friendly = match code.as_str() {
            "INSUFFICIENT_POINTS" => "Not enough points.".to_string(),
            "COOLDOWN" => "Reward is on cooldown.".to_string(),
            "MAX_PER_STREAM_EXCEEDED" => "Max redemptions this stream reached.".to_string(),
            "ALREADY_UNLOCKED" | "EMOTE_ALREADY_UNLOCKED" => "You already have that emote.".to_string(),
            other => format!("Redemption failed: {other}"),
        };
        return Err(friendly);
    }
    Ok(json)
}

async fn post_redeem(token: &str, payload: serde_json::Value) -> Result<bool, String> {
    post_redeem_json(token, payload).await.map(|_| true)
}

// List a channel's unlockable / modifiable sub emotes for the reward picker (from ChannelPointsContext's
// emoteVariants). Mirrors StreamNook's get_modifiable_emotes.
#[tauri::command]
pub async fn get_channel_emotes(
    channel_login: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::json!([])),
    };
    const HASH: &str = "374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "ChannelPointsContext",
            "variables": { "channelLogin": channel_login.to_lowercase() },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let variants = json
        .pointer("/data/community/channel/communityPointsSettings/emoteVariants")
        .or_else(|| json.pointer("/data/channel/communityPointsSettings/emoteVariants"))
        .and_then(|v| v.as_array());
    let mut out = Vec::new();
    if let Some(variants) = variants {
        for v in variants {
            if !v.get("isUnlockable").and_then(|b| b.as_bool()).unwrap_or(false) {
                continue;
            }
            let emote = match v.get("emote") {
                Some(e) => e,
                None => continue,
            };
            let id = emote.get("id").and_then(|i| i.as_str()).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let token_name = emote.get("token").and_then(|t| t.as_str()).unwrap_or(id);
            let mut mods = Vec::new();
            if let Some(ms) = v.get("modifications").and_then(|m| m.as_array()) {
                for m in ms {
                    let me = m.get("emote");
                    let modifier = m.get("modifier");
                    if let (Some(me), Some(modifier)) = (me, modifier) {
                        let mid = me.get("id").and_then(|i| i.as_str()).unwrap_or("");
                        if mid.is_empty() {
                            continue;
                        }
                        mods.push(serde_json::json!({
                            "id": mid,
                            "token": me.get("token").and_then(|t| t.as_str()).unwrap_or(mid),
                            "modifier_id": modifier.get("id").and_then(|i| i.as_str()).unwrap_or(""),
                        }));
                    }
                }
            }
            out.push(serde_json::json!({ "id": id, "token": token_name, "modifications": mods }));
        }
    }
    Ok(serde_json::json!(out))
}

#[tauri::command]
pub async fn unlock_chosen_emote(
    channel_login: String,
    emote_id: String,
    cost: i64,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    post_redeem(
        &token,
        serde_json::json!({
            "operationName": "UnlockChosenSubscriberEmote",
            "query": "mutation UnlockChosenSubscriberEmote($input: UnlockChosenSubscriberEmoteInput!) { unlockChosenSubscriberEmote(input: $input) { balance error { code __typename } __typename } }",
            "variables": { "input": {
                "channelID": channel_id, "emoteID": emote_id, "cost": cost, "transactionID": rand_hex(),
            }}
        }),
    )
    .await
}

#[tauri::command]
pub async fn unlock_modified_emote(
    channel_login: String,
    emote_id: String,
    cost: i64,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    const HASH: &str = "30e8cc29b1d6d96809f5e35f5e7a550ae8bf5d26966a9637d919477ffd0bfc52";
    automatic_redeem(
        &token,
        "UnlockModifiedEmote",
        HASH,
        serde_json::json!({
            "channelID": channel_id, "emoteID": emote_id, "cost": cost, "transactionID": rand_hex(),
        }),
    )
    .await
}

fn find_error_code(v: &serde_json::Value) -> Option<String> {
    if let Some(obj) = v.get("error").and_then(|e| e.as_object()) {
        if let Some(c) = obj.get("code").and_then(|c| c.as_str()) {
            return Some(c.to_string());
        }
    }
    if let Some(map) = v.as_object() {
        for (_, val) in map {
            if let Some(c) = find_error_code(val) {
                return Some(c);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn redeem_reward(
    channel_login: String,
    reward_id: String,
    cost: i64,
    title: String,
    prompt: Option<String>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    let channel_id = resolve_broadcaster_id(&channel_login, &token).await?;
    const HASH: &str = "d56249a7adb4978898ea3412e196688d4ac3cea1c0c2dfd65561d229ea5dcc42";
    let hexid = || {
        let mut r = [0u8; 16];
        let _ = getrandom::getrandom(&mut r);
        r.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let transaction_id = hexid();
    let device_id = hexid();
    let session_id = hexid();
    let prompt_sent = prompt.unwrap_or_default();

    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .header("X-Device-Id", device_id.as_str())
        .header("Client-Session-Id", &session_id[..16])
        .json(&serde_json::json!({
            "operationName": "RedeemCustomReward",
            "variables": { "input": {
                "channelID": channel_id,
                "cost": cost,
                "pricingType": "POINTS",
                "prompt": prompt_sent,
                "rewardID": reward_id,
                "title": title,
                "transactionID": transaction_id,
            }},
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("redeem failed: HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(errs) = json.get("errors").and_then(|v| v.as_array()) {
        if !errs.is_empty() {
            let msg = errs[0]
                .pointer("/message")
                .and_then(|v| v.as_str())
                .unwrap_or("Twitch rejected the redemption");
            return Err(msg.to_string());
        }
    }
    // payload has been seen under both field names; an `error` object means failure, otherwise success
    let payload = json
        .pointer("/data/redeemCommunityPointsCustomReward")
        .or_else(|| json.pointer("/data/redeemCustomReward"));
    if let Some(err) = payload.and_then(|p| p.get("error")).filter(|e| e.is_object()) {
        let code = err.get("code").and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
        let friendly = match code {
            "INSUFFICIENT_POINTS" => "Not enough points.".to_string(),
            "NOT_AVAILABLE" => "This reward isn't available right now.".to_string(),
            "MAX_PER_STREAM_EXCEEDED" => "Max redemptions this stream reached.".to_string(),
            "MAX_PER_USER_PER_STREAM_EXCEEDED" => "You've already redeemed this this stream.".to_string(),
            "COOLDOWN" => "Reward is on cooldown.".to_string(),
            "PROPERTIES_MISMATCH" => "Reward changed — reopen and try again.".to_string(),
            other => format!("Redemption failed: {other}"),
        };
        return Err(friendly);
    }
    Ok(true)
}

// Bulk "does this channel have an active hype train right now" for lists (sidebar/home/browse), so we
// badge live rows without one request per channel. BulkAllActiveHypeTrainStatusesQuery, web client id,
// no auth. Mirrors StreamNook's get_bulk_hype_train_status.
#[tauri::command]
pub async fn get_active_hype_trains(channel_ids: Vec<String>) -> Result<serde_json::Value, String> {
    if channel_ids.is_empty() {
        return Ok(serde_json::json!([]));
    }
    const HASH: &str = "88e62c2cbd13b7bdce93cc8934727003a5cadd821938538f74848199fbfe84a0";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", "kimne78kx3ncx6brgo4mv6wki5h1ko")
        .json(&serde_json::json!({
            "operationName": "BulkAllActiveHypeTrainStatusesQuery",
            "variables": { "channelIDs": channel_ids },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = json
        .pointer("/data/allActiveHypeTrainStatuses")
        .and_then(|v| v.as_array())
    {
        for t in arr {
            let cid = t
                .pointer("/channel/id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let Some(cid) = cid else { continue };
            out.push(serde_json::json!({
                "channel_id": cid,
                "level": t.get("level").and_then(|v| v.as_i64()).unwrap_or(0),
                "golden": t.get("isGoldenKappaTrain").and_then(|v| v.as_bool()).unwrap_or(false),
            }));
        }
    }
    Ok(serde_json::json!(out))
}

// Sub-anniversary ("resub") share: detect a pending anniversary the user can share in chat, and share it.
// Mirrors StreamNook's resub commands (Chat_ShareResub_ChannelData / Chat_ShareResub_UseResubToken).
#[tauri::command]
pub async fn get_resub_notification(
    channel_login: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let token = match crate::twitch_device_auth::get_device_token(&app).await {
        Some(t) => t,
        None => return Ok(serde_json::Value::Null),
    };
    const HASH: &str = "beb55e2ecdbae3dd29c51a60597014d526466bc8f94fb88f3c3482110f4da1aa";
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "Chat_ShareResub_ChannelData",
            "variables": { "channelLogin": channel_login.to_lowercase() },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let r = json.pointer("/data/user/self/resubNotification");
    match r {
        Some(r) if r.is_object() => Ok(serde_json::json!({
            "token": r.get("token").and_then(|v| v.as_str()).unwrap_or(""),
            "cumulative_months": r.get("cumulativeTenureMonths").and_then(|v| v.as_i64()).unwrap_or(0),
            "streak_months": r.get("streakTenureMonths").and_then(|v| v.as_i64()).unwrap_or(0),
            "months": r.get("months").and_then(|v| v.as_i64()).unwrap_or(0),
        })),
        _ => Ok(serde_json::Value::Null),
    }
}

#[tauri::command]
pub async fn share_resub(
    channel_login: String,
    message: Option<String>,
    include_streak: bool,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or_else(|| "Not connected — enable device login first.".to_string())?;
    const HASH: &str = "61045d4a4bb10d25080bc0a01a74232f1fa67a6a530e0f2ebf05df2f1ba3fa59";
    let mut input = serde_json::json!({
        "channelLogin": channel_login.to_lowercase(),
        "includeStreak": include_streak,
    });
    if let Some(msg) = message {
        if !msg.trim().is_empty() {
            input["message"] = serde_json::Value::String(msg);
        }
    }
    let client = reqwest::Client::new();
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", crate::twitch_device_auth::ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {token}"))
        .json(&serde_json::json!({
            "operationName": "Chat_ShareResub_UseResubToken",
            "variables": { "input": input },
            "extensions": { "persistedQuery": { "version": 1, "sha256Hash": HASH } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if json.get("errors").and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false) {
        return Err("Twitch rejected the share.".into());
    }
    Ok(true)
}
