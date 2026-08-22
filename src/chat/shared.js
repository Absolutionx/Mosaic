// Small constants and pure helpers shared by chat.js and its mixin files, kept here so
// there's one definition of each.

export const SEVENTV_API_BASE = "https://7tv.io/v3";
export const BTTV_API_BASE = "https://api.betterttv.net/3";

// Hover dwell before a link preview fetches - see chat-link-preview.js.
export const LINK_PREVIEW_HOVER_DELAY_MS = 400;

// Recent messages kept per user for the user card's log - a handful of lines, not a full
// transcript (see chat-usercard.js).
export const USER_CARD_HISTORY_LIMIT = 20;

// Matches a bare URL within one chat word (messages are tokenized space-by-space).
// Requires an explicit http(s):// or www. prefix - bare "example.com" would catch ordinary
// words like "nice.try".
const CHAT_URL_RE = /^(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}[^\s]*)$/i;

/** True if `word` looks like a standalone URL per CHAT_URL_RE. */
export function looksLikeUrl(word) {
  return CHAT_URL_RE.test(word);
}

/** Normalizes a matched chat word into a fetchable URL, adding https:// for the bare "www.x"
 *  form (fetch() and openUrl() need a scheme). */
export function normalizeUrl(word) {
  return /^https?:\/\//i.test(word) ? word : `https://${word}`;
}
