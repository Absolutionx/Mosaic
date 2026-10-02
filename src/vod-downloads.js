// VOD downloads UI: the dialog (quality, whole VOD or a time range, file name) and a small downloads panel
// with progress, cancel and "Show in folder". The work happens in Rust (downloads.rs): ffmpeg copies the
// range straight to an MP4 in the Downloads folder, no re-encoding. Twitch VODs only.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pushEscape } from "./escape-stack.js";
import { fmtDateMDY } from "./format.js";

const QUALITIES = [
  { value: "best", label: "Source" },
  { value: "720p60,720p,best", label: "720p" },
  { value: "480p,best", label: "480p" },
  { value: "audio_only", label: "Audio only" },
];

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function fmtClock(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
// "1:02:03", "62:03", "3723" -> seconds (null when not a time)
export function parseClock(text) {
  const t = String(text || "").trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  return t.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
}
// the file name, cleaned by the same rules as the Rust side (downloads.rs sanitize), so the dialog shows the
// real name: characters Windows rejects (<>:"/\|?*) become spaces
export function suggestedName(vod) {
  const date = fmtDateMDY(vod.createdAt);
  const raw = [vod.channel, vod.title].filter(Boolean).join(" - ").slice(0, 110) + (date ? ` (${date})` : "");
  const clean = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").split(/\s+/).filter(Boolean).join(" ").replace(/^[. ]+|[. ]+$/g, "");
  return clean || "Mosaic VOD";
}

// ---- dialog ----
let dialogEl = null, popDialogEscape = null;

// vod: { videoId, title, channel, createdAt, durationSecs, currentSecs? }
export function openDownloadDialog(vod) {
  closeDownloadDialog();
  const backdrop = el("div", "dl-backdrop");
  const box = el("div", "dl-dialog");
  box.setAttribute("role", "dialog");
  backdrop.appendChild(box);
  box.appendChild(el("div", "dl-title", "Download VOD"));
  box.appendChild(el("div", "dl-vod", vod.title || `VOD ${vod.videoId}`));

  let quality = "best";
  const qRow = el("div", "dl-row");
  qRow.appendChild(el("div", "dl-label", "Quality"));
  const seg = el("div", "dl-seg");
  for (const q of QUALITIES) {
    const b = el("button", "dl-seg-btn" + (q.value === quality ? " on" : ""), q.label);
    b.type = "button";
    b.addEventListener("click", () => {
      quality = q.value;
      seg.querySelectorAll(".dl-seg-btn").forEach((x) => x.classList.toggle("on", x === b));
      updateName();
    });
    seg.appendChild(b);
  }
  qRow.appendChild(seg);
  box.appendChild(qRow);

  // what to save: whole VOD, or a part between two times
  let part = false;
  const rangeRow = el("div", "dl-row dl-range-row");
  rangeRow.appendChild(el("div", "dl-label", "Save"));
  const rseg = el("div", "dl-seg");
  const wholeBtn = el("button", "dl-seg-btn on", `Whole VOD${vod.durationSecs ? ` (${fmtClock(vod.durationSecs)})` : ""}`);
  const partBtn = el("button", "dl-seg-btn", "Part");
  wholeBtn.type = partBtn.type = "button";
  rseg.append(wholeBtn, partBtn);
  rangeRow.appendChild(rseg);
  box.appendChild(rangeRow);

  const partBox = el("div", "dl-part");
  const mkTime = (label, initial) => {
    const wrap = el("label", "dl-time");
    wrap.appendChild(el("span", "dl-time-label", label));
    const input = el("input", "dl-time-input");
    input.type = "text"; input.spellcheck = false; input.placeholder = "h:mm:ss";
    input.value = initial;
    wrap.appendChild(input);
    if (vod.currentSecs != null) {
      const now = el("button", "dl-now", "Now");
      now.type = "button";
      now.title = "Use the current playback position";
      now.addEventListener("click", () => { input.value = fmtClock(vod.currentSecs); validate(); });
      wrap.appendChild(now);
    }
    return { wrap, input };
  };
  const startAt = vod.currentSecs != null ? vod.currentSecs : 0;
  const from = mkTime("From", fmtClock(startAt));
  const to = mkTime("To", fmtClock(Math.min(vod.durationSecs || startAt + 600, startAt + 600)));
  partBox.append(from.wrap, to.wrap);
  partBox.style.display = "none";
  box.appendChild(partBox);
  const setPart = (on) => {
    part = on;
    wholeBtn.classList.toggle("on", !on);
    partBtn.classList.toggle("on", on);
    partBox.style.display = on ? "" : "none";
    validate();
  };
  wholeBtn.addEventListener("click", () => setPart(false));
  partBtn.addEventListener("click", () => setPart(true));

  const nameLine = el("div", "dl-name");
  box.appendChild(nameLine);
  const err = el("div", "dl-error");
  box.appendChild(err);
  const updateName = () => {
    nameLine.textContent = `Saves to your Downloads folder as “${suggestedName(vod)}.${quality === "audio_only" ? "m4a" : "mp4"}”`;
  };
  updateName();

  const foot = el("div", "dl-foot");
  const cancel = el("button", "dl-btn", "Cancel");
  const go = el("button", "dl-btn primary", "Download");
  cancel.type = go.type = "button";
  foot.append(cancel, go);
  box.appendChild(foot);

  function range() {
    if (!part) return { start: null, end: null, ok: true };
    const s = parseClock(from.input.value), e = parseClock(to.input.value);
    if (s == null || e == null) return { ok: false, msg: "Enter times like 1:02:03 or 45:10." };
    if (e <= s) return { ok: false, msg: "The end has to be after the start." };
    if (vod.durationSecs && s >= vod.durationSecs) return { ok: false, msg: `The VOD is ${fmtClock(vod.durationSecs)} long.` };
    return { ok: true, start: s, end: vod.durationSecs ? Math.min(e, vod.durationSecs) : e };
  }
  function validate() {
    const r = range();
    err.textContent = r.ok ? "" : r.msg;
    go.disabled = !r.ok;
    return r;
  }
  from.input.addEventListener("input", validate);
  to.input.addEventListener("input", validate);

  cancel.addEventListener("click", closeDownloadDialog);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeDownloadDialog(); });
  go.addEventListener("click", async () => {
    const r = validate();
    if (!r.ok) return;
    go.disabled = true;
    go.textContent = "Starting…";
    try {
      const res = await invoke("start_vod_download", {
        videoId: String(vod.videoId), quality, startSecs: r.start, endSecs: r.end, name: suggestedName(vod),
      });
      const total = r.start != null ? r.end - r.start : (vod.durationSecs || 0);
      addDownload({ id: res.id, file: res.file, path: res.path, total });
      closeDownloadDialog();
    } catch (e) {
      err.textContent = typeof e === "string" ? e : "Couldn't start the download.";
      go.disabled = false;
      go.textContent = "Download";
    }
  });

  document.body.appendChild(backdrop);
  dialogEl = backdrop;
  popDialogEscape = pushEscape(closeDownloadDialog);
  go.focus();
}

