// Twitch Helix REST API, proxied through Rust because api.twitch.tv fails inside
// WebView2. Token comes from ChatState (where OAuth parks it); commands that
// require login go through require_auth(), the rest send whatever token is
// available and let the JS side handle a 401.

use tauri::State;

use crate::oauth;
use crate::ChatState;

/// Shared HTTP fetch for both badge endpoints. Always attaches Client-ID, and
/// Authorization when a token is available.
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

// --- Sidebar data: followed channels + live status ---
// Mirrors the left-hand "For You" sidebar on the official site.

pub(crate) fn require_auth(state: &State<'_, ChatState>) -> Result<(String, String), String> {
    let guard = state.auth.lock().map_err(|e| e.to_string())?;
    let creds = guard
        .as_ref()
        .ok_or_else(|| "Not logged in".to_string())?;
    Ok((creds.access_token.clone(), creds.user_id.clone()))
}

/// Every followed channel for the logged-in user, paging through
/// /helix/channels/followed until the cursor runs out.
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

/// Given broadcaster IDs, returns the subset currently live (with
/// viewer_count/game_name/title/etc) via /helix/streams, chunked at 100 user_id
/// params per request (Helix's max).
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

/// Looks up the live-stream record (if any) for a single channel login via
/// /helix/streams?user_login= - used by the manual "Watch" button, which
/// (unlike the sidebar/home feed/browse page) starts with only a typed name and
/// no stream object, so it has no `tags` array for the drops banner (drops.js)
/// without a fresh lookup. Returns "null" (not an error) if the channel isn't
/// live, a normal case - main.js just skips the drops banner then.
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

/// Single user lookup by login, used when a channel is offline and we have no
/// stream object (hence no user_id) for get_users_info. Returns the first user
/// from /helix/users?login=<login>, or an error if the request fails or the
/// login isn't found.
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

/// Batched profile lookup (avatars + display names) via /helix/users, chunked
/// at 100 ids/request.
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

