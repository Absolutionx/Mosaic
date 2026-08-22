// Fetches Twitch VOD chapter markers from GQL via browser fetch (gql.twitch.tv is in the
// CSP, so no Rust hop). Public data, no auth needed.

const GQL_URL    = "https://gql.twitch.tv/gql";
// The public Client-ID the twitch.tv site uses for GQL - not a secret; the same one
// streamlink/yt-dlp use for public GQL queries.
const CLIENT_ID  = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_QUERY  =
  "query GetVideoChapters($videoID: ID!) {" +
  "  video(id: $videoID) {" +
  "    moments(momentRequestType: VIDEO_CHAPTER_MARKERS) {" +
  "      edges { node { positionMilliseconds description } }" +
  "    }" +
  "  }" +
  "}";

/**
 * Fetch chapter markers for a Twitch VOD. Returns [{ positionSec, title }] (empty if none).
 * @param {string} videoId - numeric Twitch VOD ID
 * @param {string} [token] - optional OAuth token (improves reliability)
 */
export async function fetchVodChapters(videoId, token = null) {
  const headers = {
    "Client-ID":    CLIENT_ID,
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `OAuth ${token}`;

  const resp = await fetch(GQL_URL, {
    method:  "POST",
    headers,
    body: JSON.stringify([{
      query:     GQL_QUERY,
      variables: { videoID: videoId },
    }]),
  });

  if (!resp.ok) {
    throw new Error(`GQL chapters ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  console.log("[chapters] raw GQL response for", videoId, ":", JSON.stringify(json));

  const data    = json[0]?.data;
  const moments = data?.video?.moments;

  // MomentConnection uses Relay-style edges/node pagination.
  const edges   = moments?.edges ?? [];
  const nodes   = edges.map(e => e.node).filter(Boolean);

  // Defensive: some schema versions return a flat nodes array.
  const raw     = nodes.length ? nodes : (moments?.nodes ?? []);

  return raw.map(n => ({
    positionSec: (n.positionMilliseconds ?? 0) / 1000,
    title:       n.description
              || n.details?.game?.displayName
              || "Unknown",
  }));
}

const SEEK_PREVIEWS_QUERY =
  "query GetVideoSeekPreviews($videoID: ID!) {" +
  "  video(id: $videoID) {" +
  "    seekPreviewsURL" +
  "  }" +
  "}";

/**
 * Fetches the storyboard (seek-preview) URL for a Twitch VOD - a JSON describing the
 * sprite-sheet layout, not an image. VOD-only; null if the VOD has none.
 * @param {string} videoId
 * @param {string} [token] - optional OAuth token (improves reliability)
 */
export async function fetchVodSeekPreviewsUrl(videoId, token = null) {
  const headers = {
    "Client-ID":    CLIENT_ID,
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `OAuth ${token}`;

  const resp = await fetch(GQL_URL, {
    method:  "POST",
    headers,
    body: JSON.stringify([{
      query:     SEEK_PREVIEWS_QUERY,
      variables: { videoID: videoId },
    }]),
  });

  if (!resp.ok) {
    throw new Error(`GQL seek-previews ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  return json[0]?.data?.video?.seekPreviewsURL ?? null;
}

