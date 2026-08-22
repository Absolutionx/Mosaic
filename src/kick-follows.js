// Local follow list behind Kick mode's sidebar "Following" and the info bar's Follow
// toggle. LOCAL by necessity: Kick's real followed endpoint needs a site cookie the OAuth
// token can't produce. Follow pins a channel; kick_followed_status answers which are live.
// Stored in localStorage as {slug, name, avatar} (name/avatar cached so offline rows still
// render).

const STORAGE_KEY = "kickFollows";

const listeners = new Set();

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((f) => f && typeof f.slug === "string" && f.slug)
      : [];
  } catch {
    return [];
  }
}

function write(follows) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(follows));
  } catch {
    // Quota/serialization failure - the in-memory notify below still keeps this session
    // correct.
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      console.error("[kick-follows] change listener failed:", err);
    }
  }
}

/** @returns {{slug, name, avatar}[]} */
export function getKickFollows() {
  return read();
}

export function isKickFollowed(slug) {
  const s = String(slug || "").toLowerCase();
  return read().some((f) => f.slug === s);
}

/** Follow if not followed, else unfollow. `meta` ({name, avatar}) seeds the cached row on
 *  follow. @returns {boolean} the new state. */
export function toggleKickFollow(slug, meta = {}) {
  const s = String(slug || "").toLowerCase();
  if (!s) return false;
  const follows = read();
  const idx = follows.findIndex((f) => f.slug === s);
  if (idx >= 0) {
    follows.splice(idx, 1);
    write(follows);
    return false;
  }
  follows.push({
    slug: s,
    name: meta.name || s,
    avatar: meta.avatar || "",
  });
  write(follows);
  return true;
}

/** Subscribe to follow-list changes (fired after the write), so the sidebar re-renders
 *  when the info bar toggles. */
export function onKickFollowsChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
