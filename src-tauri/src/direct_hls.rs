//! Twitch playback without streamlink (Android, where streamlink and ffmpeg can't run). The playback token comes
//! from Twitch's web GQL and the playlist from usher, the same quick route the hover previews use
//! (stream_relay.rs get_live_preview_url / get_vod_preview_url); this picks one quality out of that playlist, the
//! way streamlink does for a quality name like "720p60,720p,best". stream_relay.rs's playlist and quality commands
//! use it on Android; desktop keeps streamlink.

/// one quality in a master playlist: its name as streamlink spells it ("1080p60", "720p30", "audio_only"),
/// its playlist URL and bandwidth (bits per second, to order them)
#[derive(Debug, Clone, PartialEq)]
pub struct Variant {
    pub name: String,
    pub url: String,
    pub bandwidth: u64,
}

// an attribute's value in an #EXT-X tag's attribute list: NAME="720p60" or BANDWIDTH=1234
fn attr<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = line.split_once(':')?.1;
    while !rest.is_empty() {
        let (k, after) = rest.split_once('=')?;
        let k = k.trim().trim_start_matches(',');
        let (value, next) = if let Some(quoted) = after.strip_prefix('"') {
            let end = quoted.find('"')?;
            (&quoted[..end], quoted[end + 1..].trim_start_matches(','))
        } else {
            match after.find(',') {
                Some(i) => (&after[..i], &after[i + 1..]),
                None => (after, ""),
            }
        };
        if k.eq_ignore_ascii_case(key) {
            return Some(value);
        }
        rest = next;
    }
    None
}

// "1080p60 (source)" -> "1080p60"; Twitch marks the original quality that way, streamlink drops it
fn clean_name(name: &str) -> String {
    name.split(" (").next().unwrap_or(name).trim().to_string()
}

// a relative URI against the master playlist's URL
fn resolve(base: &str, uri: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return uri.to_string();
    }
    match base.rfind('/') {
        Some(i) => format!("{}{}", &base[..=i], uri.trim_start_matches('/')),
        None => uri.to_string(),
    }
}

/// the qualities in a Twitch master playlist. Names come from the #EXT-X-MEDIA tag of the stream's video group
/// (as streamlink names them), falling back to the group id and then to the resolution
pub fn parse_master(text: &str, base_url: &str) -> Vec<Variant> {
    let mut names: Vec<(String, String)> = Vec::new(); // group id -> name
    for line in text.lines() {
        if line.starts_with("#EXT-X-MEDIA:") {
            if let (Some(group), Some(name)) = (attr(line, "GROUP-ID"), attr(line, "NAME")) {
                names.push((group.to_string(), clean_name(name)));
            }
        }
    }
    let mut out = Vec::new();
    let mut pending: Option<(String, u64)> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("#EXT-X-STREAM-INF:") {
            let bandwidth = attr(line, "BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0);
            let group = attr(line, "VIDEO").unwrap_or("");
            let name = names
                .iter()
                .find(|(g, _)| g == group)
                .map(|(_, n)| n.clone())
                .filter(|n| !n.is_empty())
                .or_else(|| (!group.is_empty() && group != "chunked").then(|| group.to_string()))
                .or_else(|| {
                    let height = attr(line, "RESOLUTION")?.split('x').nth(1)?.to_string();
                    let fps = attr(line, "FRAME-RATE").and_then(|f| f.parse::<f64>().ok()).map(|f| f.round() as u32);
                    Some(match fps { Some(f) if f > 30 => format!("{height}p{f}"), _ => format!("{height}p") })
                })
                .unwrap_or_else(|| "source".to_string());
            pending = Some((name, bandwidth));
        } else if !line.is_empty() && !line.starts_with('#') {
            if let Some((name, bandwidth)) = pending.take() {
                out.push(Variant { name, url: resolve(base_url, line), bandwidth });
            }
        }
    }
    out
}

