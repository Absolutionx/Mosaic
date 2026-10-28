//! Clipping a chosen part of a broadcast (the clip panel's "Choose a part", clips.js): a 5-60 second range of a
//! VOD, or of the recording Twitch is making of a live stream (what live rewind plays), anywhere in it rather
//! than only the last seconds of the live edge (helix.rs create_clip). Twitch's own player does the same in
//! two steps, with the Twitch connection's login (twitch_device_auth.rs):
//!   createClip  { broadcasterID, videoID, offsetSeconds }  makes a clip around that point of the recording
//!   publishClip { slug, title, segments: [{ offsetSeconds, durationSeconds, speed }] }  sets its exact range
//! Checked 10-26-26 on a live channel: createClip at 9900 made a 30 s clip from 9890. The clip is read back
//! at the end, so the panel shows what Twitch actually made, never just what was asked for.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

const GQL_URL: &str = "https://gql.twitch.tv/gql";
const MIN_LEN: f64 = 5.0;
const MAX_LEN: f64 = 60.0;

#[derive(Serialize)]
pub struct RangeClip {
    pub slug: String,
    pub url: String,
    pub channel: String,
    pub title: String,
    /// where the finished clip starts in the recording, and how long it is, as Twitch reports them
    pub offset: Option<f64>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    /// set when the clip was made but the exact range or title couldn't be applied (it's still a clip)
    pub note: Option<String>,
}

async fn gql(token: &str, body: Value) -> Result<Value, String> {
    let res = crate::http::client()
        .post(GQL_URL)
        .header("Client-Id", crate::twitch_device_auth::device_client_id())
        .header("Authorization", format!("OAuth {token}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Twitch: {e}"))?;
    let status = res.status();
    let v: Value = res.json().await.map_err(|_| "Twitch sent an answer Mosaic couldn't read.".to_string())?;
    if !status.is_success() {
        return Err(format!("Twitch refused the request ({}).", status.as_u16()));
    }
    Ok(v)
}

fn gql_error(v: &Value) -> Option<String> {
    v.get("errors")?.as_array()?.first()?.get("message")?.as_str().map(str::to_string)
}

/// the first point of the default clip createClip makes is 10 s before the offset it's given (it makes
/// [offset - 10, offset + 20]), so this centers that window on the chosen range: a range of 30 s or less fits
/// it exactly even if Twitch then ignores the trim
pub fn create_offset(start: f64, duration: f64) -> f64 {
    (start + duration / 2.0 - 5.0).max(0.0)
}

/// a requested range made valid: 5-60 s long, starting at 0 or later
pub fn clean_range(start: f64, duration: f64) -> Option<(f64, f64)> {
    if !start.is_finite() || !duration.is_finite() {
        return None;
    }
    let d = duration.clamp(MIN_LEN, MAX_LEN);
    let s = start.max(0.0);
    Some(((s * 10.0).round() / 10.0, (d * 10.0).round() / 10.0))
}

