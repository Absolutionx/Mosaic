// link-hover previews for chat URLs. in Rust because a cross-origin webview fetch() usually can't
// read the response body (no CORS headers), while a plain reqwest GET has no CORS concept and can.
// scans the first chunk of markup with a small regex for og:title/description/image rather than
// pulling in an HTML parser for a non-critical feature

use serde::Serialize;

// OG/Twitter Card meta tags and <title> are always in <head>, near the top, so this covers them
// without ever downloading a multi-megabyte body for a hover preview
const LINK_PREVIEW_MAX_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
pub struct LinkPreview {
    url: String,
    title: Option<String>,
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
}

// returns a LinkPreview with all-None fields rather than erroring if the page has none, chat.js
// treats "no useful fields" as "don't show a popup", same as a fetch error
#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreview, String> {
    // chat.js's URL regex shouldn't produce anything else, but this is the actual network boundary, so it's the right place to be defensive about the scheme
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Refusing to fetch non-http(s) URL".to_string());
    }

    // a link in chat is picked by a stranger. hovering it must not make this computer send a request to
    // itself or to something on the local network (a router's address, say), directly or via a redirect
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if is_local_target(&parsed) {
        return Err("Refusing to fetch a local address".to_string());
    }

    let response = preview_client()?
        .get(&url)
        // several sites (X/Twitter especially) serve fuller (sometimes the only) metadata to User-Agents
        // they recognize as link-unfurling bots (Discordbot, Twitterbot, ...), and otherwise serve a JS app
        // shell with little in the raw HTML. our old made-up UA matched neither "known bot" nor "real
        // browser", the leading explanation for it working on some posts and not others. mimicking a widely-recognized previewer (Discord's) is the standard fix
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }

    // bytes() on a reqwest Response downloads everything before returning, so stream chunks instead and stop early once we have enough for the <head> metadata
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(LINK_PREVIEW_MAX_BYTES.min(64 * 1024));
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
        if buf.len() >= LINK_PREVIEW_MAX_BYTES {
            break;
        }
    }

    // lossy is fine, we're regex-scanning for ASCII attribute markers; mangled multi-byte text inside an extracted value is a cosmetic edge case in a hover preview, not worth a hard failure
    let html = String::from_utf8_lossy(&buf);

    // Open Graph first, falling back to Twitter Card tags (twitter:title etc.) for sites (X/Twitter
    // posts being the motivating case) that don't consistently populate both families. some posts set
    // only one, so checking only og:* left some previews empty even with good twitter:* tags right next to them
    let title = extract_meta(&html, "og:title")
        .or_else(|| extract_meta(&html, "twitter:title"))
        .or_else(|| extract_title_tag(&html));
    let description = extract_meta(&html, "og:description")
        .or_else(|| extract_meta(&html, "twitter:description"))
        .or_else(|| extract_meta_name(&html, "description"));
    let image = extract_meta(&html, "og:image")
        .or_else(|| extract_meta(&html, "twitter:image"))
        .or_else(|| extract_meta(&html, "twitter:image:src"));
    let site_name = extract_meta(&html, "og:site_name")
        .or_else(|| extract_meta(&html, "twitter:site"));

    Ok(LinkPreview {
        url,
        title: title.map(|s| decode_html_entities(&s)),
        description: description.map(|s| decode_html_entities(&s)),
        // the page loads this image itself, so the same rule as the fetch: https, and not this computer or
        // the local network (a page could otherwise point the image at a device on your network)
        image: image.map(|s| decode_html_entities(&s)).filter(|i| safe_image_url(i)),
        site_name: site_name.map(|s| decode_html_entities(&s)),
    })
}