/// the variant for a quality wish like "720p60,720p,best": the first entry that exists wins. "best" and
/// "worst" are the highest and lowest bandwidth; "720p" also matches "720p30" / "720p60" (the higher one)
pub fn pick<'a>(variants: &'a [Variant], spec: &str) -> Option<&'a Variant> {
    let video: Vec<&Variant> = variants.iter().filter(|v| v.name != "audio_only").collect();
    for want in spec.split(',').map(str::trim).filter(|w| !w.is_empty()) {
        let found = match want {
            "best" => video.iter().max_by_key(|v| v.bandwidth).copied(),
            "worst" => video.iter().min_by_key(|v| v.bandwidth).copied(),
            "audio_only" => variants.iter().find(|v| v.name == "audio_only"),
            _ => variants.iter().find(|v| v.name == want).or_else(|| {
                video
                    .iter()
                    .filter(|v| v.name.strip_prefix(want).is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())))
                    .max_by_key(|v| v.bandwidth)
                    .copied()
            }),
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// the quality names, lowest first, as streamlink lists them
pub fn names_ascending(variants: &[Variant]) -> Vec<String> {
    let mut v: Vec<&Variant> = variants.iter().collect();
    v.sort_by_key(|x| x.bandwidth);
    let mut out: Vec<String> = Vec::new();
    for x in v {
        if !out.contains(&x.name) {
            out.push(x.name.clone());
        }
    }
    out
}

/// fetch a master playlist and read its qualities
pub async fn fetch_variants(master_url: &str) -> Result<Vec<Variant>, String> {
    let resp = crate::http::client()
        .get(master_url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Twitch: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Couldn't read Twitch's playlist: {e}"))?;
    if !status.is_success() {
        // usher answers 404 for an offline channel and 403 for sub-only content
        return Err(match status.as_u16() {
            404 => "The channel is offline.".into(),
            403 => "Twitch won't play this without a login that can watch it (sub-only?).".into(),
            s => format!("Twitch refused the playlist ({s})."),
        });
    }
    let variants = parse_master(&text, master_url);
    if variants.is_empty() {
        return Err("Twitch sent a playlist with no qualities in it.".into());
    }
    Ok(variants)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = r#"#EXTM3U
#EXT-X-TWITCH-INFO:NODE="video-edge",CLUSTER="sea02"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://video-weaver.sea02.hls.ttvnw.net/v1/playlist/source.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://video-weaver.sea02.hls.ttvnw.net/v1/playlist/720p60.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="480p30",NAME="480p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=852x480,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="480p30",FRAME-RATE=30.000
480p30.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="160p30",NAME="160p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="160p30",FRAME-RATE=30.000
https://video-weaver.sea02.hls.ttvnw.net/v1/playlist/160p30.m3u8
"#;

    #[test]
    fn reads_twitch_master_playlists() {
        let v = parse_master(MASTER, "https://usher.ttvnw.net/api/channel/hls/x.m3u8");
        assert_eq!(v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["1080p60", "720p60", "480p", "160p"]);
        assert_eq!(v[2].url, "https://usher.ttvnw.net/api/channel/hls/480p30.m3u8");
        assert_eq!(names_ascending(&v), ["160p", "480p", "720p60", "1080p60"]);
    }

    #[test]
    fn picks_like_streamlink() {
        let v = parse_master(MASTER, "https://u/x.m3u8");
        assert_eq!(pick(&v, "best").unwrap().name, "1080p60");
        assert_eq!(pick(&v, "worst").unwrap().name, "160p");
        assert_eq!(pick(&v, "720p60,720p,best").unwrap().name, "720p60");
        assert_eq!(pick(&v, "720p").unwrap().name, "720p60"); // 720p matches 720p60
        assert_eq!(pick(&v, "900p,480p,best").unwrap().name, "480p");
        assert_eq!(pick(&v, "900p").map(|x| &x.name), None);
        assert_eq!(pick(&v, "360p30,360p,480p30,480p,worst").unwrap().name, "480p");
    }

    #[test]
    fn names_without_media_tags() {
        let text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1280x720,FRAME-RATE=60.0\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300,RESOLUTION=640x360,FRAME-RATE=30.0\nb.m3u8\n";
        let v = parse_master(text, "https://h/p/m.m3u8");
        assert_eq!(v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["720p60", "360p"]);
        assert_eq!(v[1].url, "https://h/p/b.m3u8");
    }
}
