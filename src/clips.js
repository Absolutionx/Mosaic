// Clipping: a panel from the clip button (length, title, "you're behind live" warning, recent clips), Alt+X
// for an instant clip, and a progress card that follows the clip from "Creating" through Twitch's
// rendering to a finished clip you can play, copy, share in chat or edit on Twitch.
//
// Two ways to pick what's clipped (1.9): "Last seconds" clips the live broadcast's last 15-60 s (Helix, the web
// login); "Choose a part" clips any 5-60 s of a VOD, or of the recording Twitch is making of a live stream, on
// a timeline with start and end handles and a looping preview (create_clip_range in clip_range.rs, with the
// Twitch connection). A part is a position in that recording, so it's the moment you pick, not the live edge.
//
// create_clip (Rust) returns as soon as Twitch accepts the clip; rendering is followed here by polling
// get_clip_info. the finished clip's real length is read back, so the card never claims a length Twitch
// didn't make (Twitch's length/title options may not apply to every account)

import { invoke } from "@tauri-apps/api/core";
import { openClipPlayer } from "./chat/chat-clips.js";
import { getSetting, setSetting } from "./settings.js";
import { pushEscape } from "./escape-stack.js";
import { attachHlsVod } from "./vod-player.js";

const LENGTHS = [15, 30, 45, 60];
const RANGE_MIN = 5, RANGE_MAX = 60;
const WINDOW = 180;      // seconds of the recording the timeline shows at once
const PAN = 90;          // how far the timeline's arrows move it
const HISTORY_KEY = "myClips";
const POLL_EVERY = 2000;
const POLL_FOR = 45000; // Twitch usually renders within ~10-20s
const BEHIND_WARN = 15;  // seconds behind live before the panel warns (a few seconds is normal latency)

let deps = {};           // { getContext(), insertInChat(text), openUrl(url), setStatus(text) }
let panelEl = null, popPanelEscape = null;
let cardEl = null, cardTimer = null;
let busy = false;
let preview = null;      // the panel's own preview player while choosing a part (startPanelPreview)

export function initClips(d) {
  deps = d;
  // Alt+X: instant clip with your last length, like Twitch's own shortcut
  window.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      // on a VOD there are no "last seconds": open the panel to choose a part instead
      const ctx = deps.getContext?.() || {};
      if (!ctx.canClip && ctx.range) { toggleClipPanel(document.getElementById("clip-btn")); return; }
      createClip({ length: lastLength() });
    }
  });
}

