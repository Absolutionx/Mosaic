// What you type or paste into the Watch box or MultiView's "Add a channel": a channel name ("xqc", "#xqc",
// "@xqc") or a link to one (twitch.tv/xqc, www.twitch.tv/xqc?sr=a, kick.com/xqc, twitch.tv/videos/123).
// Returns { channel, platform } or, for a Twitch VOD link, { vod, platform: "twitch" }; null for anything
// that can't be a channel (an emoji, a sentence, a link to another site), so it's never sent on as one.
// A plain name belongs to `current` (the platform Mosaic is on); a link says which platform it's on.

const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const KICK_SLUG = /^[a-z0-9_-]{1,25}$/;
// twitch.tv paths that are pages, not channels
const TWITCH_RESERVED = new Set(["directory", "videos", "settings", "subscriptions", "inventory", "drops", "wallet", "search", "downloads", "jobs", "p", "turbo", "friends", "messages", "following"]);

export function parseChannelInput(raw, current = "twitch") {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const link = /^(?:https?:\/\/)?(?:(?:www|m|go)\.)?(twitch\.tv|kick\.com)(?:\/(.*))?$/i.exec(s);
  if (link) {
    const platform = link[1].toLowerCase() === "kick.com" ? "kick" : "twitch";
    const parts = String(link[2] || "").split(/[?#]/)[0].split("/").filter(Boolean).map((p) => p.toLowerCase());
    if (platform === "twitch") {
      if (parts[0] === "videos" && /^\d{1,15}$/.test(parts[1] || "")) return { vod: parts[1], platform };
      if (parts[0] === "popout") parts.shift(); // twitch.tv/popout/<name>/chat
      const name = parts[0] || "";
      return TWITCH_LOGIN.test(name) && !TWITCH_RESERVED.has(name) ? { channel: name, platform } : null;
    }
    const name = parts[0] || "";
    return KICK_SLUG.test(name) ? { channel: name, platform } : null;
  }
  if (/[/\s]/.test(s)) return null; // some other link, or more than one word
  const name = s.replace(/^[#@]/, "").toLowerCase();
  const platform = current === "kick" ? "kick" : "twitch";
  return (platform === "kick" ? KICK_SLUG : TWITCH_LOGIN).test(name) ? { channel: name, platform } : null;
}
