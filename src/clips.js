// Clipping: a panel from the clip button (length, title, "you're behind live" warning, recent clips), Alt+X
// for an instant clip, and a progress card that follows the clip from "Creating" through Twitch's
// rendering to a finished clip you can play, copy, share in chat or edit on Twitch.
//
// create_clip (Rust) returns as soon as Twitch accepts the clip; rendering is followed here by polling
// get_clip_info. the finished clip's real length is read back, so the card never claims a length Twitch
// didn't make (Twitch's length/title options may not apply to every account)

import { invoke } from "@tauri-apps/api/core";
import { openClipPlayer } from "./chat/chat-clips.js";
import { getSetting, setSetting } from "./settings.js";
import { pushEscape } from "./escape-stack.js";

const LENGTHS = [15, 30, 45, 60];
const HISTORY_KEY = "myClips";
const POLL_EVERY = 2000;
const POLL_FOR = 45000; // Twitch usually renders within ~10-20s
const BEHIND_WARN = 15;  // seconds behind live before the panel warns (a few seconds is normal latency)

let deps = {};           // { getContext(), insertInChat(text), openUrl(url), setStatus(text) }
let panelEl = null, popPanelEscape = null;
let cardEl = null, cardTimer = null;
let busy = false;

export function initClips(d) {
  deps = d;
  // Alt+X: instant clip with your last length, like Twitch's own shortcut
  window.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      createClip({ length: lastLength() });
    }
  });
}

const lastLength = () => (LENGTHS.includes(Number(getSetting("clipLength"))) ? Number(getSetting("clipLength")) : 30);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function recentClips() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; }
}
function remember(clip) {
  const list = recentClips().filter((c) => c.slug !== clip.slug);
  list.unshift(clip);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* ignore */ }
}

// ---- the panel (clip button) ----
export function toggleClipPanel(anchor) {
  if (panelEl) { closeClipPanel(); return; }
  const ctx = deps.getContext?.() || {};
  panelEl = el("div", "clip-panel");
  const head = el("div", "clip-panel-head");
  head.append(el("div", "clip-panel-title", "Create a clip"), el("div", "clip-panel-sub", ctx.channel ? `of ${ctx.channel}'s live stream` : ""));
  panelEl.appendChild(head);

  if (!ctx.canClip) {
    panelEl.appendChild(el("div", "clip-panel-note", ctx.reason || "Clips work on live Twitch streams."));
  } else {
    const lenRow = el("div", "clip-panel-row");
    lenRow.appendChild(el("div", "clip-panel-label", "Length"));
    const seg = el("div", "clip-seg");
    let length = lastLength();
    for (const L of LENGTHS) {
      const b = el("button", "clip-seg-btn" + (L === length ? " on" : ""), `${L}s`);
      b.type = "button";
      b.addEventListener("click", () => {
        length = L;
        seg.querySelectorAll(".clip-seg-btn").forEach((x) => x.classList.toggle("on", x === b));
      });
      seg.appendChild(b);
    }
    lenRow.appendChild(seg);
    panelEl.appendChild(lenRow);

    const title = el("input", "clip-title-input");
    title.type = "text";
    title.maxLength = 100;
    title.placeholder = ctx.streamTitle ? `Title (optional) · ${ctx.streamTitle}` : "Title (optional)";
    panelEl.appendChild(title);

    // Twitch clips the live broadcast: say so when what's on screen is well behind it
    const behind = ctx.behindLive;
    if (behind == null && ctx.rewound) {
      panelEl.appendChild(el("div", "clip-panel-warn", "You're watching a rewound part of the stream. Clips are of the live broadcast, not what's on screen."));
    } else if (behind != null && behind > BEHIND_WARN) {
      panelEl.appendChild(el("div", "clip-panel-warn", `You're ${fmtTime(behind)} behind live. The clip will be of the live broadcast, not what's on screen.`));
    }

    const go = el("button", "clip-go", "Clip it");
    go.type = "button";
    const submit = () => {
      setSetting("clipLength", length);
      closeClipPanel();
      createClip({ length, title: title.value });
    };
    go.addEventListener("click", submit);
    title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    const foot = el("div", "clip-panel-foot");
    foot.append(el("span", "clip-panel-hint", "Alt+X clips instantly"), go);
    panelEl.appendChild(foot);
    setTimeout(() => title.focus(), 0);
  }

  const recent = recentClips();
  if (recent.length) {
    panelEl.appendChild(el("div", "clip-panel-label clip-recent-label", "Your recent clips"));
    const list = el("div", "clip-recent");
    for (const c of recent.slice(0, 6)) {
      const row = el("button", "clip-recent-row");
      row.type = "button";
      const img = el("img", "clip-recent-thumb");
      img.alt = ""; img.loading = "lazy";
      if (c.thumbnail) img.src = c.thumbnail;
      const text = el("span", "clip-recent-text");
      text.append(el("span", "clip-recent-title", c.title || "Clip"), el("span", "clip-recent-sub", [c.channel, c.duration ? `${Math.round(c.duration)}s` : ""].filter(Boolean).join(" · ")));
      row.append(img, text);
      row.addEventListener("click", () => { closeClipPanel(); openClipPlayer(c); });
      list.appendChild(row);
    }
    panelEl.appendChild(list);
  }

  document.body.appendChild(panelEl);
  const r = (anchor || document.body).getBoundingClientRect();
  panelEl.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  panelEl.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
  popPanelEscape = pushEscape(closeClipPanel);
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}

