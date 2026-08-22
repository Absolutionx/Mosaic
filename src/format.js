// Small display-formatting helpers shared across UI modules.

/** Abbreviates a viewer count (1.2K, 48K). home/browse/sidebar keep private copies;
 *  this is the shared one for everything else. */
export function formatViewerCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}
