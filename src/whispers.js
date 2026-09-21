// Whispers UI (Stage A): an inbox button in the header opening a threads list, each thread showing its
// message history with a composer. New whispers arrive live via the "whisper-received" event and are
// stored locally so history persists. Sending goes through Helix (send_whisper).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let chatRef = null;
let overlay = null;
let view = "list"; // "list" | "thread" | "new"
let activeContact = null; // { id, name }

function ownerId() {
  return chatRef && chatRef.ownUserId ? String(chatRef.ownUserId) : "";
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtRelative(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(ts) {
  const d = new Date(ts || Date.now());
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today.getTime())) return "Today";
  if (dayKey(ts) === dayKey(yesterday.getTime())) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function initWhispers(chat) {
  chatRef = chat;
  // make sure the global emote sets are available for the whisper picker even before any stream is
  // opened (chat.loadGlobalEmotesOnce is idempotent)
  try { chatRef.loadGlobalEmotesOnce?.(); } catch { /* ignore */ }
  document.getElementById("whispers-btn")?.addEventListener("click", () => openWhispers());

  listen("whisper-received", async (e) => {
    const p = e.payload || {};
    const owner = ownerId();
    if (!owner || !p.from_user_id) return;
    try {
      const unread = await invoke("whisper_record", {
        ownerId: owner,
        contactId: p.from_user_id,
        contactName: p.from_user_name || p.from_user_login || p.from_user_id,
        fromSelf: false,
        text: p.text || "",
      });
      updateBadge(unread);
      // if we're looking at this exact thread, append live + mark read
      if (overlay && view === "thread" && activeContact && activeContact.id === p.from_user_id) {
        appendMessageEl(false, p.text || "", Date.now());
        await invoke("whisper_mark_read", { ownerId: owner, contactId: p.from_user_id });
        updateBadge(await invoke("whisper_total_unread", { ownerId: owner }));
      } else if (overlay && view === "list") {
        renderList();
      }
    } catch (err) {
      console.warn("whisper record failed:", err);
    }
  }).catch(() => {});

  refreshBadge();
}

async function refreshBadge() {
  const owner = ownerId();
  if (!owner) { updateBadge(0); return; }
  try { updateBadge(await invoke("whisper_total_unread", { ownerId: owner })); } catch { /* ignore */ }
}
function updateBadge(n) {
  const badge = document.getElementById("whispers-unread");
  if (!badge) return;
  n = Number(n) || 0;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.style.display = n > 0 ? "" : "none";
}

function close() {
  if (overlay) { overlay.remove(); overlay = null; }
}

function openWhispers() {
  if (overlay) { close(); return; }
  view = "list";
  activeContact = null;
  overlay = document.createElement("div");
  overlay.className = "whisper-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const modal = document.createElement("div");
  modal.className = "whisper-modal";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  render();
}

function render() {
  const modal = overlay.querySelector(".whisper-modal");
  if (view === "thread") return renderThread(modal);
  if (view === "new") return renderNew(modal);
  return renderList(modal);
}

async function renderList(modal) {
  modal = modal || overlay.querySelector(".whisper-modal");
  const owner = ownerId();
  modal.innerHTML =
    '<div class="whisper-header"><span class="whisper-title">Whispers</span>' +
    '<button class="whisper-new-btn">New</button><button class="whisper-close">\u2715</button></div>' +
    '<div class="whisper-body" id="whisper-body"></div>';
  modal.querySelector(".whisper-close").addEventListener("click", close);
  modal.querySelector(".whisper-new-btn").addEventListener("click", () => { view = "new"; render(); });
  const body = modal.querySelector("#whisper-body");
  if (!owner) { body.innerHTML = '<div class="whisper-empty">Log in to use whispers.</div>'; return; }
  let threads = [];
  try { threads = await invoke("whisper_get_threads", { ownerId: owner }); } catch { /* ignore */ }
  if (!Array.isArray(threads) || !threads.length) {
    body.innerHTML = '<div class="whisper-empty">No whispers yet. Click New to start one.</div>';
    return;
  }
  body.innerHTML = "";
  for (const t of threads) {
    const row = document.createElement("button");
    row.className = "whisper-thread-row";
    row.innerHTML =
      '<div class="whisper-thread-top">' +
      `<span class="whisper-thread-name">${esc(t.name)}</span>` +
      `<span class="whisper-thread-time">${esc(fmtRelative(t.last_ts))}</span></div>` +
      '<div class="whisper-thread-bottom">' +
      `<span class="whisper-thread-last">${esc(t.last_text)}</span>` +
      (t.unread > 0 ? `<span class="whisper-thread-unread">${t.unread > 99 ? "99+" : t.unread}</span>` : "") +
      "</div>";
    row.addEventListener("click", () => { activeContact = { id: t.contact_id, name: t.name }; view = "thread"; render(); });
    body.appendChild(row);
  }
}

async function renderThread(modal) {
  const owner = ownerId();
  modal.innerHTML =
    '<div class="whisper-header"><button class="whisper-back">\u2039</button>' +
    `<span class="whisper-title">${esc(activeContact.name)}</span>` +
    '<button class="whisper-close">\u2715</button></div>' +
    '<div class="whisper-body" id="whisper-body"></div>' +
    '<div class="whisper-inputrow">' +
    '<div class="whisper-input-wrap">' +
    '<input type="text" class="whisper-input" placeholder="Send a whisper\u2026" maxlength="500" />' +
    '<button class="whisper-emote-btn" title="Emotes" type="button">' +
    '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.7" cy="9.8" r="1.15" fill="currentColor"/><circle cx="15.3" cy="9.8" r="1.15" fill="currentColor"/><path d="M8 14.2c1 1.3 2.4 2 4 2s3-.7 4-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
    '</button>' +
    '<div class="whisper-emote-menu" style="display:none"></div>' +
    '<div class="whisper-ac" style="display:none"></div>' +
    '</div>' +
    '<button class="whisper-send">Send</button></div>';
  modal.querySelector(".whisper-close").addEventListener("click", close);
  modal.querySelector(".whisper-back").addEventListener("click", () => { view = "list"; activeContact = null; render(); });

  const body = modal.querySelector("#whisper-body");
  body.dataset.lastDay = "";
  let msgs = [];
  try { msgs = await invoke("whisper_get_thread", { ownerId: owner, contactId: activeContact.id }); } catch { /* ignore */ }
  body.innerHTML = "";
  if (Array.isArray(msgs)) for (const m of msgs) appendMessageEl(!!m.self, m.text || "", m.ts, body);
  body.scrollTop = body.scrollHeight;

  // opening a thread clears its unread
  try {
    await invoke("whisper_mark_read", { ownerId: owner, contactId: activeContact.id });
    updateBadge(await invoke("whisper_total_unread", { ownerId: owner }));
  } catch { /* ignore */ }

  const input = modal.querySelector(".whisper-input");
  const send = modal.querySelector(".whisper-send");
  const doSend = async () => {
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      await invoke("send_whisper", { toUserId: activeContact.id, message: text });
      await invoke("whisper_record", {
        ownerId: owner, contactId: activeContact.id, contactName: activeContact.name,
        fromSelf: true, text,
      });
      appendMessageEl(true, text, Date.now());
      input.value = "";
    } catch (err) {
      appendSystem(typeof err === "string" ? err : "Couldn't send whisper.");
    } finally {
      send.disabled = false;
      input.focus();
    }
  };
  send.addEventListener("click", doSend);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !acVisible()) { e.preventDefault(); doSend(); } });

  // ---- emotes: picker button + tab/type autocomplete, reusing the chat instance's emote maps ----
  const emoteBtn = modal.querySelector(".whisper-emote-btn");
  const emoteMenu = modal.querySelector(".whisper-emote-menu");
  const acBox = modal.querySelector(".whisper-ac");

  // flat, de-duped, sorted list of {name, url} from the live emote maps (7TV/BTTV/FFZ + Twitch native)
  function allEmotes() {
    const out = [];
    const seen = new Set();
    if (chatRef && chatRef.sevenTvEmotes) {
      for (const [name, e] of chatRef.sevenTvEmotes) {
        if (e?.url && !seen.has(name)) { seen.add(name); out.push({ name, url: e.url }); }
      }
    }
    if (chatRef && chatRef.twitchNativeEmotes) {
      for (const [name, t] of chatRef.twitchNativeEmotes) {
        if (!seen.has(name) && t?.id) {
          seen.add(name);
          out.push({ name, url: `https://static-cdn.jtvnw.net/emoticons/v2/${t.id}/default/dark/1.0` });
        }
      }
    }
    return out;
  }

  function insertEmote(name) {
    // replace the word being typed (if any) with the emote name, else append at cursor
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const after = v.slice(caret);
    const m = before.match(/(\S+)$/);
    const start = m ? caret - m[1].length : caret;
    const insert = name + " ";
    input.value = before.slice(0, start) + insert + after;
    const pos = start + insert.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  // --- picker menu ---
  function buildEmoteMenu() {
    // make sure globals are loaded (idempotent) in case whispers opened very early
    try { chatRef.loadGlobalEmotesOnce?.(); } catch { /* ignore */ }
    const list = allEmotes();
    emoteMenu.innerHTML = "";
    if (!list.length) {
      emoteMenu.innerHTML = '<div class="whisper-emote-empty">Emotes are still loading\u2026 try again in a moment.</div>';
      return;
    }
    const grid = document.createElement("div");
    grid.className = "whisper-emote-grid";
    for (const e of list.slice(0, 300)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "whisper-emote-cell";
      b.title = e.name;
      const img = document.createElement("img");
      img.src = e.url; img.alt = e.name; img.loading = "lazy";
      b.appendChild(img);
      b.addEventListener("click", () => { insertEmote(e.name); emoteMenu.style.display = "none"; });
      grid.appendChild(b);
    }
    emoteMenu.appendChild(grid);
  }
  emoteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (emoteMenu.style.display === "none") { buildEmoteMenu(); emoteMenu.style.display = ""; acBox.style.display = "none"; }
    else emoteMenu.style.display = "none";
  });
  document.addEventListener("mousedown", (e) => {
    if (!emoteMenu.contains(e.target) && e.target !== emoteBtn && !emoteBtn.contains(e.target)) emoteMenu.style.display = "none";
  });

  // --- inline autocomplete (type ":" or 2+ chars of a word) ---
  let acItems = [];
  let acIndex = 0;
  function acVisible() { return acBox.style.display !== "none"; }
  function currentWord() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const m = before.match(/(\S+)$/);
    return m ? m[1] : "";
  }
  function refreshAc() {
    const raw = currentWord();
    const q = raw.replace(/^:/, "");
    if (q.length < 2) { acBox.style.display = "none"; return; }
    const ql = q.toLowerCase();
    const all = allEmotes();
    // prefix matches first, then substring; cap the list
    const pref = [], sub = [];
    for (const e of all) {
      const n = e.name.toLowerCase();
      if (n.startsWith(ql)) pref.push(e);
      else if (n.includes(ql)) sub.push(e);
      if (pref.length >= 8) break;
    }
    acItems = [...pref, ...sub].slice(0, 8);
    if (!acItems.length) { acBox.style.display = "none"; return; }
    acIndex = 0;
    renderAc();
    acBox.style.display = "";
  }
  function renderAc() {
    acBox.innerHTML = "";
    acItems.forEach((e, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "whisper-ac-item" + (i === acIndex ? " active" : "");
      const img = document.createElement("img"); img.src = e.url; img.alt = ""; img.loading = "lazy";
      const nm = document.createElement("span"); nm.textContent = e.name;
      row.appendChild(img); row.appendChild(nm);
      row.addEventListener("click", () => { insertEmote(e.name); acBox.style.display = "none"; });
      acBox.appendChild(row);
    });
  }
  input.addEventListener("input", refreshAc);
  input.addEventListener("keydown", (e) => {
    if (!acVisible()) {
      // Tab with a typed word completes the top match even without the dropdown open
      if (e.key === "Tab") {
        const all = allEmotes();
        const q = currentWord().replace(/^:/, "").toLowerCase();
        if (q.length >= 2) {
          const hit = all.find((x) => x.name.toLowerCase().startsWith(q)) || all.find((x) => x.name.toLowerCase().includes(q));
          if (hit) { e.preventDefault(); insertEmote(hit.name); }
        }
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; renderAc(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAc(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertEmote(acItems[acIndex].name); acBox.style.display = "none"; }
    else if (e.key === "Escape") { acBox.style.display = "none"; }
  });

  input.focus();
}

function renderNew(modal) {
  modal.innerHTML =
    '<div class="whisper-header"><button class="whisper-back">\u2039</button>' +
    '<span class="whisper-title">New whisper</span><button class="whisper-close">\u2715</button></div>' +
    '<div class="whisper-body"><div class="whisper-new-form">' +
    '<label class="whisper-new-label">Username</label>' +
    '<input type="text" class="whisper-new-input" placeholder="Twitch username" />' +
    '<button class="whisper-new-go">Open conversation</button>' +
    '<div class="whisper-new-err" style="display:none"></div>' +
    '</div></div>';
  modal.querySelector(".whisper-close").addEventListener("click", close);
  modal.querySelector(".whisper-back").addEventListener("click", () => { view = "list"; render(); });
  const input = modal.querySelector(".whisper-new-input");
  const go = modal.querySelector(".whisper-new-go");
  const err = modal.querySelector(".whisper-new-err");
  const open = async () => {
    const login = input.value.trim().replace(/^@/, "").toLowerCase();
    if (!login) return;
    go.disabled = true; go.textContent = "\u2026";
    try {
      const id = await invoke("get_user_id_for_login", { login });
      activeContact = { id: String(id), name: login };
      view = "thread";
      render();
    } catch (e) {
      err.textContent = typeof e === "string" ? e : "User not found.";
      err.style.display = "";
      go.disabled = false; go.textContent = "Open conversation";
    }
  };
  go.addEventListener("click", open);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  input.focus();
}

// Renders whisper text with inline emotes, reusing the live chat instance's already-loaded emote maps
// (7TV / BTTV / FFZ via sevenTvEmotes, plus Twitch native by name). Everything that isn't a known
// emote word is inserted as an escaped text node, so this is XSS-safe. Falls back to plain text if the
// chat emote maps aren't available yet.
function renderTextWithEmotes(container, text) {
  const map = chatRef && chatRef.sevenTvEmotes;
  const twitchByName = chatRef && chatRef.twitchNativeEmotes;
  if (!text) return;
  if (!map && !twitchByName) { container.textContent = text; return; }
  const parts = text.split(" ");
  parts.forEach((word, i) => {
    if (i > 0) container.appendChild(document.createTextNode(" "));
    const emote = map ? map.get(word) : null;
    const tw = !emote && twitchByName ? twitchByName.get(word) : null;
    const url = emote?.url
      ?? (tw ? `https://static-cdn.jtvnw.net/emoticons/v2/${tw.id}/default/dark/2.0` : null);
    if (url) {
      const img = document.createElement("img");
      img.className = "chat-emote whisper-emote";
      img.src = url;
      img.alt = word;
      img.title = word;
      img.loading = "lazy";
      container.appendChild(img);
    } else {
      container.appendChild(document.createTextNode(word));
    }
  });
}

function appendMessageEl(fromSelf, text, ts, bodyEl) {
  const body = bodyEl || (overlay && overlay.querySelector("#whisper-body"));
  if (!body) return;
  // date separator when the day changes
  const dk = dayKey(ts || Date.now());
  if (body.dataset.lastDay !== dk) {
    body.dataset.lastDay = dk;
    const sep = document.createElement("div");
    sep.className = "whisper-date-sep";
    sep.textContent = dayLabel(ts || Date.now());
    body.appendChild(sep);
  }
  const line = document.createElement("div");
  line.className = "whisper-msg" + (fromSelf ? " self" : "");
  const bubble = document.createElement("div");
  bubble.className = "whisper-bubble";
  renderTextWithEmotes(bubble, text);
  const time = document.createElement("div");
  time.className = "whisper-msg-time";
  time.textContent = fmtTime(ts);
  time.title = ts ? new Date(ts).toLocaleString() : "";
  line.appendChild(bubble);
  line.appendChild(time);
  body.appendChild(line);
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  if (atBottom) body.scrollTop = body.scrollHeight;
}

function appendSystem(text) {
  const body = overlay && overlay.querySelector("#whisper-body");
  if (!body) return;
  const line = document.createElement("div");
  line.className = "whisper-sys";
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}
