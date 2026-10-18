// Theme codes (Settings > Appearance > Share): everything about how Mosaic looks (theme, accent, colors,
// customized parts, custom CSS) as one text code to send to someone, and the reverse. A code is
// "MOSAIC-THEME:" + base64 of a small JSON object. Codes come from other people, so reading one checks
// every value and keeps only what it recognizes: known themes and parts, #rrggbb colors, sane numbers,
// custom CSS up to a size limit. Nothing in a code can do more than the Appearance page itself can.

import { getSetting, setSetting } from "./settings.js";
import { THEME_PRESETS, THEME_PARTS, CUSTOM_PARTS, isHex } from "./themes.js";

const PREFIX = "MOSAIC-THEME:";
const MAX_CSS = 20000;
const MAX_CODE = 60000;

const toB64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fromB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

export function exportThemeCode() {
  const data = {
    v: 1,
    theme: getSetting("theme"),
    accent: getSetting("themeAccent"),
    colors: getSetting("themeColors"),
    parts: getSetting("customParts"),
    css: getSetting("customCss") || "",
    cssOn: !!getSetting("customCssOn"),
  };
  return PREFIX + toB64(JSON.stringify(data));
}

// validate a code and apply it; returns a one-line summary, throws an Error with a friendly message
export function importThemeCode(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Paste a theme code first.");
  if (raw.length > MAX_CODE) throw new Error("That code is too long to be a Mosaic theme.");
  if (!raw.startsWith(PREFIX)) throw new Error("That isn't a Mosaic theme code (they start with MOSAIC-THEME:).");
  let data;
  try { data = JSON.parse(fromB64(raw.slice(PREFIX.length).replace(/\s+/g, ""))); } catch { throw new Error("That theme code is damaged or incomplete."); }
  if (!data || typeof data !== "object" || data.v !== 1) throw new Error("That theme code is from a newer or unknown version of Mosaic.");

  const theme = THEME_PRESETS.some((p) => p.id === data.theme) ? data.theme : "mosaic";
  const accent = data.accent === "theme" || data.accent === "platform" || isHex(data.accent) ? data.accent : "theme";
  const colors = {};
  for (const p of THEME_PARTS) if (isHex(data.colors?.[p.key])) colors[p.key] = data.colors[p.key].toLowerCase();
  const parts = {};
  let skipped = 0;
  for (const [id, c] of Object.entries(data.parts && typeof data.parts === "object" ? data.parts : {})) {
    const part = CUSTOM_PARTS.find((p) => p.id === id);
    if (!part || !c || typeof c !== "object") { skipped++; continue; }
    const clean = {};
    for (const k of ["bg", "text", "border", "accent", "glow"]) if (isHex(c[k]) && part.ctl.includes(k)) clean[k] = c[k].toLowerCase();
    if (Number.isFinite(c.size) && part.ctl.includes("size")) clean.size = Math.max(0.6, Math.min(2, c.size));
    if (Number.isFinite(c.radius) && part.ctl.includes("radius")) clean.radius = Math.max(0, Math.min(999, Math.round(c.radius)));
    if (c.hidden === true && part.ctl.includes("hide")) clean.hidden = true;
    if (Object.keys(clean).length) parts[id] = clean;
  }
  let css = typeof data.css === "string" ? data.css : "";
  if (css.length > MAX_CSS) throw new Error("The custom CSS in that code is too long.");
  // CSS can't run code, and it's set as text (never parsed as HTML); stray <style> tags are dropped anyway
  css = css.replace(/<\/?style[^>]*>/gi, "");

  setSetting("theme", theme);
  setSetting("themeAccent", accent);
  setSetting("themeColors", colors);
  setSetting("customParts", parts);
  setSetting("customCss", css);
  setSetting("customCssOn", data.cssOn !== false);

  const name = THEME_PRESETS.find((p) => p.id === theme)?.name || "Mosaic";
  const bits = [`${name} theme`];
  const n = Object.keys(parts).length;
  if (n) bits.push(`${n} customized part${n === 1 ? "" : "s"}`);
  if (css.trim()) bits.push("custom CSS");
  return `Theme applied: ${bits.join(", ")}.${skipped ? ` ${skipped} part${skipped === 1 ? "" : "s"} this version doesn't know were skipped.` : ""}`;
}
