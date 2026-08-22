// Pure, dependency-free emote parsing - the testable core of chat-emotes.js and
// chat-vod-replay.js (no DOM, tauri, fetch, or `this`). Kept here so
// tests/emote-parsing.test.js runs under plain `node --test`; regressions here (native
// offsets, cheermote tiers) have bitten before.

/** Parses the IRC @emotes tag into a Map<charStart, {id, word}>.
 *  Format: "id:start-end,start-end/id2:start-end" (character offsets). */
export function parseTwitchEmotesTag(message, emotesTag) {
  const map = new Map();
  if (!emotesTag) return map;
  for (const part of emotesTag.split("/")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const id = part.slice(0, colonIdx);
    const ranges = part.slice(colonIdx + 1);
    for (const range of ranges.split(",")) {
      const dashIdx = range.indexOf("-");
      if (dashIdx === -1) continue;
      const start = parseInt(range.slice(0, dashIdx), 10);
      const end   = parseInt(range.slice(dashIdx + 1), 10);
      if (isNaN(start) || isNaN(end)) continue;
      map.set(start, { id, word: message.slice(start, end + 1) });
    }
  }
  return map;
}

/** Parses a word as a cheermote ("Cheer100") against a prepared map (prefix -> tiers desc
 *  by minBits). Returns { amount, tier } or null; descending order yields the highest tier. */
export function parseCheermoteWord(word, cheermoteMap) {
  const lower = word.toLowerCase();
  for (const [prefix, tiers] of cheermoteMap) {
    if (!lower.startsWith(prefix)) continue;
    const amountStr = word.slice(prefix.length);
    if (!/^\d+$/.test(amountStr)) continue;
    const amount = parseInt(amountStr, 10);
    if (amount <= 0) continue;
    const tier = tiers.find(t => amount >= t.minBits);
    if (tier) return { amount, tier };
  }
  return null;
}

/** Parses one word as a Kick native-emote marker from flatten_emote_tokens:
 *  `\x01{id}\x01{name}\x01` (\x01 can't appear in a name or be typed). Returns { id, name }
 *  or null. The id is carried so a subscriber's cross-channel emote still renders (the local
 *  map only holds the watched channel's set). */
export function parseKickEmoteMarker(word) {
  const SEP = "\u0001";
  if (!word.startsWith(SEP) || !word.endsWith(SEP) || word.length < 3) return null;
  const body = word.slice(1, -1);
  const sepIdx = body.indexOf(SEP);
  if (sepIdx === -1) return null;
  const id = body.slice(0, sepIdx);
  const name = body.slice(sepIdx + 1);
  if (!/^\d+$/.test(id) || name.length === 0) return null;
  return { id, name };
}

/** Picks the best available CDN file from a 7TV emote's host.files list. */
export function pickEmoteUrl(host) {
  if (!host || !host.url) return null;
  const base = host.url.startsWith("http") ? host.url : `https:${host.url}`;
  if (Array.isArray(host.files) && host.files.length > 0) {
    const preferred =
      host.files.find((f) => f.name === "2x.webp") ||
      host.files.find((f) => f.format === "WEBP") ||
      host.files[0];
    return `${base}/${preferred.name}`;
  }
  return `${base}/2x.webp`;
}

/** Reconstructs the plain-text body AND a Twitch emotes tag from a VOD GQL comment's
 *  fragments. Returns { body, emotesTag }, emotesTag null when there are no emotes, so
 *  renderMessageBody consumes it like live chat's IRC tag. */
export function reconstructVodMessage(fragments) {
  let body = "";
  const emoteParts = [];
  for (const f of (fragments || [])) {
    const text = f.text || "";
    const start = body.length;
    body += text;
    if (f.emote?.emoteID) {
      emoteParts.push(`${f.emote.emoteID}:${start}-${body.length - 1}`);
    }
  }
  return { body, emotesTag: emoteParts.length > 0 ? emoteParts.join("/") : null };
}

/** Third-party emote provider precedence, highest first. Channel emotes beat globals, and
 *  within a level the order mirrors mainstream clients (7TV > BTTV > FFZ). Makes collisions
 *  deterministic instead of last-fetch-wins. */
export const EMOTE_PROVIDER_PRIORITY = {
  // Kick-native channel emotes outrank all: a flattened token WAS that emote when the sender
  // picked it. Only populated in Kick chat.
  "kick-channel":    7,
  "seventv-channel": 6,
  "bttv-channel":    5,
  "ffz-channel":     4,
  "seventv-global":  3,
  "bttv-global":     2,
  "ffz-global":      1,
  // Kick's site-wide Global/Emoji sets rank last - baseline any override should beat.
  "kick-global":     0,
};

/** True when `provider` names a channel-level (not global) emote source. */
export function isChannelProvider(provider) {
  return provider === "seventv-channel"
      || provider === "bttv-channel"
      || provider === "ffz-channel"
      || provider === "kick-channel";
}
