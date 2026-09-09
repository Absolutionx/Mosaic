// Kick.com live-status lookup for Twitch -> Kick failover (see tryKickFailover in main.js). uses
// Kick's unofficial v2 channel endpoint, behind Cloudflare; every error reports rather than panics,
// and the frontend reads any Err as "couldn't check", never "offline".
//
// transport: curl subprocess first, reqwest fallback. Cloudflare fingerprints the TLS handshake
// (JA3/JA4), so reqwest's rustls handshake gets a 403 while curl's passes. reqwest stays as a fallback for machines without curl

use std::sync::Arc;

use crate::stream_relay::{proxied_hls_url, StreamRelayState};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// browser-ish UA sent on both transports. for curl it's mostly cosmetic (Cloudflare passes curl on
// its TLS fingerprint); for the reqwest fallback it's load-bearing, since reqwest's default UA is a guaranteed block even before the TLS fingerprint gets a say
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(serde::Serialize)]
pub struct KickLiveInfo {
    // Kick's HLS master playlist, already wrapped in the local hls-proxy so hls.js can fetch it CORS-free (the proxy is host-agnostic and rewrites nested playlist URIs through itself, so Kick rides the exact path Twitch VODs do)
    pub proxied_url: String,
    pub title: String,
    pub viewer_count: u64,
    pub category: String,
    // used by kick_chat.rs to subscribe to the Pusher channel chatrooms.{id}.v2. None if the payload didn't include one (chat then isn't offered)
    pub chatroom_id: Option<u64>,
    // the broadcaster's Kick USER id (distinct from chatroom_id and the channel id). required as broadcaster_user_id when POSTing a chat message (kick_oauth.rs). None if absent, in which case sending isn't offered (chat stays read-only) even when logged in
    pub broadcaster_user_id: Option<u64>,
    // ISO-8601 UTC start time of this broadcast, when Kick's payload includes one. lets the frontend
    // expand the live seek bar to the full elapsed time and an accurate "behind live" readout
    // (playback-controls.js's liveDvrStreamStartedAt), like Twitch's get_live_vod_info does with a VOD's
    // created_at. Kick has no separate on-demand VOD endpoint for an in-progress broadcast;
    // get_kick_live_dvr tries to find the session's in-progress RECORDING in the videos list instead, and
    // on success this also anchors the seek-bar-to-VOD offset math (resolveKickDvr/onLiveDvrSeek). when
    // that lookup fails, this still powers the display and deep seeks clamp. None if no timestamp was
    // found anywhere, in which case Kick sessions fall back to the same buffer-relative display Twitch uses in its first ~30-60s
    pub started_at: Option<String>,
    // Kick's id for the CURRENT livestream session (distinct from channel, chatroom, and user id, Kick mints a fresh one per broadcast). get_kick_live_dvr uses it to pick this exact session's entry from the videos listing, so the DVR swap can never land on last week's VOD. None if absent; DVR then falls back to the is_live flag match
    pub livestream_id: Option<u64>,
    // display name (capitalization as the user styled it), vs the slug
    pub display_name: Option<String>,
    // the broadcaster's profile picture URL
    pub avatar: Option<String>,
    // Kick's verified checkmark. the payload carries this as an object when verified and null when not (occasionally a plain bool), normalized to a bool here
    pub verified: bool,
    pub followers_count: Option<u64>,
    // broadcast language as Kick states it (usually a plain English word like "English"; sometimes an ISO code, the frontend handles both)
    pub language: Option<String>,
    pub is_mature: bool,
    // Kick's freeform stream tags, when present
    pub tags: Vec<String>,
    // the channel's custom subscriber badge art, one entry per tier ({months, src}) from the payload's subscriber_badges array. passed to chat (connectKick -> renderBadges) so a subscriber's badge shows the channel's own months-matched art like kick.com's chat, falling back to a generic badge when the channel has none
    pub subscriber_badges: Vec<KickSubscriberBadge>,
}

// one tier of a channel's custom subscriber badge art, see KickLiveInfo::subscriber_badges
#[derive(serde::Serialize)]
pub struct KickSubscriberBadge {
    pub months: u64,
    pub src: String,
}

// chat + identity info for a Kick channel REGARDLESS of live status, the offline-channel counterpart
// of get_kick_stream (which returns Ok(None) the moment a channel isn't live, discarding the very
// fields chat needs). Kick chatrooms stay open when offline, so watching an offline Kick channel
// should still connect chat, to READ the occasional message and, logged in, to SEND. Ok(None) only for
// a genuine 404 (no such channel). none of the livestream/playback fields are touched; this is purely the channel object's stable identity
#[tauri::command]
pub async fn get_kick_channel_chat_info(slug: String) -> Result<Option<serde_json::Value>, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }
    let url = format!("https://kick.com/api/v2/channels/{slug}");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(None); // 404: no such channel
    };
    let Some(chatroom_id) = json.pointer("/chatroom/id").and_then(|v| v.as_u64()) else {
        // no chatroom on the payload, nothing chat can attach to
        return Ok(None);
    };
    Ok(Some(serde_json::json!({
        "chatroom_id": chatroom_id,
        "broadcaster_user_id": u64_at(&json, &["/user_id", "/user/id"]),
        "subscriber_badges": json.pointer("/subscriber_badges").cloned(),
        "display_name": str_at(&json, &["/user/username", "/user/name"]).map(str::to_string),
        "avatar": str_at(
            &json,
            &["/user/profile_pic", "/user/profilepic", "/user/profile_picture"],
        )
        .map(str::to_string),
        "verified": match json.get("verified") {
            Some(v) if v.is_boolean() => v.as_bool().unwrap_or(false),
            Some(v) => !v.is_null(),
            None => json.pointer("/user/verified").and_then(|v| v.as_bool()).unwrap_or(false),
        },
        "followers_count": u64_at(&json, &["/followers_count", "/followersCount"]),
    })))
}

