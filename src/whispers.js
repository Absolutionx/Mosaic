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
    '<input type="text" class="whisper-input" placeholder="Send a whisper\u2026" maxlength="500" />' +
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
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSend(); } });
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
  bubble.textContent = text;
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