// one client for every hover (it keeps connections, so a second preview from the same site skips the
// TLS handshake). its DNS step only ever hands back public addresses, so a public name that resolves to
// this computer or the local network is refused too, for the first request and every redirect
fn preview_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .dns_resolver(std::sync::Arc::new(PublicOnlyResolver))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if is_local_target(attempt.url()) {
                attempt.stop() // the redirect itself becomes the (non-success) answer
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

// resolves like the system does, then drops every local/private address; a name with only those fails
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let found = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let public: Vec<std::net::SocketAddr> = public_addrs(found);
            if public.is_empty() {
                return Err(format!("{host} resolves only to local addresses").into());
            }
            Ok(Box::new(public.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn public_addrs(found: impl Iterator<Item = std::net::SocketAddr>) -> Vec<std::net::SocketAddr> {
    found.filter(|a| !is_local_ip(a.ip())).collect()
}

// true for URLs that point at this computer or the local network: loopback, private, link-local and
// carrier-NAT addresses, and names that only resolve locally. this checks what the URL says; a public name
// that resolves to a private address is caught one step later, by PublicOnlyResolver
fn is_local_target(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return true };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return is_local_ip(ip);
    }
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    name == "localhost"
        || !name.contains('.')
        || [".localhost", ".local", ".lan", ".internal", ".home.arpa"].iter().any(|s| name.ends_with(s))
}

fn is_local_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast()
                || v4.is_multicast()
                || o[0] == 0                                  // 0.0.0.0/8, "this network": can reach this computer
                || (o[0] == 100 && (o[1] & 0xC0) == 64)       // 100.64.0.0/10, carrier-grade NAT
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)    // 192.0.0.0/24, protocol assignments
                || (o[0] == 198 && (o[1] & 0xFE) == 18)       // 198.18.0.0/15, benchmarking
                || o[0] >= 240                                // 240.0.0.0/4, reserved
        }
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments();
            let first = seg[0];
            // an IPv4 address carried inside IPv6 is judged as that IPv4 address
            let embedded_v4 = |a: u16, b: u16| {
                std::net::Ipv4Addr::new((a >> 8) as u8, a as u8, (b >> 8) as u8, b as u8)
            };
            v6.is_loopback() || v6.is_unspecified() || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00 // fc00::/7, unique local
                || (first & 0xffc0) == 0xfe80 // fe80::/10, link-local
                || v6.to_ipv4_mapped().map(|v4| is_local_ip(std::net::IpAddr::V4(v4))).unwrap_or(false)
                // 64:ff9b::/96, NAT64: the last 32 bits are an IPv4 address
                || (seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0]
                    && is_local_ip(std::net::IpAddr::V4(embedded_v4(seg[6], seg[7]))))
                // ::a.b.c.d, the old IPv4-compatible form
                || (seg[..6] == [0, 0, 0, 0, 0, 0] && is_local_ip(std::net::IpAddr::V4(embedded_v4(seg[6], seg[7]))))
        }
    }
}

// finds <meta property="og:X" content="..."> (or content-then-property order, both occur) and returns the content value. tolerant of attribute order/whitespace/quote style, since this scans real-world HTML
fn extract_meta(html: &str, property: &str) -> Option<String> {
    find_meta_content(html, "property", property)
        .or_else(|| find_meta_content(html, "name", property))
}

fn extract_meta_name(html: &str, name: &str) -> Option<String> {
    find_meta_content(html, "name", name)
}

// scans for the first <meta> whose `attr` equals `value` (case-insensitive, since some sites emit "OG:Title"), then pulls that tag's content attribute regardless of attribute order.
// linear in the page size, whatever the page: both quote styles are searched once each (the next hit of
// each is remembered, not searched again from scratch every round), the walk to a tag's '<' and '>' only
// looks within TAG_WINDOW bytes, and at most MAX_MATCHES candidates are tried. a page built to be slow
// (hundreds of KB of matching attributes with no content) took over 10 seconds of CPU per hover before
fn find_meta_content(html: &str, attr: &str, value: &str) -> Option<String> {
    const TAG_WINDOW: usize = 4096;
    const MAX_MATCHES: usize = 64;
    let lower = html.to_ascii_lowercase();
    let needle = format!("{attr}=\"{}\"", value.to_ascii_lowercase());
    let needle_alt = format!("{attr}='{}'", value.to_ascii_lowercase());
    let find_from = |n: &str, from: usize| lower.get(from..).and_then(|rest| rest.find(n)).map(|i| from + i);
    let (mut next_d, mut next_s) = (find_from(&needle, 0), find_from(&needle_alt, 0));
    for _ in 0..MAX_MATCHES {
        let match_pos = match (next_d, next_s) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => break,
        };
        // this tag's '<' (looking back) and '>' (looking ahead), both within the window
        let back_from = floor_boundary(&lower, match_pos.saturating_sub(TAG_WINDOW));
        let tag_start = lower[back_from..match_pos].rfind('<').map(|i| back_from + i).unwrap_or(back_from);
        let ahead_to = ceil_boundary(&lower, (match_pos + TAG_WINDOW).min(lower.len()));
        let tag_end = lower[match_pos..ahead_to].find('>').map(|i| match_pos + i).unwrap_or(ahead_to);
        if let Some(content) = extract_attr(&html[tag_start..tag_end], "content") {
            if !content.trim().is_empty() {
                return Some(content.trim().to_string());
            }
        }
        // past this tag; refresh whichever remembered hit is now behind us
        let next = ceil_boundary(&lower, (tag_end + 1).min(lower.len()));
        if next >= lower.len() {
            break;
        }
        if next_d.is_some_and(|p| p < next) { next_d = find_from(&needle, next); }
        if next_s.is_some_and(|p| p < next) { next_s = find_from(&needle_alt, next); }
    }
    None
}

