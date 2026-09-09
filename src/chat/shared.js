export const SEVENTV_API_BASE = "https://7tv.io/v3";
export const BTTV_API_BASE = "https://api.betterttv.net/3";

export const LINK_PREVIEW_HOVER_DELAY_MS = 400;

export const USER_CARD_HISTORY_LIMIT = 20;

// matches a bare URL within one chat word (messages are tokenized space-by-space).
// requires an explicit http(s):// or www. prefix, else bare "example.com" would catch
// ordinary words like "nice.try"
const CHAT_URL_RE = /^(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}[^\s]*)$/i;

export function looksLikeUrl(word) {
  return CHAT_URL_RE.test(word);
}

// add https:// for the bare "www.x" form, fetch() and openUrl() need a scheme
export function normalizeUrl(word) {
  return /^https?:\/\//i.test(word) ? word : `https://${word}`;
}