const lastLength = () => (LENGTHS.includes(Number(getSetting("clipLength"))) ? Number(getSetting("clipLength")) : 30);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
// a position in a broadcast: 1:02:03, or 2:03 under an hour
const fmtPos = (sec) => {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
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
  const sub = el("div", "clip-panel-sub", ctx.channel ? `of ${ctx.channel}'s ${ctx.range?.kind === "vod" ? "video" : "live stream"}` : "");
  head.append(el("div", "clip-panel-title", "Create a clip"), sub);
  panelEl.appendChild(head);

  // which way to pick: the last seconds of live (live only), or a part of the recording (VODs, and live
  // streams that are being recorded). a VOD only has the second
  const canLast = !!ctx.canClip;
  const canRange = !!ctx.range && ctx.range.end >= RANGE_MIN;
  let mode = !canLast ? "range" : canRange && getSetting("clipMode") === "range" ? "range" : "last";
  if (canLast || canRange) {
    const modes = el("div", "clip-seg clip-modes");
    for (const [m, label] of [["last", "Last seconds"], ["range", "Choose a part"]]) {
      const b = el("button", "clip-seg-btn" + (m === mode ? " on" : ""), label);
      b.type = "button";
      const ok = m === "last" ? canLast : canRange;
      b.disabled = !ok;
      if (!ok) b.title = m === "last" ? "Only on live streams" : "This stream isn't being recorded by Twitch, so only its last seconds can be clipped";
      b.addEventListener("click", () => {
        if (mode === m) return;
        setSetting("clipMode", m);
        closeClipPanel();
        toggleClipPanel(anchor);
      });
      modes.appendChild(b);
    }
    panelEl.appendChild(modes);
  }

  if (mode === "range" && canRange) {
    buildRangePicker(ctx);
  } else if (!ctx.canClip) {
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
  stopPreview();
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
  const clip = { slug: res.id, edit_url: res.edit_url, url: `https://clips.twitch.tv/${res.id}`, channel: ctx.channel, title: title || "" };
  // what Twitch kept of your choices: "all", "length" (title refused) or "none" (a plain default clip)
  followClip(clip, length, optionsNote(res.options, length, title));
}

// a part of the recording ("Choose a part"): videoId is the VOD or the live stream's recording, start and
// length in seconds of it
export async function createRangeClip({ videoId, start, length, title = "", channel = "" }) {
  if (busy) return;
  busy = true;
  showCard({ state: "creating", length, range: true });
  let res;
  try {
    res = await invoke("create_clip_range", { videoId: String(videoId), start, duration: length, title: title || null });
  } catch (err) {
    busy = false;
    showCard({ state: "error", message: typeof err === "string" ? err : "Couldn't create the clip." });
    return;
  }
  busy = false;
  const clip = { slug: res.slug, edit_url: `https://clips.twitch.tv/${res.slug}/edit`, url: res.url, channel: res.channel || channel, title: res.title || title || "" };
  followClip(clip, length, res.note || "");
}

// follows a new clip through Twitch's rendering to the finished card
function followClip(clip, length, note) {
  const started = Date.now();
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
      el("div", "clip-card-sub", st.state === "creating" ? (st.range ? `The ${st.length || 30} seconds you picked` : `Last ${st.length || 30} seconds of the live stream`) : `Twitch is processing it · ${Math.round((st.elapsed || 0) / 1000)}s`));
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

// ---- "Choose a part": a timeline of the recording with start and end handles ----
// ctx.range: { videoId, kind: "vod" | "live", pos (what's on screen, seconds into the recording), end (how far
// the recording goes) }. The timeline shows WINDOW seconds at a time; its arrows move it earlier or later
function buildRangePicker(ctx) {
  const r = ctx.range;
  const end = r.end;
  const pos = Math.max(0, Math.min(end, r.pos));
  let w1 = Math.min(end, Math.max(pos + 30, Math.min(end, WINDOW)));
  let w0 = Math.max(0, w1 - WINDOW);
  // start with the 30 s just before what's on screen (or as close as the recording allows)
  let b = Math.max(w0 + RANGE_MIN, Math.min(pos, w1));
  let a = Math.max(w0, b - 30);
  if (b - a < RANGE_MIN) b = Math.min(w1, a + RANGE_MIN);

  const wrap = el("div", "clip-range");
  const nav = el("div", "clip-range-nav");
  const earlier = el("button", "clip-range-pan", "‹ Earlier");
  earlier.type = "button";
  const here = el("button", "clip-range-pan", "What's on screen");
  here.type = "button";
  const later = el("button", "clip-range-pan", "Later ›");
  later.type = "button";
  nav.append(earlier, here, later);

  const tl = el("div", "clip-tl");
  tl.setAttribute("role", "group");
  tl.setAttribute("aria-label", "The part to clip");
  const ticks = el("div", "clip-tl-ticks");
  const sel = el("div", "clip-tl-sel");
  const playMark = el("div", "clip-tl-play"); // where the preview is
  const now = el("div", "clip-tl-now");
  now.title = "What's on screen";
  const hA = el("div", "clip-tl-h start");
  const hB = el("div", "clip-tl-h end");
  for (const [h, name] of [[hA, "Start"], [hB, "End"]]) {
    h.tabIndex = 0;
    h.setAttribute("role", "slider");
    h.setAttribute("aria-label", `${name} of the clip`);
  }
  tl.append(ticks, sel, now, playMark, hA, hB);
  const edges = el("div", "clip-tl-edges");
  const e0 = el("span"), e1 = el("span");
  edges.append(e0, e1);
  const summary = el("div", "clip-range-summary");
  // the preview, like Twitch's clip editor: the part you picked plays here on repeat, with sound (your stream
  // is muted meanwhile), and jumps to whichever edge you're dragging
  const pv = el("div", "clip-pv");
  const pvVideo = el("video", "clip-pv-video");
  pvVideo.playsInline = true;
  const pvState = el("div", "clip-pv-state", "Loading preview…");
  const pvTime = el("div", "clip-pv-time");
  const pvPlay = el("button", "clip-pv-btn");
  pvPlay.type = "button";
  pvPlay.title = "Pause";
  const PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  pvPlay.innerHTML = PAUSE_ICON;
  const pvMute = el("button", "clip-pv-btn clip-pv-mute");
  pvMute.type = "button";
  const SOUND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';
  const MUTED_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m23 9-6 6M17 9l6 6"/></svg>';
  const syncMute = () => { pvMute.innerHTML = pvVideo.muted ? MUTED_ICON : SOUND_ICON; pvMute.title = pvVideo.muted ? "Unmute preview" : "Mute preview"; };
  pvMute.addEventListener("click", (e) => { e.stopPropagation(); pvVideo.muted = !pvVideo.muted; syncMute(); });
  const togglePlay = () => { if (pvVideo.paused) pvVideo.play().catch(() => {}); else pvVideo.pause(); };
  pvPlay.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
  pvVideo.addEventListener("click", togglePlay);
  pvVideo.addEventListener("play", () => { pvPlay.innerHTML = PAUSE_ICON; pvPlay.title = "Pause"; });
  pvVideo.addEventListener("pause", () => { pvPlay.innerHTML = PLAY_ICON; pvPlay.title = "Play"; });
  const pvBar = el("div", "clip-pv-bar");
  pvBar.append(pvPlay, pvTime, pvMute);
  pv.append(pvVideo, pvState, pvBar);
  syncMute();

  const pct = (t) => `${((t - w0) / (w1 - w0)) * 100}%`;
  const draw = () => {
    sel.style.left = pct(a);
    sel.style.width = `${((b - a) / (w1 - w0)) * 100}%`;
    hA.style.left = pct(a);
    hB.style.left = pct(b);
    now.style.left = pct(pos);
    now.hidden = pos < w0 || pos > w1;
    hA.setAttribute("aria-valuetext", fmtPos(a));
    hB.setAttribute("aria-valuetext", fmtPos(b));
    e0.textContent = fmtPos(w0);
    e1.textContent = w1 >= end - 1 && r.kind === "live" ? "Latest" : fmtPos(w1);
    summary.replaceChildren(el("span", "clip-range-times", `${fmtPos(a)} – ${fmtPos(b)}`), el("span", "clip-range-len", `${(Math.round((b - a) * 10) / 10).toFixed(1)} / ${RANGE_MAX}s`));
    earlier.disabled = w0 <= 0;
    later.disabled = w1 >= end;
    // a tick each 30 s, to judge lengths by
    ticks.replaceChildren();
    for (let t = Math.ceil(w0 / 30) * 30; t < w1; t += 30) { const k = el("i"); k.style.left = pct(t); ticks.appendChild(k); }
    if (preview) { preview.start = a; preview.end = b; }
    drawPlay();
  };
  // where the preview is, as a thin line on the timeline
  const drawPlay = () => {
    const t = pvVideo.currentTime;
    const on = preview && preview.ready && t >= w0 && t <= w1;
    playMark.hidden = !on;
    if (on) playMark.style.left = pct(t);
    pvTime.textContent = preview && preview.ready ? `${fmtPos(Math.max(0, t - a))} / ${fmtPos(b - a)}` : "";
  };
  pvVideo.addEventListener("timeupdate", drawPlay);
  // keep the range 5-60 s long and inside the timeline; which: the edge being moved ("a", "b" or "both")
  const set = (na, nb, which) => {
    if (which === "both") {
      const len = b - a;
      na = Math.max(w0, Math.min(w1 - len, na));
      a = na; b = na + len;
    } else if (which === "a") {
      a = Math.max(w0, Math.max(b - RANGE_MAX, Math.min(b - RANGE_MIN, na)));
    } else {
      b = Math.min(w1, Math.min(a + RANGE_MAX, Math.max(a + RANGE_MIN, nb)));
    }
    draw();
  };
  const pan = (by) => {
    const span = w1 - w0;
    w0 = Math.max(0, Math.min(end - span, w0 + by));
    w1 = w0 + span;
    // bring the selection along when it would fall off
    const len = b - a;
    if (a < w0 || b > w1) { a = Math.max(w0, Math.min(w1 - len, a < w0 ? w0 : w1 - len)); b = a + len; }
    draw();
  };
  earlier.addEventListener("click", () => pan(-PAN));
  later.addEventListener("click", () => pan(PAN));
  here.addEventListener("click", () => {
    w1 = Math.min(end, Math.max(pos + 30, Math.min(end, WINDOW)));
    w0 = Math.max(0, w1 - WINDOW);
    b = Math.max(w0 + RANGE_MIN, Math.min(pos, w1)); a = Math.max(w0, b - 30);
    draw();
  });

  // dragging: a handle moves its edge, the selection moves as a whole, a click elsewhere puts the range there
  const timeAt = (x) => { const rc = tl.getBoundingClientRect(); return w0 + Math.max(0, Math.min(1, (x - rc.left) / rc.width)) * (w1 - w0); };
  const drag = (which, down) => {
    down.preventDefault();
    const grab = timeAt(down.clientX) - a;
    tl.classList.add("dragging");
    pvVideo.pause();
    let lastScrub = 0;
    const move = (e) => {
      const t = timeAt(e.clientX);
      if (which === "both") set(t - grab, 0, "both");
      else if (which === "a") set(t, 0, "a");
      else set(0, t, "b");
      // the preview shows the frame at the edge being dragged (the end shows a moment before it)
      const now2 = performance.now();
      if (preview?.ready && now2 - lastScrub > 120) { lastScrub = now2; pvVideo.currentTime = which === "b" ? Math.max(a, b - 1) : a; }
    };
    const up = () => {
      tl.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // then plays the part from the start (or the last seconds, after moving the end)
      if (preview?.ready) {
        pvVideo.currentTime = which === "b" ? Math.max(a, b - 3) : a;
        pvVideo.play().catch(() => {});
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  hA.addEventListener("pointerdown", (e) => { e.stopPropagation(); drag("a", e); });
  hB.addEventListener("pointerdown", (e) => { e.stopPropagation(); drag("b", e); });
  sel.addEventListener("pointerdown", (e) => { e.stopPropagation(); drag("both", e); });
  tl.addEventListener("pointerdown", (e) => {
    const len = b - a;
    set(timeAt(e.clientX) - len / 2, 0, "both");
    drag("both", e);
  });
  // keyboard: arrows move an edge a second (Shift: 5)
  for (const [h, which] of [[hA, "a"], [hB, "b"]]) {
    h.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1);
      if (which === "a") set(a + step, 0, "a"); else set(0, b + step, "b");
      if (preview?.ready) pvVideo.currentTime = which === "b" ? Math.max(a, b - 3) : a;
    });
  }

  const title = el("input", "clip-title-input");
  title.type = "text";
  title.maxLength = 100;
  title.placeholder = ctx.streamTitle ? `Title (optional) · ${ctx.streamTitle}` : "Title (optional)";

  const foot = el("div", "clip-panel-foot");
  const go = el("button", "clip-go", "Clip it");
  go.type = "button";
  foot.append(el("span", "clip-panel-hint", "Drag the edges to pick the part"), go);
  const submit = () => {
    closeClipPanel();
    createRangeClip({ videoId: r.videoId, start: a, length: Math.round((b - a) * 10) / 10, title: title.value, channel: ctx.channel });
  };
  go.addEventListener("click", submit);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });

  wrap.append(pv, nav, tl, edges, summary, title);
  if (r.kind === "live") wrap.appendChild(el("div", "clip-panel-hint clip-range-hint", "Twitch saves a live stream a minute or so behind, so the newest moments can't be picked yet."));
  wrap.appendChild(foot);
  panelEl.appendChild(wrap);
  panelEl.classList.add("wide");
  draw();
  startPanelPreview(r.videoId, a, b, pvVideo, pvState, () => { drawPlay(); });
}