// nearest char boundary at or below / at or above i (slicing mid-codepoint panics)
fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) { i -= 1; }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) { i += 1; }
    i.min(s.len())
}

// pulls attr="value" or attr='value' out of a single tag's raw text
fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    for (quote, needle) in [('"', format!("{attr}=\"")), ('\'', format!("{attr}='"))] {
        if let Some(start) = lower.find(&needle) {
            let value_start = start + needle.len();
            if let Some(end_rel) = tag[value_start..].find(quote) {
                return Some(tag[value_start..value_start + end_rel].to_string());
            }
        }
    }
    None
}

// fallback for pages with no og:title: plain <title>...</title>
fn extract_title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</title>")? + open_end;
    let text = html[open_end..close].trim();
    if text.is_empty() { None } else { Some(text.to_string()) }
}

// minimal entity decoding for the handful that actually show up in titles/descriptions, not a full entity table, just enough that "Foo &amp; Bar" renders as "Foo & Bar"
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn safe_image_url(u: &str) -> bool {
    u.starts_with("https://") && reqwest::Url::parse(u).map(|p| !is_local_target(&p)).unwrap_or(false)
}

// fetches arbitrary JSON server-side to work around CORS, added for VOD storyboard (seek-preview
// thumbnail) metadata, whose CDN (cloudfront.net) doesn't send an Access-Control-Allow-Origin header
// for this app's webview origin. reqwest has no CORS concept (it isn't a browser), so this sidesteps
// the restriction the same way fetch_link_preview does. scoped to https:// only and NOT a
// general-purpose proxy; acceptable here because this is a desktop app: whoever can edit the frontend to call this already has the same access as this backend
#[tauri::command]
pub async fn fetch_storyboard_json(url: String) -> Result<String, String> {
    // only Twitch's own storyboard hosts, and at most STORYBOARD_MAX_BYTES: this used to fetch any https
    // URL of any size (including addresses on the local network)
    if !storyboard_host_ok(&url) {
        return Err("Refusing to fetch a non-Twitch storyboard URL".to_string());
    }
    let response = preview_client()?
        .get(&url)
        // Twitch's storyboard CDN (cloudfront.net) has been seen to 403 without this, a real yt-dlp issue reported the same, suggesting it checks Referer and rejects requests that don't look like twitch.tv
        .header("Referer", "https://www.twitch.tv/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }
    const STORYBOARD_MAX_BYTES: usize = 2 * 1024 * 1024;
    use futures_util::StreamExt;
    let mut body = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = body.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        if buf.len() > STORYBOARD_MAX_BYTES {
            return Err("storyboard too large".to_string());
        }
    }
    String::from_utf8(buf).map_err(|e| e.to_string())
}