// returns Ok(Some(info)) if slug is currently live on Kick, else Ok(None) (offline OR no such
// channel, both "nothing to play", and no-such-Kick-channel is the EXPECTED outcome for most Twitch
// channels). Err is reserved for genuine can't-tell failures (network, Cloudflare challenge, unparseable JSON)
#[tauri::command]
pub async fn get_kick_stream(
    slug: String,
    relay: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<Option<KickLiveInfo>, String> {
    // Twitch logins are [a-z0-9_]; Kick slugs additionally use '-'. anything outside that can't be a valid slug, and since it's interpolated into a URL path (and a curl argv), reject rather than try to encode
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }

    let url = format!("https://kick.com/api/v2/channels/{slug}");

    // Ok(None) here means HTTP 404: no such Kick channel
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(None);
    };

    // livestream is null when offline. when present, is_live should be true, but check anyway rather than assume: Kick has been seen serving a stale livestream object right around stream end, exactly when this runs
    let is_live = json
        .pointer("/livestream/is_live")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !is_live {
        return Ok(None);
    }
    let Some(playback) = json
        .get("playback_url")
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
    else {
        // live but no usable playback URL, treat as not-failoverable
        return Ok(None);
    };

    Ok(Some(KickLiveInfo {
        proxied_url: proxied_hls_url(&relay, playback).await?,
        title: json
            .pointer("/livestream/session_title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        viewer_count: json
            .pointer("/livestream/viewer_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        category: json
            .pointer("/livestream/categories/0/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        chatroom_id: json.pointer("/chatroom/id").and_then(|v| v.as_u64()),
        // the channel's owning user id. on /api/v2/channels this is the top-level user_id (the channel owner); /user/id is the same user's nested object as a fallback for payload shape drift
        broadcaster_user_id: u64_at(&json, &["/user_id", "/user/id"]),
        // same field-name variants livestream_to_helix tries for browse/home listings, just rooted at /livestream instead of the livestream object being the JSON root, Kick's timestamp naming isn't consistent across its endpoints
        started_at: str_at(
            &json,
            &["/livestream/created_at", "/livestream/started_at", "/livestream/start_time"],
        )
        .map(to_iso_utc),
        livestream_id: json.pointer("/livestream/id").and_then(|v| v.as_u64()),
        display_name: str_at(&json, &["/user/username", "/user/name"]).map(str::to_string),
        avatar: str_at(
            &json,
            &["/user/profile_pic", "/user/profilepic", "/user/profile_picture"],
        )
        .map(str::to_string),
        verified: match json.get("verified") {
            Some(v) if v.is_boolean() => v.as_bool().unwrap_or(false),
            Some(v) => !v.is_null(), // object = verified, null = not
            None => json
                .pointer("/user/verified")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        },
        followers_count: u64_at(&json, &["/followers_count", "/followersCount"]),
        language: str_at(&json, &["/livestream/language", "/livestream/lang"])
            .map(str::to_string),
        is_mature: json
            .pointer("/livestream/is_mature")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        tags: json
            .pointer("/livestream/tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        subscriber_badges: json
            .pointer("/subscriber_badges")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| {
                        let months = b.get("months").and_then(|v| v.as_u64())?;
                        let src = str_at(b, &["/badge_image/src", "/badge_image"])
                            .filter(|s| s.starts_with("http"))?;
                        Some(KickSubscriberBadge { months, src: src.to_string() })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }))
}

// live-DVR source for a channel that is CURRENTLY live: the in-progress recording of this very
// broadcast, playable as a growing HLS VOD. Twitch exposes this directly (an "archive" VOD exists from
// minute one); Kick has no dedicated endpoint, but for channels with VODs enabled the session's
// recording shows up in the channel's own videos listing while still live, with a uuid that resolves
// to a master playlist via /api/v1/video/{uuid}, the same pair of calls kick.com uses for its VOD
// pages. the recording grows as the broadcast continues (hls.js handles a growing playlist), trailing
// the edge by ~30-60s. matching WHICH listing entry is this session (rather than an older VOD) is
// deliberately strict: the livestream id from get_kick_stream when provided, else an is_live flag. no
// "newest entry" fallback, swapping onto last week's VOD because a seek went past the buffer would be
// far worse than the clamp this replaces. Ok(None) = no DVR available (VODs disabled, session not listed yet, or no playable source), the frontend keeps clamp-with-notice then
#[tauri::command]
pub async fn get_kick_live_dvr(
    slug: String,
    livestream_id: Option<u64>,
    relay: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<Option<serde_json::Value>, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }

    // 1) the channel's videos listing, each entry is a livestream object with an embedded {video: {uuid}} once a recording exists
    let url = format!("https://kick.com/api/v2/channels/{slug}/videos");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(None);
    };
    let items = items_of(&json);
    let uuid_of = |v: &serde_json::Value| {
        str_at(v, &["/video/uuid", "/uuid"]).map(str::to_string)
    };
    let mut uuid: Option<String> = None;
    if let Some(want) = livestream_id {
        // exact session match. field spelling tried in the known variants, same per-item tolerance as every other extractor here
        uuid = items.iter().find_map(|v| {
            let id = u64_at(v, &["/id", "/livestream/id", "/video/live_stream_id"]);
            if id == Some(want) { uuid_of(v) } else { None }
        });
    }
    if uuid.is_none() {
        // no id to match (or no entry carried it): accept an entry Kick itself flags as the live one
        uuid = items.iter().find_map(|v| {
            let live = v
                .pointer("/is_live")
                .or_else(|| v.pointer("/livestream/is_live"))
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            if live { uuid_of(v) } else { None }
        });
    }
    let Some(uuid) = uuid else {
        return Ok(None);
    };

    // 2) resolve the uuid to its (proxied) master playlist, shared with kick_vod_playback below, which does the same for finished VODs
    let Some(proxied) = resolve_kick_video_url(&uuid, &relay).await? else {
        // invalid-looking uuid, 404, or listed but no playable source yet, recording may still be initializing right after stream start. not an error; the frontend can simply not offer DVR this session
        return Ok(None);
    };

    Ok(Some(serde_json::json!({
        // wrapped in the local hls-proxy exactly like the live playlist, so hls.js fetches it CORS-free through the same relay path
        "proxied_vod_url": proxied,
    })))
}

// resolves a Kick video RECORDING uuid to its master playlist, wrapped in the local hls-proxy.
// Ok(None) = uuid malformed, video gone (404), or listed but carrying no playable source (recordings
// right after stream start, or VODs mid-processing). shared by get_kick_live_dvr (in-progress recording) and kick_vod_playback (finished broadcasts), same endpoint, same contract
async fn resolve_kick_video_url(
    uuid: &str,
    relay: &Arc<StreamRelayState>,
) -> Result<Option<String>, String> {
    // the uuid goes into a URL path, validate its shape (hex + dashes) for the same reason channel slugs are validated at every entry point here
    if uuid.is_empty()
        || !uuid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Ok(None);
    }

    let vurl = format!("https://kick.com/api/v1/video/{uuid}");
    let Some(vjson) = fetch_kick_json(&vurl).await? else {
        return Ok(None);
    };
    let Some(source) = vjson
        .get("source")
        .and_then(|v| v.as_str())
        .filter(|s| s.starts_with("http"))
    else {
        return Ok(None);
    };
    Ok(Some(proxied_hls_url(relay, source).await?))
}

// past broadcasts for one channel, the Kick-mode counterpart of get_videos_for_login (main.rs),
// backing the same VODs page. returns a JSON string of vods.js's expected Helix video shape ({id,
// title, created_at, duration, thumbnail_url, view_count}), with id = "kick:<recording uuid>" (the
// prefix routes a card click to the Kick watch path in main.js, and keeps saved VOD progress keys from
// colliding with Twitch's numeric ids) and duration in Helix's "XhYmZs" spelling so vods.js's existing parseDuration/parseDurationToSeconds work unchanged
#[tauri::command]
pub async fn kick_channel_videos(slug: String) -> Result<String, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }
    let url = format!("https://kick.com/api/v2/channels/{slug}/videos");
    let Some(json) = fetch_kick_json(&url).await? else {
        // 404: no such channel -> nothing to list, same clean-empty treatment as a Twitch channel with zero archives
        return Ok("[]".into());
    };
    let vods: Vec<_> = items_of(&json)
        .iter()
        .filter_map(video_entry_to_helix_vod)
        .collect();
    serde_json::to_string(&vods).map_err(|e| e.to_string())
}

