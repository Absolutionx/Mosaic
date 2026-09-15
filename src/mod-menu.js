// Moderator room-control menu (the shield button). Mirrors StreamNook's moderator menu: emote-only,
// followers-only (+ min time), subscriber-only, slow mode (+ seconds), unique chat (r9k), and clear chat.
// Reads the current room settings via get_chat_settings and applies changes via update_chat_settings.

import { invoke } from "@tauri-apps/api/core";

let overlay = null;

function close() {
  if (overlay) { overlay.remove(); overlay = null; }
}

export async function openModMenu(anchorBtn, chat) {
  if (overlay) { close(); return; }
  if (!chat || !chat.roomId) return;
  const broadcasterId = chat.roomId;

  overlay = document.createElement("div");
  overlay.className = "modmenu-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const menu = document.createElement("div");
  menu.className = "modmenu";
  menu.innerHTML = `<div class="modmenu-title">Moderator controls</div><div class="modmenu-body"><div class="rewards-empty">Loading…</div></div>`;
  overlay.appendChild(menu);
  document.body.appendChild(overlay);

  // position under the shield button
  const r = anchorBtn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;

  const onEsc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
  document.addEventListener("keydown", onEsc);

  let settings = {};
  try { settings = (await invoke("get_chat_settings", { broadcasterId })) || {}; }
  catch (err) {
    const body = menu.querySelector(".modmenu-body");
    if (body) body.innerHTML = `<div class="chat-filter-intro">Couldn't load room settings: ${String(err)}</div>`;
    return;
  }
  if (!overlay) return; // closed while loading
  renderMenu(menu, broadcasterId, settings, chat);
}

function renderMenu(menu, broadcasterId, s, chat) {
  const body = menu.querySelector(".modmenu-body");
  if (!body) return;
  body.innerHTML = "";

  const apply = async (patch, onDone) => {
    try {
      const updated = await invoke("update_chat_settings", { broadcasterId, patch });
      if (updated) Object.assign(s, updated);
      if (onDone) onDone();
    } catch (err) {
      chat.systemLine?.(`Couldn't update chat settings: ${String(err)}`);
    }
  };

  // simple on/off toggles
  const toggle = (label, key) => {
    const row = document.createElement("label");
    row.className = "modmenu-row";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!s[key];
    input.addEventListener("change", () => apply({ [key]: input.checked }));
    row.appendChild(span);
    row.appendChild(input);
    body.appendChild(row);
  };

  toggle("Emote-only", "emote_mode");
  toggle("Subscriber-only", "subscriber_mode");
  toggle("Unique chat (r9k)", "unique_chat_mode");

  // followers-only with an optional minimum-minutes field
  {
    const row = document.createElement("div");
    row.className = "modmenu-row modmenu-row-col";
    const top = document.createElement("label");
    top.className = "modmenu-row-inline";
    const span = document.createElement("span"); span.textContent = "Followers-only";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!s.follower_mode;
    top.appendChild(span); top.appendChild(input);
    const mins = document.createElement("input");
    mins.type = "number"; mins.min = "0"; mins.className = "modmenu-num";
    mins.value = s.follower_mode_duration != null ? s.follower_mode_duration : 0;
    mins.title = "Minimum follow time (minutes)";
    mins.style.display = s.follower_mode ? "" : "none";
    input.addEventListener("change", () => {
      mins.style.display = input.checked ? "" : "none";
      apply({ follower_mode: input.checked, follower_mode_duration: Number(mins.value) || 0 });
    });
    mins.addEventListener("change", () => apply({ follower_mode: true, follower_mode_duration: Number(mins.value) || 0 }));
    row.appendChild(top);
    const minsWrap = document.createElement("div"); minsWrap.className = "modmenu-sub";
    minsWrap.appendChild(document.createTextNode("min "));
    minsWrap.appendChild(mins);
    minsWrap.appendChild(document.createTextNode(" minutes"));
    minsWrap.style.display = s.follower_mode ? "" : "none";
    input.addEventListener("change", () => { minsWrap.style.display = input.checked ? "" : "none"; });
    row.appendChild(minsWrap);
    body.appendChild(row);
  }

  // slow mode with a seconds field
  {
    const row = document.createElement("div");
    row.className = "modmenu-row modmenu-row-col";
    const top = document.createElement("label");
    top.className = "modmenu-row-inline";
    const span = document.createElement("span"); span.textContent = "Slow mode";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!s.slow_mode;
    top.appendChild(span); top.appendChild(input);
    const secs = document.createElement("input");
    secs.type = "number"; secs.min = "1"; secs.className = "modmenu-num";
    secs.value = s.slow_mode_wait_time != null ? s.slow_mode_wait_time : 30;
    const secsWrap = document.createElement("div"); secsWrap.className = "modmenu-sub";
    secsWrap.appendChild(document.createTextNode("every "));
    secsWrap.appendChild(secs);
    secsWrap.appendChild(document.createTextNode(" seconds"));
    secsWrap.style.display = s.slow_mode ? "" : "none";
    input.addEventListener("change", () => {
      secsWrap.style.display = input.checked ? "" : "none";
      apply({ slow_mode: input.checked, slow_mode_wait_time: Number(secs.value) || 30 });
    });
    secs.addEventListener("change", () => apply({ slow_mode: true, slow_mode_wait_time: Number(secs.value) || 30 }));
    row.appendChild(top);
    row.appendChild(secsWrap);
    body.appendChild(row);
  }

  // clear chat (uses the delete endpoint with no message id)
  const clearBtn = document.createElement("button");
  clearBtn.className = "modmenu-clear";
  clearBtn.textContent = "Clear chat";
  clearBtn.addEventListener("click", async () => {
    if (!window.confirm("Clear all messages in this chat?")) return;
    try {
      await invoke("delete_chat_message", { broadcasterId, messageId: null });
      chat.systemLine?.("Chat cleared.");
      close();
    } catch (err) {
      chat.systemLine?.(`Couldn't clear chat: ${String(err)}`);
    }
  });
  body.appendChild(clearBtn);
}

export function initModMenu(chat) {
  const btn = document.getElementById("modmenu-btn");
  if (!btn) return;
  btn.addEventListener("click", () => openModMenu(btn, chat));
}
