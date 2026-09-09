// Twitch-login -> Kick-slug mapping for failover. the same-name assumption breaks for
// plenty of streamers (zackrawrr -> asmongold), so it's explicit and user-set via the
// "Link Kick" control. stored in localStorage as {twitchLogin: kickSlug}, lowercase

const STORAGE_KEY = "kickAliases";

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function write(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // quota failure, worst case the alias doesn't survive a restart
  }
}

const SLUG_RE = /^[a-z0-9_-]+$/;

export function getKickAlias(twitchLogin) {
  const key = String(twitchLogin || "").toLowerCase();
  return read()[key] || null;
}

export function setKickAlias(twitchLogin, kickSlug) {
  const key = String(twitchLogin || "").toLowerCase();
  if (!key) return false;
  const map = read();
  const slug = String(kickSlug || "").trim().toLowerCase();
  if (!slug) {
    delete map[key];
    write(map);
    return true;
  }
  if (!SLUG_RE.test(slug)) return false;
  map[key] = slug;
  write(map);
  return true;
}

// alias if set, else the login itself. every kick lookup keyed by a Twitch name
// should go through here
export function kickSlugFor(twitchLogin) {
  return getKickAlias(twitchLogin) || String(twitchLogin || "").toLowerCase();
}