// playback URL for one finished Kick VOD, the id is whatever kick_channel_videos put on the card
// ("kick:<uuid>"; a bare uuid is accepted too). errors (rather than returning empty) when there's no playable source, so main.js's watchKickVod shows a real reason instead of a silent black player
#[tauri::command]
pub async fn kick_vod_playback(
    video_id: String,
    relay: tauri::State<'_, Arc<StreamRelayState>>,
) -> Result<String, String> {
    let trimmed = video_id.trim();
    let uuid = trimmed.strip_prefix("kick:").unwrap_or(trimmed);
    match resolve_kick_video_url(uuid, &relay).await? {
        Some(url) => Ok(url),
        None => Err(
            "This Kick VOD has no playable source - it may still be processing, or was deleted."
                .into(),
        ),
    }
}

// normalizes one entry of /api/v2/channels/{slug}/videos (a livestream object with an embedded
// {video: {uuid}}) into the Helix video shape vods.js renders, see kick_channel_videos for the field
// contract. None = skipped: too malformed to render (no recording uuid), or the CURRENTLY-LIVE
// session's in-progress recording, which the listing includes but a past-broadcasts page shouldn't (it's already watchable live; get_kick_live_dvr wants that entry)
fn video_entry_to_helix_vod(v: &serde_json::Value) -> Option<serde_json::Value> {
    let uuid = str_at(v, &["/video/uuid", "/uuid"])?;
    let live = v
        .pointer("/is_live")
        .or_else(|| v.pointer("/livestream/is_live"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if live {
        return None;
    }
    let title = str_at(v, &["/session_title", "/video/session_title", "/title"]).unwrap_or("");
    let created = str_at(v, &["/start_time", "/created_at", "/video/created_at"])
        .map(to_iso_utc)
        .unwrap_or_default();
    // Kick states duration in MILLISECONDS on this listing
    let secs = u64_at(v, &["/duration", "/video/duration"]).unwrap_or(0) / 1000;
    let thumb = str_at(
        v,
        &["/thumbnail/src", "/thumbnail", "/video/thumbnail/src", "/video/thumbnail"],
    )
    .unwrap_or("");
    Some(serde_json::json!({
        "id": format!("kick:{uuid}"),
        "title": title,
        "created_at": created,
        "duration": helix_duration(secs),
        "thumbnail_url": thumb,
        "view_count": u64_at(v, &["/views", "/video/views"]).unwrap_or(0),
        "platform": "kick",
    }))
}

// seconds -> Helix's duration spelling ("3h8m33s" / "45m12s" / "58s"), matching /helix/videos so the frontend's one duration parser covers both platforms
fn helix_duration(total_secs: u64) -> String {
    let h = total_secs / 3600;
    let m = (total_secs % 3600) / 60;
    let s = total_secs % 60;
    if h > 0 {
        format!("{h}h{m}m{s}s")
    } else if m > 0 {
        format!("{m}m{s}s")
    } else {
        format!("{s}s")
    }
}

// GET url and parse the body as JSON. Ok(None) = HTTP 404 (channel doesn't exist), Err = couldn't
// tell (network / Cloudflare / bad JSON). curl first; falls back to reqwest ONLY when curl can't spawn
// (not on PATH). a curl run that spawns but fails (network error, Cloudflare 403, whatever) is a real
// answer about reachability, and reqwest would only do worse against the same Cloudflare, so no second attempt then
async fn fetch_kick_json(url: &str) -> Result<Option<serde_json::Value>, String> {
    match fetch_via_curl(url).await {
        Ok(outcome) => outcome,
        // io::ErrorKind::NotFound from spawn = "curl isn't installed", the one case where trying the other transport makes sense
        Err(spawn_err) if spawn_err.kind() == std::io::ErrorKind::NotFound => {
            fetch_via_reqwest(url).await
        }
        Err(spawn_err) => Err(format!("failed to run curl: {spawn_err}")),
    }
}

// outer Err = curl failed to SPAWN (caller may fall back to reqwest). inner Result/Option = same contract as fetch_kick_json
async fn fetch_via_curl(
    url: &str,
) -> Result<Result<Option<serde_json::Value>, String>, std::io::Error> {
    let mut cmd = tokio::process::Command::new("curl");
    cmd.args([
        "-s",
        // body goes to stdout as usual; then curl appends the HTTP status on its own line. needed because -s swallows errors and plain curl exits 0 even on a 403/404, the status code is how 404 (clean "no such channel") is told apart from 403 (Cloudflare, "couldn't check")
        "-w",
        "\n%{http_code}",
        "--max-time",
        "10",
        "-H",
        "Accept: application/json",
        "-H",
    ]);
    cmd.arg(format!("User-Agent: {BROWSER_UA}"));
    cmd.arg(url);
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // same as every other subprocess in this app (see deps_check.rs): without it, each lookup flashes a console window
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await?; // spawn failure -> outer Err

    Ok((|| {
        if !output.status.success() {
            // -s hides curl's own error text; exit code is all there is. 28 = timeout, 6 = DNS, 7 = connect refused, per curl(1)
            return Err(format!(
                "curl exited with code {:?}",
                output.status.code()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        // split off the status line -w appended after the body
        let (body, code) = stdout
            .rsplit_once('\n')
            .ok_or_else(|| "curl produced no output".to_string())?;
        match code.trim() {
            "404" => return Ok(None),
            "200" => {}
            other => return Err(format!("Kick API returned {other}")),
        }
        let json: serde_json::Value = serde_json::from_str(body)
            .map_err(|e| format!("Kick API returned unparseable JSON: {e}"))?;
        Ok(Some(json))
    })())
}

// the original reqwest transport, kept as the no-curl fallback. expect this to 403 whenever Cloudflare is fingerprinting TLS (see module comment), but on a machine without curl it's the only option, and Cloudflare's strictness has historically come and gone
async fn fetch_via_reqwest(url: &str) -> Result<Option<serde_json::Value>, String> {
    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Kick request failed: {e}"))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None); // no such Kick channel, nothing to fail over to
    }
    if !resp.status().is_success() {
        // 403 here is almost always Cloudflare challenging us rather than a real permission answer, genuinely can't tell
        return Err(format!("Kick API returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .await
        .map(Some)
        .map_err(|e| format!("Kick API returned unparseable JSON: {e}"))
}

// Kick discovery: home / browse / search for the platform toggle.
//
// normalizes Kick's payloads into Helix-shaped objects so the same frontend renderers (home.js,
// browse.js, sidebar.js) work unchanged, platform.js just swaps command names. each object also
// carries platform:"kick" (for click routing) and profile_image_url (Kick embeds avatars, skipping a
// get_users_info call). endpoints are kick.com's own unofficial ones (curl transport, like
// fetch_kick_json): featured-livestreams, stream/livestreams (with subcategory/category filters),
// categories/top, and search. all undocumented, so every extractor tries known field spellings and degrades per-item, schema drift thins the grid, never blanks the app

// minimal percent-encoder for query VALUES (RFC 3986 unreserved set kept literal). no dependency pulled in, the app only encodes short user-typed search strings and category slugs
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// first string found at any of the given JSON pointer paths
fn str_at<'a>(v: &'a serde_json::Value, paths: &[&str]) -> Option<&'a str> {
    paths.iter().find_map(|p| v.pointer(p).and_then(|x| x.as_str()))
}

// first u64 found at any of the given JSON pointer paths
fn u64_at(v: &serde_json::Value, paths: &[&str]) -> Option<u64> {
    paths.iter().find_map(|p| v.pointer(p).and_then(|x| x.as_u64()))
}

// Kick timestamps come as "2023-02-26 01:27:10" (UTC, space-separated) in some payloads and proper ISO in others, normalize to ISO-8601 UTC so anything downstream treating started_at like Helix's works
fn to_iso_utc(ts: &str) -> String {
    if ts.contains('T') {
        ts.to_string()
    } else {
        let mut s = ts.replacen(' ', "T", 1);
        s.push('Z');
        s
    }
}

// normalizes one Kick livestream object (from featured-livestreams or stream/livestreams, both embed a channel) into a Helix-shaped stream. None = item too malformed to render; caller skips it
fn livestream_to_helix(v: &serde_json::Value) -> Option<serde_json::Value> {
    // the channel's slug is the watchable identity, without it a card can't do anything when clicked, so it's the one hard requirement. (/slug alone is NOT a fallback: on livestream objects that's the STREAM's url slug, not the channel's.)
    let login = str_at(v, &["/channel/slug"])?;
    let title = str_at(v, &["/session_title", "/stream_title", "/title"]).unwrap_or("");
    let display =
        str_at(v, &["/channel/user/username", "/channel/user/name"]).unwrap_or(login);
    let viewers = u64_at(v, &["/viewer_count", "/viewers"]).unwrap_or(0);
    let game = str_at(
        v,
        &["/categories/0/name", "/category/name", "/subcategory/name"],
    )
    .unwrap_or("");
    let thumb = str_at(
        v,
        &["/thumbnail/src", "/thumbnail/url", "/thumbnail"],
    )
    .unwrap_or("");
    let avatar = str_at(
        v,
        &[
            "/channel/user/profile_pic",
            "/channel/user/profilepic",
            "/channel/user/profile_picture",
        ],
    )
    .unwrap_or("");
    let started = str_at(v, &["/created_at", "/started_at", "/start_time"]).unwrap_or("");
    let channel_id = u64_at(v, &["/channel/id", "/channel_id"]);

    Some(serde_json::json!({
        // Helix-shaped core, consumed verbatim by the card builders:
        "user_login": login,
        "user_name": display,
        // prefixed so it can never collide with a real Twitch user id in the shared avatars map, and so hydrateAvatars can recognize and exclude it from get_users_info batches
        "user_id": match channel_id {
            Some(id) => format!("kick:{id}"),
            None => format!("kick:{login}"),
        },
        "title": title,
        "viewer_count": viewers,
        "game_name": game,
        // plain URL, no {width}x{height} template, thumbnailUrl()'s replace() calls are no-ops on it, verified in home.js/browse.js
        "thumbnail_url": thumb,
        "type": "live",
        "started_at": if started.is_empty() { String::new() } else { to_iso_utc(started) },
        "is_mature": v.pointer("/is_mature").and_then(|x| x.as_bool()).unwrap_or(false),
        "tags": [],
        // Kick-only extras (see module comment):
        "platform": "kick",
        "profile_image_url": avatar,
    }))
}

// normalizes one Kick subcategory into a Helix game shape ({id, name, box_art_url}). Kick's stable handle for a category is its SLUG (what the livestream-filter endpoint takes), so the slug goes in id, browse.js hands game.id straight back to kick_streams_for_category, like it hands Twitch game ids to get_streams_for_game_id
fn subcategory_to_helix_game(v: &serde_json::Value) -> Option<serde_json::Value> {
    // search results have been seen both flat and wrapped ({document: {...}}, a search-engine hit envelope), unwrap if present
    let v = v.get("document").unwrap_or(v);
    let slug = str_at(v, &["/slug"])?;
    let name = str_at(v, &["/name"]).unwrap_or(slug);
    let banner = str_at(
        v,
        &["/banner/src", "/banner/url", "/banner", "/thumbnail/src", "/thumbnail"],
    )
    .unwrap_or("");
    Some(serde_json::json!({
        "id": slug,
        "name": name,
        "box_art_url": banner,
        "viewers": u64_at(v, &["/viewers", "/viewer_count"]).unwrap_or(0),
        "platform": "kick",
    }))
}

// Kick list payloads arrive either as a bare array or wrapped Laravel-style ({data: [...]}), accept both
fn items_of(json: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(arr) = json.as_array() {
        return arr.clone();
    }
    if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
        return arr.clone();
    }
    Vec::new()
}

fn normalize_streams(json: &serde_json::Value) -> Vec<serde_json::Value> {
    items_of(json).iter().filter_map(livestream_to_helix).collect()
}

// top/featured live streams, Kick-mode counterpart of get_top_live_streams (home carousel/grid + sidebar Top Channels). same contract: a JSON string of a plain Helix-shaped stream array
#[tauri::command]
pub async fn kick_top_live_streams() -> Result<String, String> {
    // Kick has renamed/moved its unofficial endpoints before, and a 404 here previously became a silent
    // "[]", which blanked the entire Kick home feed AND the sidebar's Live Channels list (both fed by this
    // command) while watch/chat kept working off the still-alive /api/v2/channels. so: try the known
    // spellings of the featured feed in order, and fall back to the general live list (the same endpoint
    // Browse pages through, sorted by viewers), visually equivalent for a "top live" rail. first candidate that yields any normalizable streams wins
    const CANDIDATES: [&str; 3] = [
        "https://kick.com/stream/featured-livestreams/en",
        "https://kick.com/api/v2/featured-livestreams/en?limit=40",
        "https://kick.com/stream/livestreams/en?page=1&limit=40&sort=desc",
    ];
    let mut last_err: Option<String> = None;
    for url in CANDIDATES {
        match fetch_kick_json(url).await {
            Ok(Some(json)) => {
                let streams = normalize_streams(&json);
                if !streams.is_empty() {
                    return serde_json::to_string(&streams).map_err(|e| e.to_string());
                }
                // parsed but empty/unrecognizable, try the next spelling
            }
            Ok(None) => {} // 404: endpoint gone, try the next spelling
            Err(e) => last_err = Some(e), // remember, but keep trying
        }
    }
    // every candidate came back empty. if any genuinely errored, surface that (home.js logs it) rather than pretend Kick has zero live channels
    match last_err {
        Some(e) => Err(e),
        None => Ok("[]".into()),
    }
}

// where /stream/livestreams pagination stops being trusted. the endpoints take page= but none of this is documented; if a schema change makes Kick ignore the param, every page returns page 1's content and infinite scroll appends the same cards forever. capping bounds that worst case at a few duplicate screens while leaving normal browsing untouched
const MAX_KICK_PAGES: u32 = 8;

// separate (much higher) cap for the CATEGORIES grid, which pages the full subcategories listing rather than a live-streams feed: Kick has hundreds of categories and "expand fully" is the whole point of that grid, so 8 pages (256 items) would cut it short. the duplicate-loop worst case is additionally bounded on the frontend now (browse.js dedupes appended pages by id and stops after several consecutive empty pages), so a big cap here no longer risks a long visible dupe crawl
const MAX_KICK_CATEGORY_PAGES: u32 = 64;

fn page_from_cursor(cursor: &Option<String>) -> u32 {
    cursor
        .as_deref()
        .and_then(|c| c.parse::<u32>().ok())
        .filter(|&p| p >= 1)
        .unwrap_or(1)
}

// whether a page-numbered listing should advertise another page: a full page suggests more; a short one is the end. next_page_url is checked first when present (Laravel paginators state it outright)
fn next_cursor(
    json: &serde_json::Value,
    got: usize,
    limit: usize,
    page: u32,
    max_pages: u32,
) -> Option<String> {
    if page >= max_pages {
        return None;
    }
    match json.get("next_page_url") {
        Some(v) if v.is_null() => None,
        Some(_) => Some((page + 1).to_string()),
        None if got == limit => Some((page + 1).to_string()),
        None => None,
    }
}

// paged live-streams list, Kick-mode counterpart of get_live_streams_page (Browse's Live Channels tab). cursor is just a stringified page number, opaque to the frontend either way
#[tauri::command]
pub async fn kick_live_streams_page(cursor: Option<String>) -> Result<String, String> {
    let page = page_from_cursor(&cursor);
    let url =
        format!("https://kick.com/stream/livestreams/en?page={page}&limit=32&sort=desc");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok(r#"{"streams":[],"cursor":null}"#.into());
    };
    let streams = normalize_streams(&json);
    let cursor = next_cursor(&json, streams.len(), 32, page, MAX_KICK_PAGES);
    serde_json::to_string(&serde_json::json!({ "streams": streams, "cursor": cursor }))
        .map_err(|e| e.to_string())
}

// appends list into games, skipping any whose id is already in seen (empty ids are always kept, they can't be deduped and dropping them would silently lose categories). merges the ranked top list and the first subcategories page without showing the overlap twice. see kick_top_games
fn push_unique_games(
    list: Vec<serde_json::Value>,
    games: &mut Vec<serde_json::Value>,
    seen: &mut std::collections::HashSet<String>,
) {
    for g in list {
        let id = g.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() || seen.insert(id) {
            games.push(g);
        }
    }
}

// top categories, Kick-mode counterpart of get_top_games (Browse's Categories grid). same envelope:
// {games: [...], cursor}. TWO listings stitched into one cursor walk, because neither alone gives what
// the grid needs:
//   * categories/top is viewer-ranked (the right FIRST screen) but serves only a short fixed list and
//     doesn't genuinely paginate, which is exactly why the grid used to stop after ~2 rows: its short
//     first page read as "end of list" under the full-page-means-more heuristic, so no cursor was
//     handed back and infinite scroll had nothing to walk.
//   * the plain subcategories listing DOES paginate through every category, but isn't viewer-ranked, so
//     it makes a poor first screen alone.
// so: page 1 (cursor null) serves categories/top asking for as much as it gives, then hands back the
// cursor "sub:1", every later page walks the full subcategories listing ("sub:N"). the top categories
// inevitably appear AGAIN in that walk; browse.js dedupes by game id, so the overlap is invisible.
// bare-numeric cursors are still accepted (treated as sub-listing page numbers) so any in-flight cursor from before this change keeps working
#[tauri::command]
pub async fn kick_top_games(cursor: Option<String>) -> Result<String, String> {
    // pages 2+: the full subcategories listing ("sub:N")
    if let Some(cur) = cursor.as_deref() {
        let page = cur
            .strip_prefix("sub:")
            .unwrap_or(cur)
            .parse::<u32>()
            .ok()
            .filter(|&p| p >= 1)
            .unwrap_or(1);
        return kick_subcategories_page(page, None).await;
    }

    // page 1: the viewer-ranked top list, PLUS the first subcategories page merged in. categories/top
    // caps server-side at ~13 no matter the limit asked for, so on its own it makes a sparse first screen
    // (the "browse only shows 13 categories" report). the full walk below has hundreds more, but they used
    // to appear only once the user scrolled. merge the first subcategories page into page 1 so the initial
    // grid is full immediately; dedupe by id so ranked entries that also appear in the sub-listing aren't shown twice. the cursor still hands off to "sub:2", so infinite scroll continues seamlessly
    let mut games: Vec<serde_json::Value> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut last_err: Option<String> = None;
    match fetch_kick_json("https://kick.com/api/v1/categories/top?limit=100").await {
        Ok(Some(json)) => {
            let ranked: Vec<_> = items_of(&json)
                .iter()
                .filter_map(subcategory_to_helix_game)
                .collect();
            push_unique_games(ranked, &mut games, &mut seen_ids);
        }
        Ok(None) => {} // 404: endpoint gone, fall through to sub-listing only
        Err(e) => last_err = Some(e),
    }

    // first subcategories page, merged in behind the ranked entries
    if let Ok(Some(json)) = fetch_kick_json(
        "https://kick.com/api/v1/subcategories?limit=32&page=1",
    ).await {
        let subs: Vec<_> = items_of(&json)
            .iter()
            .filter_map(subcategory_to_helix_game)
            .collect();
        push_unique_games(subs, &mut games, &mut seen_ids);
    }

    if !games.is_empty() {
        // continue the walk from sub:2 (page 1 is already folded in above)
        return serde_json::to_string(
            &serde_json::json!({ "games": games, "cursor": "sub:2" }),
        )
        .map_err(|e| e.to_string());
    }
    // nothing from either source, fall through to the error-surfacing sub-listing path (page 1), same insurance as before
    kick_subcategories_page(1, last_err).await
}

// one page of the full subcategories listing, in kick_top_games' response envelope. carried_err is a categories/top failure to surface if THIS listing also yields nothing (mirrors kick_top_live_streams' don't-pretend-Kick-is-empty error handling)
async fn kick_subcategories_page(
    page: u32,
    carried_err: Option<String>,
) -> Result<String, String> {
    let url = format!("https://kick.com/api/v1/subcategories?limit=32&page={page}");
    let json = match fetch_kick_json(&url).await {
        Ok(Some(j)) => j,
        Ok(None) => {
            return match carried_err {
                Some(e) => Err(e),
                None => Ok(r#"{"games":[],"cursor":null}"#.into()),
            };
        }
        Err(e) => return Err(carried_err.unwrap_or(e)),
    };
    let games: Vec<_> = items_of(&json)
        .iter()
        .filter_map(subcategory_to_helix_game)
        .collect();
    let cursor = next_cursor(&json, games.len(), 32, page, MAX_KICK_CATEGORY_PAGES)
        .map(|p| format!("sub:{p}"));
    serde_json::to_string(&serde_json::json!({ "games": games, "cursor": cursor }))
        .map_err(|e| e.to_string())
}

// live streams for one category, Kick-mode counterpart of get_streams_for_game_id. game_id is the Kick subcategory SLUG, because that's what kick_top_games/kick_search_categories put in the game objects' id (see subcategory_to_helix_game)
#[tauri::command]
pub async fn kick_streams_for_category(game_id: String) -> Result<String, String> {
    let slug = game_id.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid category slug".into());
    }
    let url = format!(
        "https://kick.com/stream/livestreams/en?page=1&limit=32&subcategory={slug}&sort=desc"
    );
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    serde_json::to_string(&normalize_streams(&json)).map_err(|e| e.to_string())
}

// category-by-NAME lookup, Kick-mode counterpart of get_streams_for_game_names, which the frontend
// uses for two things: the Browse pills (IRL / Music / Talk Shows & Podcasts) and the home feed's
// hand-picked RPGs row. the pill names map onto Kick's own top-level category groups (the category=
// filter); anything else, including the entire RPG list (Twitch-category-name-specific), resolves to no
// group and contributes nothing, which the frontend already handles (home.js hides an empty RPGs row; a pill shows "No live channels right now").
//
// live status for a list of Kick channels, powers the sidebar's Following section in Kick mode. Kick's
// real followed-channels endpoint authenticates with the SITE session cookie, which an OAuth app token
// can't produce, so follows are kept locally (kick-follows.js) and this just answers "which of these
// are live right now" by fetching each channel payload. chunked so a long list doesn't spawn dozens of
// curl processes at once; a slug whose lookup fails is omitted (the frontend falls back to its stored name/avatar and renders the row offline)
#[tauri::command]
pub async fn kick_followed_status(slugs: Vec<String>) -> Result<String, String> {
    const MAX_SLUGS: usize = 30;
    const CHUNK: usize = 6;
    let slugs: Vec<String> = slugs
        .into_iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .take(MAX_SLUGS)
        .collect();

    let mut out: Vec<serde_json::Value> = Vec::new();
    for chunk in slugs.chunks(CHUNK) {
        let futs = chunk.iter().map(|slug| async move {
            let url = format!("https://kick.com/api/v2/channels/{slug}");
            match fetch_kick_json(&url).await {
                Ok(Some(json)) => Some(channel_json_to_status(slug, &json)),
                _ => None, // 404 / network / Cloudflare, omit, don't fail the batch
            }
        });
        for item in futures_util::future::join_all(futs).await.into_iter().flatten() {
            out.push(item);
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

fn channel_json_to_status(slug: &str, json: &serde_json::Value) -> serde_json::Value {
    let live = json
        .pointer("/livestream/is_live")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    serde_json::json!({
        "slug": slug,
        "name": str_at(json, &["/user/username", "/user/name"]).unwrap_or(slug),
        "avatar": str_at(
            json,
            &["/user/profile_pic", "/user/profilepic", "/user/profile_picture"],
        )
        .unwrap_or(""),
        "is_live": live,
        "viewer_count": json
            .pointer("/livestream/viewer_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        "game": str_at(
            json,
            &["/livestream/categories/0/name", "/livestream/category/name"],
        )
        .unwrap_or(""),
    })
}

#[tauri::command]
pub async fn kick_streams_for_game_names(game_names: Vec<String>) -> Result<String, String> {
    let group = game_names.iter().find_map(|n| match n.as_str() {
        "IRL" => Some("irl"),
        "Music" => Some("music"),
        // Twitch's pill name and Kick's own label both accepted, plus the plain group word, the frontend's per-platform pill bars (browse.js) send the human labels, not the filter values
        "Talk Shows & Podcasts" | "Creative" => Some("creative"),
        "Gambling" | "Slots & Casino" => Some("gambling"),
        _ => None,
    });
    let Some(group) = group else {
        return Ok("[]".into());
    };
    let url = format!(
        "https://kick.com/stream/livestreams/en?page=1&limit=32&category={group}&sort=desc"
    );
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    serde_json::to_string(&normalize_streams(&json)).map_err(|e| e.to_string())
}

// category search, Kick-mode counterpart of search_categories (the Browse search box). Kick's site search returns several result kinds in one payload; only the categories are wanted here
#[tauri::command]
pub async fn kick_search_categories(query: String) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok("[]".into());
    }
    let url = format!(
        "https://kick.com/api/search?searched_word={}",
        urlencode(q)
    );
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    // categories have been seen at /categories and (search-engine era) under a hits wrapper, try the known spots
    let cats = json
        .pointer("/categories")
        .or_else(|| json.pointer("/categories/hits"))
        .or_else(|| json.pointer("/data/categories"))
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let games: Vec<_> = cats.iter().filter_map(subcategory_to_helix_game).collect();
    serde_json::to_string(&games).map_err(|e| e.to_string())
}

// the channel's native Kick emotes (its own subscriber/channel emotes PLUS Kick's site-wide "Global"
// and "Emoji" sets, which this endpoint bundles in). used by chat: kick_chat.rs flattens inline
// [emote:id:name] tokens to their bare names, and the frontend resolves those back into images through
// its third-party-emote map, but only if the name->image entries exist. this supplies them: a flat
// [{id, name, global}] list the frontend turns into files.kick.com CDN URLs (the id alone determines
// the image). same unofficial-endpoint caveats as everything here; any failure degrades to "native emotes render as text", never an error dialog
#[tauri::command]
pub async fn kick_channel_emotes(slug: String) -> Result<String, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty()
        || !slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid channel slug".into());
    }
    let url = format!("https://kick.com/emotes/{slug}");
    let Some(json) = fetch_kick_json(&url).await? else {
        return Ok("[]".into());
    };
    // payload is an array of emote SETS: the channel's own (id = numeric channel id) plus "Global" and "Emoji"/"Emojis". flatten them, tagging which are site-wide vs channel-specific so the frontend can apply its channel-beats-global precedence
    let mut out: Vec<serde_json::Value> = Vec::new();
    for set in items_of(&json) {
        let is_global = set
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.eq_ignore_ascii_case("global") || s.eq_ignore_ascii_case("emoji") || s.eq_ignore_ascii_case("emojis"))
            .unwrap_or(false);
        let Some(emotes) = set.get("emotes").and_then(|e| e.as_array()) else {
            continue;
        };
        for e in emotes {
            let (Some(id), Some(name)) = (
                e.get("id").and_then(|v| v.as_u64()),
                e.get("name").and_then(|v| v.as_str()),
            ) else {
                continue; // per-item degradation, same as normalize_streams
            };
            out.push(serde_json::json!({ "id": id, "name": name, "global": is_global }));
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

// category viewer counts, Kick-mode counterpart of get_category_viewer_counts. Helix needs a 1000-stream sampling pass; Kick's top-categories payload states viewers outright, so this just reshapes it into the same {game_id: {viewer_count, channel_count}} map browse.js consumes (channel_count isn't in Kick's payload, 0 means "unknown" and the card omits it)
#[tauri::command]
pub async fn kick_category_viewer_counts() -> Result<String, String> {
    let url = "https://kick.com/api/v1/categories/top?limit=60";
    let Some(json) = fetch_kick_json(url).await? else {
        return Ok("{}".into());
    };
    let mut map = serde_json::Map::new();
    for item in items_of(&json) {
        let item = item.get("document").unwrap_or(&item);
        if let Some(slug) = item.get("slug").and_then(|s| s.as_str()) {
            let viewers = u64_at(item, &["/viewers", "/viewer_count"]).unwrap_or(0);
            map.insert(
                slug.to_string(),
                serde_json::json!({ "viewer_count": viewers, "channel_count": 0 }),
            );
        }
    }
    serde_json::to_string(&serde_json::Value::Object(map)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod discovery_tests {
    use super::*;

    // livestream shape as documented for /api/v1/channels and shared by the listing endpoints (channel embedded, space-separated timestamp, thumbnail as object)
    #[test]
    fn normalizes_documented_livestream_shape() {
        let v: serde_json::Value = serde_json::json!({
            "id": 202501,
            "slug": "1b5ac-building-a-kick-bot", // STREAM slug, must NOT become the login
            "session_title": "Building a KICK bot",
            "created_at": "2023-02-26 01:27:10",
            "is_live": true,
            "is_mature": false,
            "viewer_count": 7,
            "thumbnail": { "url": "https://stream.kick.com/thumb.jpg" },
            "categories": [ { "name": "Software Development", "slug": "software-development" } ],
            "channel": {
                "id": 259825,
                "slug": "mattseabrook",
                "user": { "username": "mattseabrook", "profilepic": "https://cdn/pic.webp" }
            }
        });
        let s = livestream_to_helix(&v).expect("should normalize");
        assert_eq!(s["user_login"], "mattseabrook");
        assert_eq!(s["user_id"], "kick:259825");
        assert_eq!(s["title"], "Building a KICK bot");
        assert_eq!(s["viewer_count"], 7);
        assert_eq!(s["game_name"], "Software Development");
        assert_eq!(s["thumbnail_url"], "https://stream.kick.com/thumb.jpg");
        assert_eq!(s["started_at"], "2023-02-26T01:27:10Z");
        assert_eq!(s["platform"], "kick");
        assert_eq!(s["profile_image_url"], "https://cdn/pic.webp");
    }

    #[test]
    fn skips_items_without_channel_slug() {
        let v = serde_json::json!({ "session_title": "orphan", "viewer_count": 5 });
        assert!(livestream_to_helix(&v).is_none());
    }

    // subcategory shape as documented for categories/top (banner object, viewers stated outright)
    #[test]
    fn normalizes_documented_subcategory_shape() {
        let v = serde_json::json!({
            "id": 15,
            "name": "Just Chatting",
            "slug": "just-chatting",
            "banner": { "src": "https://cdn/banner.webp" },
            "viewers": 13447
        });
        let g = subcategory_to_helix_game(&v).expect("should normalize");
        assert_eq!(g["id"], "just-chatting"); // slug IS the id (see fn comment)
        assert_eq!(g["name"], "Just Chatting");
        assert_eq!(g["box_art_url"], "https://cdn/banner.webp");
        assert_eq!(g["viewers"], 13447);
    }

    #[test]
    fn accepts_bare_array_and_data_wrapped_lists() {
        let bare = serde_json::json!([ { "a": 1 } ]);
        let wrapped = serde_json::json!({ "data": [ { "a": 1 }, { "a": 2 } ] });
        assert_eq!(items_of(&bare).len(), 1);
        assert_eq!(items_of(&wrapped).len(), 2);
    }

    #[test]
    fn pagination_cursor_logic() {
        let laravel_more = serde_json::json!({ "next_page_url": "https://..." });
        let laravel_end = serde_json::json!({ "next_page_url": null });
        let bare = serde_json::json!([]);
        assert_eq!(next_cursor(&laravel_more, 32, 32, 1, MAX_KICK_PAGES), Some("2".into()));
        assert_eq!(next_cursor(&laravel_end, 32, 32, 1, MAX_KICK_PAGES), None);
        assert_eq!(next_cursor(&bare, 32, 32, 3, MAX_KICK_PAGES), Some("4".into())); // full page implies more
        assert_eq!(next_cursor(&bare, 10, 32, 3, MAX_KICK_PAGES), None); // short page = the end
        assert_eq!(next_cursor(&laravel_more, 32, 32, MAX_KICK_PAGES, MAX_KICK_PAGES), None); // hard cap
        // the categories walk keeps going well past the live-streams cap (that's the point of its separate, higher limit)...
        assert_eq!(
            next_cursor(&laravel_more, 32, 32, MAX_KICK_PAGES, MAX_KICK_CATEGORY_PAGES),
            Some((MAX_KICK_PAGES + 1).to_string())
        );
        // ...but still has its own ceiling
        assert_eq!(
            next_cursor(&laravel_more, 32, 32, MAX_KICK_CATEGORY_PAGES, MAX_KICK_CATEGORY_PAGES),
            None
        );
    }

    #[test]
    fn helix_duration_spellings() {
        assert_eq!(helix_duration(11_313), "3h8m33s");
        assert_eq!(helix_duration(2_712), "45m12s");
        assert_eq!(helix_duration(58), "58s");
        assert_eq!(helix_duration(3_600), "1h0m0s");
        assert_eq!(helix_duration(0), "0s");
    }

    #[test]
    fn normalizes_channel_video_entry() {
        // the documented /api/v2/channels/{slug}/videos entry shape: a livestream object with the recording embedded as {video:{uuid}}, duration in milliseconds, and a space-separated start_time
        let v = serde_json::json!({
            "id": 555,
            "session_title": "late night grind",
            "start_time": "2026-07-10 20:00:00",
            "duration": 11_313_000u64,
            "is_live": false,
            "views": 4321,
            "thumbnail": { "src": "https://cdn/thumb.webp" },
            "video": { "uuid": "abc-123-def" }
        });
        let out = video_entry_to_helix_vod(&v).expect("should normalize");
        assert_eq!(out["id"], "kick:abc-123-def");
        assert_eq!(out["title"], "late night grind");
        assert_eq!(out["created_at"], "2026-07-10T20:00:00Z");
        assert_eq!(out["duration"], "3h8m33s");
        assert_eq!(out["thumbnail_url"], "https://cdn/thumb.webp");
        assert_eq!(out["view_count"], 4321);
        assert_eq!(out["platform"], "kick");
    }

    #[test]
    fn channel_video_entry_skips_live_and_uuidless() {
        // the currently-live session's in-progress recording is listed too, a past-broadcasts page must not show it
        let live = serde_json::json!({
            "session_title": "LIVE now",
            "is_live": true,
            "video": { "uuid": "live-uuid" }
        });
        assert!(video_entry_to_helix_vod(&live).is_none());
        // no recording uuid = nothing playable to offer
        let no_uuid = serde_json::json!({ "session_title": "broken", "is_live": false });
        assert!(video_entry_to_helix_vod(&no_uuid).is_none());
    }

    #[test]
    fn urlencode_basics() {
        assert_eq!(urlencode("just chatting"), "just%20chatting");
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(urlencode("50% & more"), "50%25%20%26%20more");
    }
}
