// Moderator action log. Two sources: channel.moderate (emitted as "eventsub-moderate") gives rich,
// mod-only detail ("Mod X timed out Y") but only on channels you moderate; CLEARCHAT/CLEARMSG (public,
// emitted as "chat-clearchat"/"chat-clearmsg") give the bans/timeouts/deletions every viewer sees, so the
// log also works where you're not a mod. Public entries are delayed slightly and deduped against the
// richer EventSub ones so a moderated channel doesn't log each action twice. Session-scoped.

import { listen } from "@tauri-apps/api/event";

const LOG_MAX = 300;
let log = [];
let modMessages = [];
let activeTab = "actions"; // "actions" | "modchat"
let started = false;
let panelBody = null; // set while the panel is open, for live updates
let unread = 0;
const recentKeys = new Map(); // dedup key -> timestamp
let chatRef = null; // for reusing the chat renderer's emote resolution in the Mod Chat tab

function markKey(key) {
  if (!key) return;
  recentKeys.set(key, Date.now());
  const cutoff = Date.now() - 10000;
  for (const [k, t] of recentKeys) if (t < cutoff) recentKeys.delete(k);
}
function seenRecently(key, windowMs = 4000) {
  const t = recentKeys.get(key);
  return t != null && Date.now() - t < windowMs;
}

function pushEntry(entry) {
  log.unshift(entry);
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  if (panelBody) renderInto(panelBody);
  else { unread++; updateDot(); }
}

export function initModLog(chat) {
  if (started) return;
  started = true;
  chatRef = chat || null;

  // rich, mod-only actions
  listen("eventsub-moderate", (e) => {
    const entry = parseModerate(e.payload);
    if (!entry) return;
    if (entry.dedupKey) markKey(entry.dedupKey);
    pushEntry(entry);
  }).catch(() => {});

  // public bans/timeouts + whole-chat clears (visible on any channel)
  listen("chat-clearchat", (e) => {
    const p = e.payload || {};
    let text, key;
    if (!p.target_username && !p.target_user_id) {
      text = "chat was cleared"; key = "clear";
    } else if (p.ban_duration_secs) {
      text = `${p.target_username} was timed out for ${fmtDur(p.ban_duration_secs)}`;
      key = `timeout:${(p.target_username || "").toLowerCase()}`;
    } else {
      text = `${p.target_username} was banned`;
      key = `ban:${(p.target_username || "").toLowerCase()}`;
    }
    // let a richer channel.moderate entry (when you moderate here) win the dedup
    setTimeout(() => {
      if (seenRecently(key)) return;
      markKey(key);
      pushEntry({ time: Date.now(), mod: "", text, category: key === "clear" ? "delete" : (key.startsWith("timeout") ? "timeout" : "ban") });
    }, 900);
  }).catch(() => {});

  // public single-message deletions
  listen("chat-clearmsg", (e) => {
    const p = e.payload || {};
    const key = `delete:${p.target_msg_id || ""}`;
    setTimeout(() => {
      if (seenRecently(key)) return;
      markKey(key);
      pushEntry({ time: Date.now(), mod: "", text: "a message was deleted", category: "delete" });
    }, 900);
  }).catch(() => {});

  // capture messages sent by mods/broadcaster for the "Mod Chat" tab. own messages don't arrive over
  // "chat-message" (IRC never echoes them), so they come via the "mosaic-own-message" window event.
  listen("chat-message", (e) => captureModMessage(e.payload || {})).catch(() => {});
  window.addEventListener("mosaic-own-message", (e) => captureModMessage((e && e.detail) || {}));
}

function captureModMessage(p) {
  const badges = p.badges || "";
  const isMod = badges.split(",").some((b) => b.startsWith("moderator/") || b.startsWith("broadcaster/"));
  if (!isMod || !p.message) return;
  modMessages.push({
    time: Date.now(),
    username: p.username || "",
    color: p.color || "#9147ff",
    message: p.message,
    emotesTag: p.emotes_tag || null,
    broadcaster: badges.split(",").some((b) => b.startsWith("broadcaster/")),
  });
  if (modMessages.length > LOG_MAX) modMessages.shift();
  if (panelBody && activeTab === "modchat") renderInto(panelBody);
}