function onOutside(e) {
  if (panelEl && !panelEl.contains(e.target) && !e.target.closest?.("#clip-btn")) closeClipPanel();
}

export function closeClipPanel() {
  panelEl?.remove();
  panelEl = null;
  popPanelEscape?.();
  popPanelEscape = null;
  document.removeEventListener("mousedown", onOutside, true);
}

// ---- creating + the progress card ----
export async function createClip({ length = 30, title = "" } = {}) {
  const ctx = deps.getContext?.() || {};
  if (!ctx.canClip) { showCard({ state: "error", message: ctx.reason || "Clips work on live Twitch streams." }); return; }
  if (busy) return; // one at a time
  busy = true;
  showCard({ state: "creating", length });
  let res;
  try {
    res = await invoke("create_clip", { broadcasterId: ctx.roomId, duration: length, title: title || null });
  } catch (err) {
    busy = false;
    showCard({ state: "error", message: typeof err === "string" ? err : "Couldn't create the clip." });
    return;
  }
  busy = false;
  const started = Date.now();
  const clip = { slug: res.id, edit_url: res.edit_url, url: `https://clips.twitch.tv/${res.id}`, channel: ctx.channel, title: title || "" };
  // what Twitch kept of your choices: "all", "length" (title refused) or "none" (a plain default clip)
  const note = optionsNote(res.options, length, title);
  showCard({ state: "rendering", clip, elapsed: 0, requested: length, note });
  const poll = async () => {
    if (!cardEl || cardEl.dataset.slug !== clip.slug) return; // dismissed / replaced
    let info = null;
    try { info = await invoke("get_clip_info", { slug: clip.slug }); } catch { /* not there yet */ }
    const elapsed = Date.now() - started;
    const ready = info && info.thumbnail && !String(info.thumbnail).includes("processing");
    if (ready) {
      const done = { ...clip, ...info, slug: clip.slug, edit_url: clip.edit_url };
      remember({ slug: done.slug, title: done.title, channel: done.channel, duration: done.duration, thumbnail: done.thumbnail, url: done.url, views: done.views, creator: done.creator });
      showCard({ state: "ready", clip: done, requested: length, note });
      return;
    }
    if (elapsed > POLL_FOR) {
      showCard({ state: "slow", clip });
      return;
    }
    showCard({ state: "rendering", clip, elapsed, requested: length, note });
    cardTimer = setTimeout(poll, POLL_EVERY);
  };
  cardTimer = setTimeout(poll, POLL_EVERY);
}

// a plain explanation when Twitch didn't take everything you picked
function optionsNote(options, length, title) {
  if (options === "none" && (length !== 30 || title)) {
    return "Twitch didn't accept a custom length or title here, so this is a regular clip.";
  }
  if (options === "length" && title) return "Twitch didn't accept the title. Add one with Edit on Twitch.";
  return "";
}

