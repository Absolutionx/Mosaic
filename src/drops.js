// whether the broadcaster has Drops enabled, via the DropsEnabled Helix tag (drops-banner.js only
// checks the Twitch connection on those channels)

const DROPS_TAG = "dropsenabled";

export function streamHasDropsEnabled(stream) {
  const tags = stream && Array.isArray(stream.tags) ? stream.tags : [];
  return tags.some(
    (t) => typeof t === "string" && t.toLowerCase().replace(/\s+/g, "") === DROPS_TAG
  );
}
