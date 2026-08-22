// Drops can't progress here (Twitch tracks watch-time server-side), so this just
// surfaces whether the broadcaster has Drops enabled, from the "DropsEnabled" Helix tag.

const DROPS_TAG = "dropsenabled";

/**
 * @param {{tags?: string[]}} stream - a raw Helix stream object.
 * @returns {boolean}
 */
export function streamHasDropsEnabled(stream) {
  const tags = stream && Array.isArray(stream.tags) ? stream.tags : [];
  return tags.some(
    (t) => typeof t === "string" && t.toLowerCase().replace(/\s+/g, "") === DROPS_TAG
  );
}
