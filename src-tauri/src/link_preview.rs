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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
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
        image,
        site_name: site_name.map(|s| decode_html_entities(&s)),
    })
}

// finds <meta property="og:X" content="..."> (or content-then-property order, both occur) and returns the content value. tolerant of attribute order/whitespace/quote style, since this scans real-world HTML
fn extract_meta(html: &str, property: &str) -> Option<String> {
    find_meta_content(html, "property", property)
        .or_else(|| find_meta_content(html, "name", property))
}

fn extract_meta_name(html: &str, name: &str) -> Option<String> {
    find_meta_content(html, "name", name)
}

// scans for the first <meta> whose `attr` equals `value` (case-insensitive, since some sites emit "OG:Title"), then pulls that tag's content attribute regardless of attribute order
fn find_meta_content(html: &str, attr: &str, value: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("{attr}=\"{}\"", value.to_ascii_lowercase());
    let needle_alt = format!("{attr}='{}'", value.to_ascii_lowercase());
    let mut search_from = 0;
    while let Some(rel_pos) = lower[search_from..].find(&needle)
        .or_else(|| lower[search_from..].find(&needle_alt))
    {
        let match_pos = search_from + rel_pos;
        // walk back to this tag's '<' and forward to its '>' so we only look for `content=` within THIS tag, not a later one
        let tag_start = lower[..match_pos].rfind('<').unwrap_or(0);
        let tag_end = lower[match_pos..].find('>').map(|i| match_pos + i).unwrap_or(lower.len());
        let tag_slice = &html[tag_start..tag_end.min(html.len())];
        if let Some(content) = extract_attr(tag_slice, "content") {
            if !content.trim().is_empty() {
                return Some(content.trim().to_string());
            }
        }
        // advance past this tag. a byte index of +1 can land mid-codepoint if what follows '>' is
        // non-ASCII; to_ascii_lowercase() preserves byte length but a slice starting mid-codepoint still
        // panics, so snap forward to the next char boundary rather than assume +1 is one
        let mut next = (tag_end + 1).min(lower.len());
        while next < lower.len() && !lower.is_char_boundary(next) {
            next += 1;
        }
        search_from = next;
        if search_from >= lower.len() {
            break;
        }
    }
    None
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

// fetches arbitrary JSON server-side to work around CORS, added for VOD storyboard (seek-preview
// thumbnail) metadata, whose CDN (cloudfront.net) doesn't send an Access-Control-Allow-Origin header
// for this app's webview origin. reqwest has no CORS concept (it isn't a browser), so this sidesteps
// the restriction the same way fetch_link_preview does. scoped to https:// only and NOT a
// general-purpose proxy; acceptable here because this is a desktop app: whoever can edit the frontend to call this already has the same access as this backend
#[tauri::command]
pub async fn fetch_storyboard_json(url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("Refusing to fetch non-https URL".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(&url)
        // Twitch's storyboard CDN (cloudfront.net) has been seen to 403 without this, a real yt-dlp issue reported the same, suggesting it checks Referer and rejects requests that don't look like twitch.tv
        .header("Referer", "https://www.twitch.tv/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Request failed with status {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}