function hideCard() {
  clearTimeout(cardTimer);
  cardEl?.remove();
  cardEl = null;
}

function showCard(st) {
  clearTimeout(cardTimer);
  if (!cardEl) {
    cardEl = el("div", "clip-card");
    (document.getElementById("video-region") || document.body).appendChild(cardEl);
  }
  cardEl.dataset.slug = st.clip ? st.clip.slug : "";
  cardEl.className = `clip-card ${st.state}`;
  cardEl.replaceChildren();
  const close = el("button", "clip-card-close");
  close.type = "button";
  close.title = "Dismiss";
  close.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  close.addEventListener("click", hideCard);

  if (st.state === "creating" || st.state === "rendering") {
    const body = el("div", "clip-card-body");
    body.append(el("div", "clip-card-title", st.state === "creating" ? "Creating clip…" : "Rendering clip…"),
      el("div", "clip-card-sub", st.state === "creating" ? `Last ${st.length || 30} seconds of the live stream` : `Twitch is processing it · ${Math.round((st.elapsed || 0) / 1000)}s`));
    const bar = el("div", "clip-card-bar");
    const fill = el("span");
    fill.style.width = st.state === "creating" ? "8%" : `${Math.min(92, 10 + ((st.elapsed || 0) / 20000) * 82)}%`;
    bar.appendChild(fill);
    body.appendChild(bar);
    if (st.note) body.appendChild(el("div", "clip-card-note", st.note)); // known as soon as Twitch answers
    cardEl.append(body, close);
    return;
  }
  if (st.state === "error") {
    cardEl.append(el("div", "clip-card-body", null), close);
    cardEl.querySelector(".clip-card-body").append(el("div", "clip-card-title", "Couldn't create a clip"), el("div", "clip-card-sub", st.message || ""));
    cardTimer = setTimeout(hideCard, 8000);
    return;
  }

  const c = st.clip;
  const thumb = el("button", "clip-card-thumb");
  thumb.type = "button";
  thumb.title = "Play";
  if (c.thumbnail) {
    const img = el("img"); img.alt = ""; img.src = c.thumbnail;
    thumb.appendChild(img);
  }
  thumb.insertAdjacentHTML("beforeend", '<span class="clip-card-play"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>');
  if (st.state === "ready") thumb.addEventListener("click", () => openClipPlayer(c)); else thumb.disabled = true;

  const body = el("div", "clip-card-body");
  const len = Number(c.duration) || 0;
  let sub;
  if (st.state === "slow") sub = "Twitch is taking longer than usual to render it. The link already works.";
  else {
    sub = `${c.channel || ""}${len ? ` · ${Math.round(len)}s` : ""}`;
    // be honest when Twitch made a different length than asked for
    if (len && st.requested && Math.abs(len - st.requested) > 2) sub += ` (Twitch made a ${Math.round(len)}s clip)`;
  }
  body.append(el("div", "clip-card-title", st.state === "slow" ? "Clip created" : (c.title || "Clip ready")), el("div", "clip-card-sub", sub));
  if (st.note) body.appendChild(el("div", "clip-card-note", st.note));
  const actions = el("div", "clip-card-actions");
  const act = (label, fn) => { const b = el("button", "clip-card-btn", label); b.type = "button"; b.addEventListener("click", fn); actions.appendChild(b); return b; };
  if (st.state === "ready") act("Play", () => openClipPlayer(c));
  const copy = act("Copy link", () => {
    navigator.clipboard.writeText(c.url).then(() => { copy.textContent = "Copied ✓"; setTimeout(() => { copy.textContent = "Copy link"; }, 1500); }).catch(() => {});
  });
  act("Share in chat", () => { deps.insertInChat?.(c.url); });
  if (c.edit_url) act("Edit on Twitch", () => deps.openUrl?.(c.edit_url));
  body.appendChild(actions);
  cardEl.append(thumb, body, close);
  // a finished card stays long enough to use, then clears (hovering keeps it)
  const schedule = () => { cardTimer = setTimeout(() => { if (cardEl && !cardEl.matches(":hover")) hideCard(); else schedule(); }, 25000); };
  schedule();
}