// the panel's preview player: the recording at small-player quality, starting at the part and looping it.
// Your stream is muted while it plays (and unmuted again when the panel closes, if Mosaic muted it)
async function startPanelPreview(videoId, start, end, video, stateEl, onReady) {
  stopPreview();
  const p = { start, end, video, hls: null, ready: false, ducked: false };
  preview = p;
  p.ducked = !!deps.duckMain?.(true);
  let url = null;
  try {
    url = await invoke("get_vod_preview_url", { videoId: String(videoId) });
  } catch {
    try { url = await invoke("get_vod_m3u8_url", { videoId: String(videoId), quality: "480p30,480p,360p30,360p,worst" }); } catch { url = null; }
  }
  if (preview !== p) return;
  if (!url) { stateEl.textContent = "The preview couldn't load. You can still clip it."; return; }
  video.volume = deps.mainVolume?.() ?? 1;
  p.hls = attachHlsVod(video, url, { startPosition: start, smallPlayer: true, logPrefix: "[clip-preview]",
    onFatalError: () => { if (preview === p) stateEl.textContent = "The preview stopped. You can still clip it."; } });
  video.addEventListener("playing", () => { if (preview !== p) return; p.ready = true; stateEl.hidden = true; onReady?.(); }, { once: true });
  // loop the part: back to its start at its end (and if it ever wanders outside it)
  p.onTime = () => {
    if (preview !== p || !p.ready || video.seeking) return;
    const t = video.currentTime;
    if (t >= p.end || t < p.start - 1) { video.currentTime = p.start; video.play().catch(() => {}); }
  };
  video.addEventListener("timeupdate", p.onTime);
  video.play().catch(() => {});
}
function stopPreview() {
  const p = preview;
  if (!p) return;
  preview = null;
  if (p.onTime) p.video.removeEventListener("timeupdate", p.onTime);
  try { p.hls?.destroy(); } catch { /* ignore */ }
  try { p.video.pause(); p.video.removeAttribute("src"); p.video.load(); } catch { /* ignore */ }
  if (p.ducked) deps.duckMain?.(false);
}
