// What's new: after an update, a window in the style of Settings listing what changed (changelog.js).
// Versions down the left like the settings sections, the selected one's changes on the right grouped
// into New / Improved / Fixed. Shown once per update (Settings › App › Show what's new after updates),
// and on demand from Settings › App and the command palette.
//
// "the version you had before" is localStorage lastSeenVersion. a first install has nothing to compare
// with and shows nothing; an install from before this window existed (settings saved, no lastSeenVersion)
// counts as an update.

import { getVersion } from "@tauri-apps/api/app";
import { getSetting } from "./settings.js";
import { pushEscape } from "./escape-stack.js";
import { CHANGELOG } from "./changelog.js";

const SEEN_KEY = "lastSeenVersion";
const KINDS = [["new", "New"], ["improved", "Improved"], ["fixed", "Fixed"]];
const X_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

// -1 / 0 / 1 for dotted version strings ("1.4.10" > "1.4.9"); junk compares as 0.0.0
export function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// the changelog entries newer than `seen` and no newer than `current`, newest first
export function unseenEntries(seen, current, log = CHANGELOG) {
  return log.filter((e) => compareVersions(e.version, current) <= 0 && (!seen || compareVersions(e.version, seen) > 0));
}

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

// at startup: show the window if this is an update with something to say. returns true when it showed
export async function maybeShowWhatsNew({ version } = {}) {
  let current = version;
  if (!current) { try { current = await getVersion(); } catch { return false; } }
  const seen = read(SEEN_KEY);
  // a first install: nothing changed for you. (settings already saved = installed before this existed)
  const before = seen || (read("mosaicSettings") ? "0.0.0" : null);
  write(SEEN_KEY, current); // marked now, so a crash or a quick restart doesn't show it twice
  if (!before || compareVersions(current, before) <= 0) return false;
  if (!getSetting("showWhatsNew")) return false;
  const fresh = unseenEntries(before, current);
  if (!fresh.length) return false;
  openWhatsNew({ select: fresh[0].version, fresh: new Set(fresh.map((e) => e.version)), current });
  return true;
}

let backdrop = null, popEscape = null;

// select: the version to show first; fresh: versions that are new to you (a dot in the list)
export async function openWhatsNew({ select, fresh = new Set(), current } = {}) {
  if (backdrop) return;
  if (!current) { try { current = await getVersion(); } catch { current = CHANGELOG[0]?.version; } }
  const list = CHANGELOG.filter((e) => compareVersions(e.version, current) <= 0);
  if (!list.length) return;
  let selected = list.find((e) => e.version === select) || list[0];

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  backdrop = el("div", "settings-backdrop whatsnew-backdrop");
  const panel = el("div", "settings-panel whatsnew-panel");
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "What's new");
  const nav = el("aside", "settings-nav");
  nav.append(el("div", "settings-nav-title", "What's new"));
  const navList = el("nav", "settings-nav-list");
  nav.append(navList);
  const main = el("main", "settings-main");
  const head = el("div", "settings-main-head");
  const title = el("h2", "settings-main-title");
  const close = el("button", "settings-close");
  close.type = "button"; close.title = "Close (Esc)"; close.setAttribute("aria-label", "Close"); close.innerHTML = X_ICON;
  head.append(title, close);
  const rows = el("div", "settings-rows");
  const foot = el("div", "whatsnew-foot");
  const note = el("span", "whatsnew-note", "Turn this off in Settings › App.");
  const done = el("button", "settings-action whatsnew-done", "Got it");
  done.type = "button";
  foot.append(note, done);
  main.append(head, rows, foot);
  panel.append(nav, main);
  backdrop.append(panel);

  const render = () => {
    navList.replaceChildren();
    for (const e of list) {
      const b = el("button", "settings-nav-item whatsnew-version" + (e === selected ? " active" : ""));
      b.type = "button";
      b.append(el("span", null, `Version ${e.version}`));
      if (e.version === current) b.append(el("span", "whatsnew-tag", "Current"));
      else if (fresh.has(e.version)) b.append(el("span", "whatsnew-dot"));
      b.addEventListener("click", () => { selected = e; render(); });
      navList.append(b);
    }
    title.textContent = `Version ${selected.version}`;
    rows.replaceChildren();
    for (const [kind, label] of KINDS) {
      const items = selected.items.filter((i) => i.kind === kind);
      if (!items.length) continue;
      rows.append(el("div", "settings-group", label));
      for (const i of items) {
        const row = el("div", "settings-row whatsnew-row");
        const text = el("div", "settings-row-text");
        text.append(el("div", "settings-row-title", i.title));
        if (i.desc) text.append(el("div", "settings-row-desc", i.desc));
        row.append(text);
        rows.append(row);
      }
    }
    rows.scrollTop = 0;
  };
  render();
  document.body.append(backdrop);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeWhatsNew(); });
  close.addEventListener("click", closeWhatsNew);
  done.addEventListener("click", closeWhatsNew);
  popEscape = pushEscape(() => closeWhatsNew());
  setTimeout(() => done.focus(), 30);
}

export function closeWhatsNew() {
  if (!backdrop) return;
  backdrop.remove();
  backdrop = null;
  popEscape?.();
  popEscape = null;
}