/// Fetches a channel's past broadcasts (VODs) from /helix/videos. Resolves login
/// -> user_id first (one extra Helix call) so the frontend passes only the login
/// it already knows.
#[tauri::command]
pub async fn get_videos_for_login(
    state: State<'_, ChatState>,
    login: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;

    // Step 1: resolve login -> user_id via /helix/users.
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

    // Step 2: fetch VODs for that user_id (archives only, most recent 20).
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

/// Fetches the muted (DMCA/copyright) segment ranges for one VOD via
/// /helix/videos?id=. Each segment is {duration, offset} in seconds - Twitch
/// mutes the audio (not video) for that range rather than removing the VOD,
/// usually after an automated copyright match.
///
/// IMPORTANT: per a confirmed Twitch bug (twitchdev/issues#501), muted_segments
/// is only populated with a USER access token - an app token gets `null` even
/// for VODs that visibly have muted segments. require_auth only succeeds with a
/// real user token, so this avoids that trap naturally. Still returns an empty
/// list (not an error) if the caller isn't logged in - so a logged-out viewer
/// just gets no markers rather than a broken player.
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


/// Returns the id and creation timestamp of the currently-recording VOD for a
/// live channel, enabling live-DVR: seeking past the MSE relay's buffer by
/// switching to HLS.js on the in-progress VOD.
///
/// Twitch creates the VOD at stream start. It appears in /helix/videos as the
/// most recent archive, distinguished from finished VODs by its thumbnail_url
/// still containing the "%{width}x%{height}" template placeholder rather than a
/// resolved URL.
///
/// Returns { "video_id": "...", "created_at": "..." }, or an error if the
/// channel has no live VOD (VODs disabled, not live, or not created yet).
#[tauri::command]
pub async fn get_live_vod_info(
    state: State<'_, ChatState>,
    login: String,
) -> Result<String, String> {
    let (token, _) = require_auth(&state)?;

    // Resolve login -> user_id.
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

    // Fetch the most recent archive VOD - the in-progress one is always first.
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

    // A currently-recording VOD has a template thumbnail URL, not a real one -
    // distinguishes it from a finished stream's VOD that happens to be the most
    // recent archive.
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

/// Fetches a page of VOD chat replay from the (deprecated but still functional)
/// Kraken v5 comments endpoint. Returns the raw JSON so JS can render messages
/// at the right timestamps. `cursor` is the pagination token from the previous
/// call (empty for the first page); `offset_seconds` is where in the VOD to
/// start (ignored after the first page - the cursor takes over).
#[tauri::command]
pub async fn get_vod_chat(
    _state: State<'_, ChatState>,
    video_id: String,
    offset_seconds: f64,
    cursor: String,
) -> Result<String, String> {
    // Twitch's Kraken v5 API was shut down in Feb 2023. VOD chat is now only
    // available via Twitch's internal GQL endpoint. We use the same public
    // Client-ID the twitch.tv web app uses, with the
    // VideoCommentsByOffsetOrCursor persisted query that's been stable since
    // mid-2021. No user token needed for public VODs.
    //
    // GQL persisted query hash for VideoCommentsByOffsetOrCursor:
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

/// How many live streams to sample when approximating per-category viewer counts
/// (see get_category_viewer_counts). Larger = more accurate for lower-ranked
/// categories at the cost of more Helix requests (paged at 100) and a slower
/// Browse load; 1000 covers every category visible before "Show more", since
/// lower-ranked ones have fewer viewers and matter less to this approximation.
const CATEGORY_VIEWER_SAMPLE_SIZE: usize = 1000;

/// Approximates live viewer and channel count per category by aggregating a
/// sample of top streams - NOT exhaustive, and NOT the number twitch.tv shows
/// (that comes from an internal service Helix doesn't expose; the Twitch dev
/// forums confirm this has never been in the public API). The closest honest
/// substitute: real currently-live counts, only as complete as the sample. Good
/// enough to rank and size the Browse cards; not guaranteed to match twitch.tv
/// exactly, especially for less-popular categories under-sampled here.
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

    // {game_id: {viewer_count, channel_count}} - aggregated server-side so the
    // frontend never parses the ~1000 stream objects itself, just looks up its
    // game_id.
    let out: serde_json::Map<String, serde_json::Value> = by_game
        .into_iter()
        .map(|(game_id, (viewers, channels))| {
            (game_id, serde_json::json!({ "viewer_count": viewers, "channel_count": channels }))
        })
        .collect();
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

/// Top live channels overall, sorted by viewer count - the closest PUBLIC
/// equivalent to the official site's personalized "Live Channels" rail. There's
/// no public Helix endpoint for personalized recommendations (the real site's is
/// an internal GraphQL service), so this substitutes general top-viewed live
/// channels, needing only Client-ID.
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

/// Cursor-paginated sibling of get_top_live_streams, for the Browse page's Live
/// Channels tab, which infinite-scrolls through every live channel like the
/// Categories grid. Kept separate rather than adding a cursor param to
/// get_top_live_streams, which home.js and sidebar.js also call expecting a flat
/// array; changing its shape would break them. Returns `{"streams": [...],
/// "cursor": "..." | null}`, same envelope as get_top_games.
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

/// Live streams for a hand-picked set of games, for home-feed rows like "RPGs".
/// Twitch's directory groups by genre via an internal service not in public
/// Helix, so the closest public equivalent is resolving a few representative
/// names to game_ids (one request; Helix accepts multiple `name` params) and
/// pulling /helix/streams for them together, sorted by viewer count.
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

    // Helix returns each game_id's results in its own block, not merged by viewer
    // count - re-sort across the combined set so the row reads highest-first like
    // a real category page.
    data.sort_by_key(|s| {
        std::cmp::Reverse(s.get("viewer_count").and_then(|v| v.as_i64()).unwrap_or(0))
    });

    serde_json::to_string(&data).map_err(|e| e.to_string())
}

/// Fuzzy category search, backing the Browse page's "Search Category Tags" box -
/// matches by partial name, unlike get_streams_for_game_names (and
/// /helix/games?name=) which resolve an EXACT name to its id. Returns the same
/// shape as get_top_games's cards (id/name/box_art_url) so the frontend reuses
/// its card renderer.
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

/// Fetches one page of the top games/categories by current viewer count - the
/// category-cards grid for the Browse page, equivalent to
/// twitch.tv/directory's top-level view.
///
/// `cursor` is the pagination token from the previous call (None for the first).
/// Returns `{"games": [...], "cursor": "..." | null}` - browse.js's "Show more"
/// calls again with the returned cursor, like get_vod_chat's pagination. A null
/// cursor means Twitch has no more categories with a live viewer right now, the
/// real end of the list.
///
/// Previously this returned a single fixed batch (200 items), so "Show more"
/// could only reveal what was already fetched - once past 200 there was nothing
/// more, even though Twitch's directory keeps going for thousands. That was why
/// Browse didn't show every category the website does; this makes each page a
/// fresh on-demand request, removing the cap.
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

/// Live streams for a single game_id, sorted by viewer count - the streams grid
/// after drilling into one category on Browse. Separate from
/// get_streams_for_game_names (which resolves names to ids first for the home
/// feed's RPG list); here we already have the id from a get_top_games card.
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

/// Minimal percent-encoding for game names in query params (spaces, etc.) -
/// avoids pulling in a full urlencoding/url crate for this one narrow use.
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