#[tauri::command]
pub async fn create_clip_range(
    app: AppHandle,
    video_id: String,
    start: f64,
    duration: f64,
    title: Option<String>,
) -> Result<RangeClip, String> {
    if video_id.is_empty() || video_id.len() > 20 || !video_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("This stream has no Twitch recording to clip from.".into());
    }
    let (start, duration) = clean_range(start, duration).ok_or("Pick a part to clip first.")?;
    let title: Option<String> = title
        .map(|t| t.trim().chars().take(100).collect::<String>())
        .filter(|t| !t.is_empty());
    let token = crate::twitch_device_auth::get_device_token(&app)
        .await
        .ok_or("Choosing a part needs the Twitch connection (Settings › Twitch account › Twitch connection).")?;

    // whose recording it is, and how much of it exists yet (a live stream's recording trails the live edge)
    let v = gql(&token, json!({
        "query": "query($id: ID!) { video(id: $id) { lengthSeconds status owner { id login } } }",
        "variables": { "id": video_id },
    }))
    .await?;
    let video = v.pointer("/data/video").filter(|x| !x.is_null()).ok_or("Twitch couldn't find this stream's recording.")?;
    let owner_id = video.pointer("/owner/id").and_then(Value::as_str).ok_or("Twitch couldn't find this stream's recording.")?.to_string();
    let channel = video.pointer("/owner/login").and_then(Value::as_str).unwrap_or("").to_string();
    let length = video.get("lengthSeconds").and_then(Value::as_f64).unwrap_or(0.0);
    if length > 0.0 && start + duration > length + 1.0 {
        return Err("Twitch hasn't saved that part of the stream yet (its recording runs a little behind live). Pick an earlier part, or try again in a minute.".into());
    }

    // 1. make the clip around the chosen part
    let v = gql(&token, json!({
        "query": "mutation($input: CreateClipInput!) { createClip(input: $input) { clip { slug } error { code } } }",
        "variables": { "input": { "broadcasterID": owner_id, "videoID": video_id, "offsetSeconds": create_offset(start, duration) } },
    }))
    .await?;
    if let Some(e) = gql_error(&v) {
        return Err(format!("Twitch didn't make the clip: {e}"));
    }
    if let Some(code) = v.pointer("/data/createClip/error/code").and_then(Value::as_str) {
        return Err(match code {
            "CLIPPING_DISABLED" | "CHANNEL_CLIPPING_DISABLED" => "This channel has turned clipping off.".into(),
            "RATE_LIMITED" | "TOO_MANY_REQUESTS" => "Twitch says you're clipping too fast. Wait a moment and try again.".into(),
            other => format!("Twitch didn't make the clip ({other})."),
        });
    }
    let slug = v.pointer("/data/createClip/clip/slug").and_then(Value::as_str).ok_or("Twitch didn't make the clip.")?.to_string();

    // 2. set its exact range and title. a brand-new clip can take a moment before it accepts edits, so this
    // retries for a little while; if it never does, the clip still exists (around the chosen part)
    let mut input = json!({ "slug": slug, "segments": [{ "offsetSeconds": start, "durationSeconds": duration, "speed": 1.0 }] });
    if let Some(t) = &title {
        input["title"] = json!(t);
    }
    let publish = json!({
        "query": "mutation($input: PublishClipInput!) { publishClip(input: $input) { clip { slug } error { __typename } } }",
        "variables": { "input": input },
    });
    let mut publish_problem: Option<String> = None;
    for attempt in 0..8 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        }
        match gql(&token, publish.clone()).await {
            Ok(v) => {
                if let Some(e) = gql_error(&v) {
                    // a request Twitch can't read won't get better by asking again
                    let fatal = e.starts_with("Cannot query field") || e.contains("is not defined by type") || e.contains("of required type");
                    publish_problem = Some(e);
                    if fatal { break; }
                    continue;
                }
                // Twitch's errors here are typed objects: the type's name says what went wrong (10-26-26 its
                // PublishClipError has no "code" field, and asking for one failed the whole request)
                if let Some(kind) = v.pointer("/data/publishClip/error/__typename").and_then(Value::as_str) {
                    publish_problem = Some(kind.to_string());
                    continue;
                }
                publish_problem = None;
                break;
            }
            Err(e) => publish_problem = Some(e),
        }
    }

    // 3. what Twitch actually made (the rendered clip can take a few seconds more; clips.js keeps polling)
    let mut out = RangeClip {
        url: format!("https://clips.twitch.tv/{slug}"),
        slug: slug.clone(),
        channel,
        title: title.clone().unwrap_or_default(),
        offset: None,
        duration: None,
        thumbnail: None,
        note: None,
    };
    // a new clip reads as 0 s long while Twitch processes it, and a trimmed one keeps its first length until
    // the trim is processed too: read it again for up to ~25 s, until it has a length (the asked-for one, ideally)
    let exact = |o: Option<f64>, d: Option<f64>| matches!((o, d), (Some(o), Some(d)) if (o - start).abs() <= 1.5 && (d - duration).abs() <= 1.5);
    for attempt in 0..13 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        }
        let Ok(v) = gql(&token, json!({
            "query": "query($slug: ID!) { clip(slug: $slug) { title durationSeconds videoOffsetSeconds thumbnailURL } }",
            "variables": { "slug": slug },
        }))
        .await
        else { continue };
        let Some(c) = v.pointer("/data/clip").filter(|x| !x.is_null()) else { continue };
        out.title = c.get("title").and_then(Value::as_str).unwrap_or(&out.title).to_string();
        out.offset = c.get("videoOffsetSeconds").and_then(Value::as_f64);
        out.duration = c.get("durationSeconds").and_then(Value::as_f64).filter(|d| *d > 0.0);
        out.thumbnail = c.get("thumbnailURL").and_then(Value::as_str).map(str::to_string);
        if exact(out.offset, out.duration) || (publish_problem.is_some() && out.duration.is_some()) {
            break;
        }
    }
    if let Some(problem) = &publish_problem {
        // Twitch's own words, so it's clear what it refused
        out.note = Some(format!("Twitch made the clip around the part you picked, but didn't accept the exact range{}: {problem}. Trim it with Edit on Twitch.",
            if title.is_some() { " and title" } else { "" }));
    } else if let (Some(_), Some(d)) = (out.offset, out.duration) {
        if !exact(out.offset, out.duration) {
            out.note = Some(format!("Twitch made a {}s clip instead of the exact range you picked. Trim it with Edit on Twitch.", d.round()));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_cleaned() {
        assert_eq!(clean_range(100.04, 30.0), Some((100.0, 30.0)));
        assert_eq!(clean_range(-5.0, 2.0), Some((0.0, 5.0)));
        assert_eq!(clean_range(10.0, 300.0), Some((10.0, 60.0)));
        assert_eq!(clean_range(f64::NAN, 30.0), None);
    }

    #[test]
    fn default_window_covers_short_ranges() {
        // createClip makes [o - 10, o + 20]; a 30 s range should be exactly that window
        let o = create_offset(9890.0, 30.0);
        assert_eq!((o - 10.0, o + 20.0), (9890.0, 9920.0));
        // a 10 s range sits inside it
        let o = create_offset(500.0, 10.0);
        assert!(o - 10.0 <= 500.0 && o + 20.0 >= 510.0);
        // never before the start of the recording
        assert!(create_offset(0.0, 5.0) >= 0.0);
    }
}