export function clearModLog() {
  log = [];
  modMessages = [];
  unread = 0;
  recentKeys.clear();
  updateDot();
  if (panelBody) renderInto(panelBody);
}

function updateDot() {
  const btn = document.getElementById("modlog-btn");
  if (btn) btn.classList.toggle("has-unread", unread > 0);
}

function fmtDur(s) {
  if (s >= 86400) return `${Math.round(s / 86400)}d`;
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${s}s`;
}

function parseModerate(ev) {
  if (!ev || !ev.action) return null;
  const mod = ev.moderator_user_name || ev.moderator_user_login || "A mod";
  const target = (o) => (o && (o.user_name || o.user_login)) || "someone";
  const a = ev.action;
  let text;
  let dedupKey = null;
  switch (a) {
    case "ban": text = `banned ${target(ev.ban)}${ev.ban && ev.ban.reason ? ` — ${ev.ban.reason}` : ""}`; dedupKey = `ban:${target(ev.ban).toLowerCase()}`; break;
    case "timeout": {
      const t = ev.timeout || {};
      let dur = "";
      if (t.expires_at) { const s = Math.round((Date.parse(t.expires_at) - Date.now()) / 1000); if (s > 0) dur = ` for ${fmtDur(s)}`; }
      text = `timed out ${target(t)}${dur}${t.reason ? ` — ${t.reason}` : ""}`;
      dedupKey = `timeout:${target(t).toLowerCase()}`;
      break;
    }
    case "unban": text = `unbanned ${target(ev.unban)}`; break;
    case "untimeout": text = `removed timeout on ${target(ev.untimeout)}`; break;
    case "delete": text = `deleted a message from ${target(ev.delete)}`; dedupKey = ev.delete && ev.delete.message_id ? `delete:${ev.delete.message_id}` : null; break;
    case "clear": text = "cleared chat"; dedupKey = "clear"; break;
    case "emoteonly": text = "enabled emote-only"; break;
    case "emoteonlyoff": text = "disabled emote-only"; break;
    case "followers": text = "enabled followers-only"; break;
    case "followersoff": text = "disabled followers-only"; break;
    case "subscribers": text = "enabled subscribers-only"; break;
    case "subscribersoff": text = "disabled subscribers-only"; break;
    case "slow": text = "enabled slow mode"; break;
    case "slowoff": text = "disabled slow mode"; break;
    case "uniquechat": text = "enabled unique-chat"; break;
    case "uniquechatoff": text = "disabled unique-chat"; break;
    case "mod": text = `modded ${target(ev.mod)}`; break;
    case "unmod": text = `unmodded ${target(ev.unmod)}`; break;
    case "vip": text = `added ${target(ev.vip)} as VIP`; break;
    case "unvip": text = `removed VIP from ${target(ev.unvip)}`; break;
    case "raid": text = `raided ${(ev.raid && ev.raid.user_name) || "a channel"}`; break;
    case "unraid": text = "cancelled the raid"; break;
    case "warn": text = `warned ${target(ev.warn)}${ev.warn && ev.warn.reason ? ` — ${ev.warn.reason}` : ""}`; break;
    case "add_blocked_term": text = "added a blocked term"; break;
    case "remove_blocked_term": text = "removed a blocked term"; break;
    case "add_permitted_term": text = "permitted a term"; break;
    case "remove_permitted_term": text = "un-permitted a term"; break;
    case "approve_unban_request": text = `approved an unban request from ${target(ev.approve_unban_request)}`; break;
    case "deny_unban_request": text = `denied an unban request from ${target(ev.deny_unban_request)}`; break;
    default: text = a.replace(/_/g, " ");
  }
  return { time: Date.now(), mod, text, dedupKey, category: catFor(a) };
}

// StreamNook-style category grouping for color-coding
function catFor(a) {
  if (a === "ban") return "ban";
  if (a === "timeout") return "timeout";
  if (a === "delete" || a === "clear") return "delete";
  if (a === "unban" || a === "untimeout" || a === "unraid") return "reversal";
  if (a === "mod" || a === "unmod" || a === "vip" || a === "unvip") return "role";
  if (a === "warn") return "warn";
  if ([
    "emoteonly", "emoteonlyoff", "followers", "followersoff", "subscribers",
    "subscribersoff", "slow", "slowoff", "uniquechat", "uniquechatoff",
  ].includes(a)) return "mode";
  return "other";
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function timeStr(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderInto(body) {
  if (activeTab === "modchat") {
    if (!modMessages.length) {
      body.innerHTML = `<div class="chat-filter-intro">No messages from mods or the broadcaster yet this session.</div>`;
      return;
    }
    body.replaceChildren();
    for (const m of modMessages.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "modchat-row";
      const t = document.createElement("span");
      t.className = "modlog-time";
      t.textContent = timeStr(m.time);
      const u = document.createElement("span");
      u.className = "modchat-user" + (m.broadcaster ? " is-broadcaster" : "");
      u.style.color = m.color;
      u.textContent = m.username;
      const txt = document.createElement("span");
      txt.className = "modchat-text";
      // reuse the chat renderer so Twitch/7TV/BTTV/FFZ emotes resolve exactly as in chat
      if (chatRef && typeof chatRef.renderMessageBody === "function") {
        // _filteredBody applies the chat filter's blocked emotes, same as everywhere else
        try {
          txt.appendChild(typeof chatRef._filteredBody === "function"
            ? chatRef._filteredBody(m.message, m.emotesTag || null, m.username)
            : chatRef.renderMessageBody(m.message, m.emotesTag || null));
        }
        catch { txt.textContent = m.message; }
      } else {
        txt.textContent = m.message;
      }
      row.appendChild(t);
      row.appendChild(document.createTextNode(" "));
      row.appendChild(u);
      row.appendChild(document.createTextNode(" "));
      row.appendChild(txt);
      body.appendChild(row);
    }
    return;
  }
  if (!log.length) {
    body.innerHTML = `<div class="chat-filter-intro">No mod actions yet this session. Bans, timeouts, and deletions show here on any channel; extra detail (who did it, warnings, blocked terms) appears on channels you moderate.</div>`;
    return;
  }
  body.innerHTML = log
    .map((e) => {
      const modPart = e.mod ? `<span class="modlog-mod">${esc(e.mod)}</span> ` : "";
      return `<div class="modlog-row modlog-cat-${esc(e.category || "other")}"><span class="modlog-time">${timeStr(e.time)}</span> ${modPart}<span class="modlog-text">${esc(e.text)}</span></div>`;
    })
    .join("");
}

export function openModLogModal() {
  unread = 0;
  updateDot();
  const overlay = document.createElement("div");
  overlay.className = "chat-filter-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModLog(overlay); });
  const modal = document.createElement("div");
  modal.className = "chat-filter-modal modlog-modal";
  overlay.appendChild(modal);

  const header = document.createElement("div");
  header.className = "chat-filter-header";
  header.innerHTML = `<span>Mod Actions</span>`;
  const x = document.createElement("button");
  x.className = "chat-filter-close";
  x.textContent = "\u2715";
  x.addEventListener("click", () => closeModLog(overlay));
  header.appendChild(x);
  modal.appendChild(header);

  const tabs = document.createElement("div");
  tabs.className = "modlog-tabs";
  const mkTab = (id, label) => {
    const t = document.createElement("button");
    t.className = "modlog-tab" + (activeTab === id ? " active" : "");
    t.textContent = label;
    t.addEventListener("click", () => {
      activeTab = id;
      for (const el of tabs.children) el.classList.toggle("active", el === t);
      if (panelBody) renderInto(panelBody);
    });
    return t;
  };
  tabs.appendChild(mkTab("actions", "Actions"));
  tabs.appendChild(mkTab("modchat", "Mod Chat"));
  modal.appendChild(tabs);

  const body = document.createElement("div");
  body.className = "modlog-body";
  modal.appendChild(body);
  panelBody = body;
  renderInto(body);

  document.body.appendChild(overlay);
  const onEsc = (e) => { if (e.key === "Escape") { closeModLog(overlay); document.removeEventListener("keydown", onEsc); } };
  document.addEventListener("keydown", onEsc);
}

function closeModLog(overlay) {
  panelBody = null;
  overlay.remove();
}
