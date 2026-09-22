// Hidden channels: a user-managed block list of streamers that should never appear anywhere in the
// app (sidebar, Home, Browse). Stored as lowercased logins in localStorage. A single shared module so
// every view filters against the same set and reacts to changes live.

const KEY = "hiddenChannels";
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map((s) => String(s).toLowerCase()) : []);
  } catch { return new Set(); }
}

let hidden = load();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify([...hidden])); } catch { /* ignore quota */ }
  listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

export function isHidden(login) {
  return !!login && hidden.has(String(login).toLowerCase());
}

export function hideChannel(login) {
  if (!login) return;
  hidden.add(String(login).toLowerCase());
  persist();
}

export function unhideChannel(login) {
  if (!login) return;
  hidden.delete(String(login).toLowerCase());
  persist();
}

export function getHiddenChannels() {
  return [...hidden];
}

// Filter a list of stream/channel objects, dropping hidden ones. Handles the various shapes the app
// uses: {login}, {user_login}, {broadcaster_login}, {user_name}, {name}.
export function filterHidden(items) {
  if (!Array.isArray(items) || !hidden.size) return items;
  return items.filter((it) => {
    const login = it?.login || it?.user_login || it?.broadcaster_login || it?.user_name || it?.name;
    return !isHidden(login);
  });
}

// Subscribe to changes (hide/unhide). Returns an unsubscribe fn.
export function onHiddenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A tiny right-click menu ("Hide this channel") shared by the sidebar / home / browse. Positioned at
// the click point, closes on outside-click or Escape.
export function showHideChannelMenu(x, y, login, displayName) {
  if (!login) return;
  document.querySelector(".hide-channel-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "hide-channel-menu";
  const item = document.createElement("button");
  item.className = "hide-channel-menu-item";
  item.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>' +
    `<span>Hide ${displayName || login}</span>`;
  item.addEventListener("click", () => { hideChannel(login); menu.remove(); });
  menu.appendChild(item);

  document.body.appendChild(menu);
  // clamp to viewport
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 40;
  menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };
  const onKey = (ev) => { if (ev.key === "Escape") { menu.remove(); document.removeEventListener("mousedown", close, true); document.removeEventListener("keydown", onKey, true); } };
  setTimeout(() => {
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

// A small modal listing hidden channels with an "Unhide" for each — the managed list. Opened from the
// chat settings gear menu.
export function openHiddenChannelsModal() {
  document.querySelector(".hidden-channels-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "hidden-channels-overlay";
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement("div");
  modal.className = "hidden-channels-modal";
  overlay.appendChild(modal);

  const render = () => {
    const list = getHiddenChannels().sort();
    modal.innerHTML =
      '<div class="hidden-channels-head">' +
        '<span class="hidden-channels-title">Hidden channels</span>' +
        '<button class="hidden-channels-close" aria-label="Close">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="hidden-channels-sub">These channels are hidden from the sidebar, Home, and Browse.</div>' +
      '<div class="hidden-channels-list"></div>';
    modal.querySelector(".hidden-channels-close").addEventListener("click", () => overlay.remove());

    const listEl = modal.querySelector(".hidden-channels-list");
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "hidden-channels-empty";
      empty.textContent = "No hidden channels. Right-click a streamer to hide them.";
      listEl.appendChild(empty);
      return;
    }
    for (const login of list) {
      const row = document.createElement("div");
      row.className = "hidden-channels-row";
      const name = document.createElement("span");
      name.className = "hidden-channels-name";
      name.textContent = login;
      const btn = document.createElement("button");
      btn.className = "hidden-channels-unhide";
      btn.textContent = "Unhide";
      btn.addEventListener("click", () => { unhideChannel(login); render(); });
      row.appendChild(name);
      row.appendChild(btn);
      listEl.appendChild(row);
    }
  };
  render();

  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey, true); } };
  document.addEventListener("keydown", onKey, true);
}
