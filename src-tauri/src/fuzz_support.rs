// test-only: random hostile strings for the parser fuzz tests in each module (chat, link previews, the
// proxy's playlist rewriting, OAuth query parsing, ...). seeded, so a failure reproduces exactly
#![cfg(test)]

use rand::{Rng, SeedableRng};

// pieces that tend to break hand-written parsers: delimiters, quotes, escapes, multi-byte characters
// (slicing mid-codepoint panics in Rust), control characters and HLS/IRC/HTML syntax
const PIECES: &[&str] = &[
    "", " ", "  ", ";", "=", ":", " :", "@", "!", "#", ",", "&", "?", "%", "%2", "%zz", "%41", "%e2%82",
    "\"", "'", "<", ">", "/", "\\", "\\s", "\\:", "\r", "\n", "\r\n", "\t", "\0", "+",
    "é", "ü", "日本", "🔥", "👍🏽", "\u{200b}", "\u{e0000}", "\u{feff}", "\u{1f600}",
    "PRIVMSG", "RECONNECT", "PING", "tmi.twitch.tv", "display-name", "emotes", "badges",
    "#EXTM3U", "#EXTINF:", "#EXTINF:2.000,live", "#EXTINF:2.000,Amazon", "#EXT-X-MEDIA-SEQUENCE:",
    "#EXT-X-MAP:URI=\"", "#EXT-X-PROGRAM-DATE-TIME:", "#EXT-X-DISCONTINUITY", "seg.ts", "http://", "https://",
    "<meta", "property=\"og:title\"", "property='og:title'", "content=\"", "content='", "<title>", "</title>",
    "&amp;", "&quot;", "&#39;", "k=", "url=", "t=", "s=", "GET /token?", " HTTP/1.1",
    "9999999999999999999999", "-1", "0", "PT1H2M3S", "1h2m3s", "2026-10-16T01:02:03Z",
];

pub fn strings(seed: u64, count: usize, max_pieces: usize) -> Vec<String> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    (0..count)
        .map(|_| {
            let n = rng.random_range(0..=max_pieces);
            let mut s = String::new();
            for _ in 0..n {
                if rng.random_range(0..10) == 0 {
                    // occasionally a random character, any plane
                    s.push(char::from_u32(rng.random_range(0..0x11000)).unwrap_or('?'));
                } else {
                    s.push_str(PIECES[rng.random_range(0..PIECES.len())]);
                }
            }
            s
        })
        .collect()
}