export function closeDownloadDialog() {
  dialogEl?.remove();
  dialogEl = null;
  popDialogEscape?.();
  popDialogEscape = null;
}

// ---- downloads panel ----
const downloads = new Map(); // id -> { file, path, total, seconds, state: "running" | "done" | "failed", error }
let panelEl = null, listening = false;

async function ensureListening() {
  if (listening) return;
  listening = true;
  await listen("vod-download-progress", (e) => {
    const d = downloads.get(e.payload.id);
    if (d) { d.seconds = e.payload.seconds; renderPanel(); }
  });
  await listen("vod-download-done", (e) => {
    const d = downloads.get(e.payload.id);
    if (!d) return;
    if (e.payload.ok) { d.state = "done"; d.path = e.payload.path || d.path; d.seconds = d.total || d.seconds; }
    else if (e.payload.cancelled) downloads.delete(e.payload.id);
    else { d.state = "failed"; d.error = e.payload.error || "Download failed"; }
    renderPanel();
  });
}

function addDownload(d) {
  ensureListening();
  downloads.set(d.id, { ...d, seconds: 0, state: "running" });
  renderPanel();
}

export function hasDownloads() { return downloads.size > 0; }

function renderPanel() {
  if (!downloads.size) { panelEl?.remove(); panelEl = null; return; }
  if (!panelEl) {
    panelEl = el("div", "dl-panel");
    document.body.appendChild(panelEl);
  }
  panelEl.replaceChildren();
  const head = el("div", "dl-panel-head");
  head.appendChild(el("span", null, "Downloads"));
  const done = [...downloads.values()].filter((d) => d.state !== "running").length;
  if (done) {
    const clear = el("button", "dl-panel-clear", "Clear finished");
    clear.type = "button";
    clear.addEventListener("click", () => {
      for (const [id, d] of downloads) if (d.state !== "running") downloads.delete(id);
      renderPanel();
    });
    head.appendChild(clear);
  }
  panelEl.appendChild(head);
  for (const [id, d] of downloads) {
    const row = el("div", `dl-item ${d.state}`);
    row.appendChild(el("div", "dl-item-name", d.file));
    const pct = d.total ? Math.min(100, Math.round((d.seconds / d.total) * 100)) : null;
    const sub = d.state === "done" ? "Done"
      : d.state === "failed" ? d.error
      : pct != null ? `${pct}% · ${fmtClock(d.seconds)} of ${fmtClock(d.total)}` : `${fmtClock(d.seconds)} saved`;
    row.appendChild(el("div", "dl-item-sub", sub));
    if (d.state === "running") {
      const bar = el("div", "dl-item-bar");
      const fill = el("span");
      fill.style.width = `${pct ?? 5}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    const actions = el("div", "dl-item-actions");
    const act = (label, fn) => { const b = el("button", "dl-item-btn", label); b.type = "button"; b.addEventListener("click", fn); actions.appendChild(b); };
    if (d.state === "running") act("Cancel", () => invoke("cancel_vod_download", { id }).catch(() => {}));
    if (d.state === "done") act("Show in folder", () => invoke("reveal_download", { path: d.path }).catch(() => {}));
    if (d.state !== "running") act("Dismiss", () => { downloads.delete(id); renderPanel(); });
    row.appendChild(actions);
    panelEl.appendChild(row);
  }
}
