export const SEVENTV_API_BASE = "https://7tv.io/v3";
export const BTTV_API_BASE = "https://api.betterttv.net/3";

export const LINK_PREVIEW_HOVER_DELAY_MS = 400;

export const USER_CARD_HISTORY_LIMIT = 20;

// matches a URL within one chat word (messages are tokenized space-by-space): anything with an explicit
// http(s):// or www. prefix, or a bare domain like "esportsawards.com/vote" (Twitch links those too).
// bare domains must end in a real, common TLD, so ordinary words like "nice.try", "node.js" or
// "file.txt" never become links
const CHAT_URL_RE = /^(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}[^\s]*)$/i;
const BARE_TLDS = "com|net|org|tv|gg|io|co|me|app|dev|ly|fm|xyz|ai|us|ca|uk|de|eu|fr|es|it|nl|se|pl|info|live|gl|to|link|shop|store|news|stream|games|art|blog|site|online|page";
const BARE_DOMAIN_RE = new RegExp(
  `^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${BARE_TLDS})(?::\\d{1,5})?(?:[/?#][^\\s]*)?$`, "i");

export function looksLikeUrl(word) {
  return CHAT_URL_RE.test(word) || BARE_DOMAIN_RE.test(word);
}

// add https:// for the bare forms ("www.x", "example.com/path"), fetch() and openUrl() need a scheme
export function normalizeUrl(word) {
  return /^https?:\/\//i.test(word) ? word : `https://${word}`;
}