// https, on a Twitch storyboard host (the CDN Twitch serves them from, or Twitch's own domains)
fn storyboard_host_ok(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    if u.scheme() != "https" { return false; }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    ["cloudfront.net", "twitch.tv", "jtvnw.net", "ttvnw.net", "twitchcdn.net"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

#[cfg(test)]
mod preview_resolver_tests {
    use super::{public_addrs, PublicOnlyResolver};
    use reqwest::dns::Resolve;

    #[test]
    fn more_local_ranges_are_local() {
        for ip in [
            "0.1.2.3", "198.18.0.1", "198.19.255.255", "224.0.0.1", "240.0.0.1", "192.0.0.8",
            "ff02::1", "64:ff9b::192.168.1.1", "64:ff9b::7f00:1", "::127.0.0.1", "::ffff:10.0.0.1",
        ] {
            assert!(super::is_local_ip(ip.parse().unwrap()), "{ip} should count as local");
        }
        for ip in ["8.8.8.8", "198.20.0.1", "64:ff9b::808:808", "2606:4700::1111"] {
            assert!(!super::is_local_ip(ip.parse().unwrap()), "{ip} should count as public");
        }
    }

    #[test]
    fn private_addresses_are_dropped() {
        let addrs = ["127.0.0.1:0", "10.1.2.3:0", "192.168.1.1:0", "172.16.0.5:0", "169.254.1.1:0", "100.64.0.1:0",
            "[::1]:0", "[fd00::1]:0", "[fe80::1]:0", "[::ffff:192.168.0.1]:0", "93.184.216.34:0", "[2606:4700::1111]:0"]
            .iter().map(|a| a.parse().unwrap()).collect::<Vec<std::net::SocketAddr>>();
        let kept: Vec<String> = public_addrs(addrs.into_iter()).iter().map(|a| a.ip().to_string()).collect();
        assert_eq!(kept, vec!["93.184.216.34", "2606:4700::1111"]);
    }

    #[tokio::test]
    async fn localhost_name_refused_by_resolver() {
        let r = PublicOnlyResolver.resolve("localhost".parse().unwrap()).await;
        assert!(r.is_err());
    }
}

#[cfg(test)]
mod fuzz_tests {
    #[test]
    fn extractors_never_panic() {
        for s in crate::fuzz_support::strings(5, 40_000, 30) {
            let _ = super::extract_meta(&s, "og:title");
            let _ = super::extract_meta_name(&s, "description");
            let _ = super::extract_title_tag(&s);
            let _ = super::decode_html_entities(&s);
        }
    }

    // a page built to be slow: 512 KB of single-quoted matches with no content. must stay fast
    #[test]
    fn hostile_page_is_fast() {
        let tag = "<meta property='og:title'>";
        let page = tag.repeat(512 * 1024 / tag.len());
        let t0 = std::time::Instant::now();
        for p in ["og:title", "twitter:title", "og:description", "og:image"] {
            let _ = super::extract_meta(&page, p);
        }
        let _ = super::extract_title_tag(&page);
        assert!(t0.elapsed() < std::time::Duration::from_secs(1), "took {:?}", t0.elapsed());
    }
}

#[cfg(test)]
mod extract_tests {
    use super::*;

    #[test]
    fn real_world_shapes_still_extract() {
        let h = r#"<html><head><title> Plain Title </title>
<meta property="og:title" content="OG Title">
<meta content='Desc first' name='description'>
<META PROPERTY="OG:IMAGE" CONTENT="https://cdn.example.com/a.png">
<meta name="twitter:title" content="Tw Title">
<meta property="og:site_name" content="Ex &amp; Co"></head>"#;
        assert_eq!(extract_meta(h, "og:title").as_deref(), Some("OG Title"));
        assert_eq!(extract_meta_name(h, "description").as_deref(), Some("Desc first"));
        assert_eq!(extract_meta(h, "og:image").as_deref(), Some("https://cdn.example.com/a.png"));
        assert_eq!(extract_meta(h, "twitter:title").as_deref(), Some("Tw Title"));
        assert_eq!(extract_title_tag(h).as_deref(), Some("Plain Title"));
        assert_eq!(decode_html_entities(&extract_meta(h, "og:site_name").unwrap()), "Ex & Co");
        // an empty match first, the real one later
        let h2 = r#"<meta property="og:title" content=""><p>日本🔥</p><meta property="og:title" content="Second">"#;
        assert_eq!(extract_meta(h2, "og:title").as_deref(), Some("Second"));
        // multi-byte text right after a tag never panics
        assert_eq!(extract_meta("<meta property='og:title'>é", "og:title"), None);
    }

    #[test]
    fn image_and_storyboard_rules() {
        assert!(safe_image_url("https://cdn.example.com/a.png"));
        for bad in ["http://cdn.example.com/a.png", "https://192.168.1.1/x.png", "https://localhost/x", "https://router.lan/x", "javascript:alert(1)", "/rel.png"] {
            assert!(!safe_image_url(bad), "{bad}");
        }
        assert!(storyboard_host_ok("https://d2nvs31859zcd8.cloudfront.net/abc/storyboards/1-info.json"));
        assert!(storyboard_host_ok("https://vod-storyboards.twitch.tv/x.json"));
        for bad in ["http://d1.cloudfront.net/x", "https://evil.com/x", "https://cloudfront.net.evil.com/x", "https://192.168.0.1/x", "https://eviltwitch.tv/x"] {
            assert!(!storyboard_host_ok(bad), "{bad}");
        }
    }
}
