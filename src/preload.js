// Settings > Player > Preload favorites: keeps a few live favorites loading in the background so opening
// one is instant (stream_relay.rs, "Preloading", does the work). This side decides WHICH: live favorites in
// sidebar order, only the picked ones if any are picked, up to the chosen count, at the quality and latency
// a new stream would start with (anything else couldn't be handed over). The backend leaves out the channel
// already playing, and is told the full list again whenever something it depends on changes, plus once a
// minute (a preload that failed, e.g. a stream that ended, is retried then).
//
// Also the "Channels to preload" picker the setting's button opens.

import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting, onSettingChange } from "./settings.js";
import { pushEscape } from "./escape-stack.js";

let deps = null; // { liveFavorites(), allFavorites(), lowLatency(), paused() }
let timer = null;

const WATCHED = new Set(["preloadFavorites", "preloadCount", "preloadChannels", "defaultQuality", "lowLatency"]);

export function initPreload(o) {
  deps = o;
  window.addEventListener("mosaic:live-favorites-changed", () => syncPreload());
  onSettingChange((id) => { if (WATCHED.has(id)) syncPreload(); });
  setInterval(() => syncPreload(), 60000);
  syncPreload();
}

// re-tell the backend what to preload (soon, so a burst of changes is one call)
export function syncPreload(delay = 400) {
  if (!deps) return;
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

function run() {
  let channels = [];
  if (getSetting("preloadFavorites") && !deps.paused()) {
    const picks = (getSetting("preloadChannels") || []).map((s) => String(s).toLowerCase());
    channels = deps.liveFavorites()
      .filter((f) => f.favorite)
      .map((f) => String(f.login).toLowerCase())
      .filter((l) => !picks.length || picks.includes(l));
  }
  invoke("preload_set", {
    channels,
    count: Number(getSetting("preloadCount")) || 1,
    quality: getSetting("defaultQuality"),
    lowLatency: !!deps.lowLatency(),
  }).catch((e) => console.warn("[preload]", e));
}

// the picker: every favorite, checked = preload it. none checked means "any of my favorites"
export function openPreloadPicker() {
  const favs = deps?.allFavorites() || [];
  const overlay = document.createElement("div");
  overlay.className = "chat-filter-overlay";
  const modal = document.createElement("div");
  modal.className = "chat-filter-modal preload-picker";
  overlay.appendChild(modal);

  const head = document.createElement("div");
  head.className = "chat-filter-header";
  head.appendChild(Object.assign(document.createElement("span"), { textContent: "Channels to preload" }));
  const x = document.createElement("button");
  x.className = "chat-filter-close";
  x.textContent = "✕";
  head.appendChild(x);
  modal.appendChild(head);

  const intro = document.createElement("div");
  intro.className = "chat-filter-intro";
  intro.textContent = "Pick the favorites to preload while they're live. With none picked, any live favorite can be, in the order your sidebar shows them.";
  modal.appendChild(intro);

  const list = document.createElement("div");
  list.className = "preload-picker-list";
  const picks = new Set((getSetting("preloadChannels") || []).map((s) => String(s).toLowerCase()));
  if (!favs.length) {
    list.appendChild(Object.assign(document.createElement("div"), {
      className: "chat-filter-intro", textContent: "You don't have any favorites yet. Add one from a channel's bell menu in the sidebar.",
    }));
  }
  for (const f of favs) {
    const login = String(f.login).toLowerCase();
    const row = document.createElement("label");
    row.className = "preload-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = picks.has(login);
    cb.addEventListener("change", () => {
      if (cb.checked) picks.add(login); else picks.delete(login);
      setSetting("preloadChannels", favs.map((g) => String(g.login).toLowerCase()).filter((l) => picks.has(l)));
    });
    const img = document.createElement("img");
    img.className = "preload-picker-avatar";
    img.alt = "";
    if (f.avatar) img.src = f.avatar;
    const name = document.createElement("span");
    name.className = "preload-picker-name";
    name.textContent = f.name || f.login;
    const live = document.createElement("span");
    live.className = "preload-picker-live" + (f.live ? " on" : "");
    live.textContent = f.live ? "Live" : "Offline";
    row.append(cb, img, name, live);
    list.appendChild(row);
  }
  modal.appendChild(list);

  let popEscape = null;
  const close = () => { overlay.remove(); popEscape?.(); };
  x.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  popEscape = pushEscape(close);
}
