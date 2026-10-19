// One shared HTTP client for the whole app. reqwest::Client holds a connection pool: sharing it means
// connections to Twitch / Kick / 7TV / GQL stay open and are reused (no new TCP + TLS handshake per call, no
// rebuilding TLS config and root certificates per call). Cloning is cheap (it's reference-counted).
// Responses are requested compressed (gzip / brotli, see Cargo.toml features) and decompressed
// transparently. Media paths (stream_relay.rs) use their own clients with decompression OFF, so video bytes
// and their Content-Length pass through untouched.

use std::sync::OnceLock;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn client() -> reqwest::Client {
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .pool_idle_timeout(std::time::Duration::from_secs(90))
                // a request that never answers (a half-dead connection after sleep, a stalled server) would
                // otherwise wait forever, and whatever awaits it with it: the points check, chat commands,
                // EventSub setup. a call that needs longer (the dependency download) sets its own .timeout()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}
