// home/browse/sidebar keep their own copies, this is the shared one
export function formatViewerCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

// ISO date -> "5m ago" / "3h ago" / "2 days ago" / "3 weeks ago" / "4 months ago" / "2 years ago".
// shared by the VODs page and Home's "Continue where you left off"
export function relativeDate(isoString) {
  const t = new Date(isoString).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, Date.now() - t);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days !== 1 ? "s" : ""} ago`;
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months !== 1 ? "s" : ""} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years !== 1 ? "s" : ""} ago`;
}

// Twitch profile images come as 300x300 (tens of KB each) but are shown at ~30-40px. Twitch's CDN serves the
// same image at 70x70 (a few KB) by changing the size in the URL; that's still 2x for high-DPI screens.
// Any other URL (Kick, placeholders, data URIs) is returned untouched
export function smallAvatar(url, size = 70) {
  if (typeof url !== "string") return url;
  return url.replace(/^(https:\/\/static-cdn\.jtvnw\.net\/.+-profile_image-)300x300(\.[a-z]+)$/i, `$1${size}x${size}$2`);
}

// dates shown in the app as MM-DD-YY. takes a "YYYY-MM-DD" day key (kept as that calendar day) or a timestamp
// / ISO string / Date (shown as YOUR local date: a stream that started Tuesday evening shows Tuesday, even
// though Twitch's UTC timestamp may already say Wednesday)
export function fmtDateMDY(value) {
  if (!value) return "";
  const day = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return `${day[2]}-${day[3]}-${day[1].slice(2)}`;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getFullYear()).slice(2)}`;
}
