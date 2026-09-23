// "Track ID": grabs a few seconds of whatever's playing and asks the Rust backend to identify the
// song. Capture is off the <video> via captureStream() (never touches the element's own audio routing,
// so playback isn't muted), then resampled to mono 16 kHz i16 PCM — the exact format the native Shazam
// fingerprinter in song_id/ expects. Works the same for Twitch and Kick, live and VOD.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relativeDate } from "./format.js";

// how long to listen; Shazam matches on ~5s+, a little longer rides out talking/noise
const CAPTURE_SECONDS = 8;
const OUT_RATE = 16000;

// identification history (localStorage): most recent first, capped. Identifying the same song again
// within DEDUP_MS just refreshes that entry instead of adding a duplicate
const HISTORY_KEY = "trackIdHistory";
const HISTORY_MAX = 50;
const DEDUP_MS = 10 * 60 * 1000;

function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr.filter((e) => e && e.title) : [];
  } catch { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch { /* quota */ }
}

export class TrackId {
  // getContext() -> { channel, vod }: what was playing, recorded with each history entry
  constructor(videoEl, { getContext } = {}) {
    this.videoEl = videoEl;
    this.getContext = getContext || (() => ({ channel: "", vod: false }));
    this.btn = document.getElementById("track-id-btn");
    this.panel = document.getElementById("track-id-panel");
    this.busy = false;
    this._clearArmed = false;

    if (this.btn) {
      this.btn.addEventListener("click", () => this.identify());
      // right-click: jump straight to history without listening
      this.btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!this.busy) this.showHistory();
      });
      if (this.btn.title && !this.btn.title.includes("right-click")) {
        this.btn.title += " (right-click for history)";
      }
    }
    // close on outside click. uses the event's composed path (fixed when the click is dispatched), not
    // panel.contains(target): moving between views re-renders the panel, detaching the clicked button
    // before this runs, which would otherwise read as an "outside" click and close the panel
    document.addEventListener("click", (e) => {
      if (!this.panel || this.panel.style.display === "none") return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(this.panel) || (this.btn && path.includes(this.btn))) return;
      this._hide();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._hide();
    });
  }

  async identify() {
    if (this.busy) return;
    const v = this.videoEl;
    if (!v || v.readyState < 2 || v.paused || v.ended || v.muted) {
      this._render(`<div class="track-id-status">Play the stream (unmuted) first.</div>`);
      return;
    }

    this.busy = true;
    this.btn?.classList.add("loading");
    this._render(`<div class="track-id-status"><span class="track-id-spinner"></span>Listening&hellip;</div>`);

    try {
      const audioB64 = await this._capturePcmBase64(CAPTURE_SECONDS);
      this._render(`<div class="track-id-status"><span class="track-id-spinner"></span>Identifying&hellip;</div>`);
      const match = await invoke("identify_song", { audioB64 });
      if (match && match.title) {
        this._addToHistory(match);
        this._renderMatch(match);
      } else {
        this._render(
          `<div class="track-id-status">No match found.</div><div class="track-id-sub">Try again during a clearer stretch of the song.</div>` +
          this._historyFooter()
        );
        this._wireFooter();
      }
    } catch (err) {
      const msg = typeof err === "string" ? err : err?.message || "Something went wrong.";
      this._render(`<div class="track-id-status">Couldn't identify.</div><div class="track-id-sub">${escapeHtml(msg)}</div>` + this._historyFooter());
      this._wireFooter();
    } finally {
      this.busy = false;
      this.btn?.classList.remove("loading");
    }
  }

  // capture CAPTURE_SECONDS of mono audio off the element, resample to 16 kHz i16 PCM, base64-encode
  async _capturePcmBase64(seconds) {
    const capture = this.videoEl.captureStream || this.videoEl.mozCaptureStream;
    if (!capture) throw new Error("this webview can't capture audio from the player.");
    const stream = capture.call(this.videoEl);
    if (!stream || stream.getAudioTracks().length === 0) {
      throw new Error("no audio track is playing to identify.");
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    if (ac.state === "suspended") await ac.resume();

    const source = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0; // capture adds no audible output

    const chunks = [];
    let collected = 0;
    const target = Math.floor(ac.sampleRate * seconds);

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(ch));
        collected += ch.length;
        if (collected >= target) finish();
      };
      source.connect(proc);
      proc.connect(mute);
      mute.connect(ac.destination);
      setTimeout(finish, (seconds + 3) * 1000);
    });

    const inRate = ac.sampleRate;
    try { proc.disconnect(); mute.disconnect(); source.disconnect(); } catch {}
    ac.close().catch(() => {});
    if (collected === 0) throw new Error("captured no audio (is the player muted at the source?).");

    // flatten -> resample to 16 kHz mono i16 -> base64 (raw PCM, no WAV header)
    const merged = new Float32Array(collected);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    const pcm = toMono16kPcm(merged, inRate, OUT_RATE);
    if (pcm.length < OUT_RATE) throw new Error("not enough audio captured.");
    return pcmToBase64(pcm);
  }

  // ---- history ----
  _addToHistory(m) {
    const ctx = (() => { try { return this.getContext() || {}; } catch { return {}; } })();
    const entry = {
      title: m.title || "",
      artist: m.artist || "",
      album_art: m.album_art || "",
      providers: Array.isArray(m.providers) ? m.providers.slice(0, 4).map((p) => ({ name: p.name, url: p.url })) : [],
      song_link: m.song_link || "",
      shazam_url: m.shazam_url || "",
      channel: ctx.channel || "",
      vod: !!ctx.vod,
      at: new Date().toISOString(),
    };
    const list = loadHistory();
    const top = list[0];
    if (top && top.title === entry.title && top.artist === entry.artist &&
        Date.now() - new Date(top.at).getTime() < DEDUP_MS) {
      list[0] = entry; // same song again within a few minutes: refresh it, don't duplicate
    } else {
      list.unshift(entry);
    }
    saveHistory(list);
  }

  _historyFooter() {
    const n = loadHistory().length;
    if (!n) return "";
    return `<div class="track-id-footer"><button type="button" class="track-id-footer-btn" data-act="history">History (${n})</button></div>`;
  }

  _wireFooter() {
    this.panel?.querySelector('[data-act="history"]')?.addEventListener("click", () => this.showHistory());
  }

  showHistory() {
    const list = loadHistory();
    this._clearArmed = false;
    let body;
    if (!list.length) {
      body = `<div class="track-id-empty">No songs identified yet. Click the Track ID button while music is playing.</div>`;
    } else {
      body = `<div class="track-id-hist-list">` + list.map((e, i) => {
        const cover = e.album_art
          ? `<img class="track-id-hist-cover" src="${escapeAttr(e.album_art)}" alt="" />`
          : `<div class="track-id-hist-cover track-id-hist-cover-empty">&#9835;</div>`;
        const when = relativeDate(e.at);
        const where = e.channel ? `${escapeHtml(e.channel)}${e.vod ? " (VOD)" : ""} · ` : "";
        return (
          `<div class="track-id-hist-item" data-i="${i}" role="button" tabindex="0" title="Show links">` +
            cover +
            `<div class="track-id-hist-meta">` +
              `<div class="track-id-hist-title">${escapeHtml(e.title)}</div>` +
              `<div class="track-id-hist-artist">${escapeHtml(e.artist)}</div>` +
              `<div class="track-id-hist-when">${where}${escapeHtml(when)}</div>` +
            `</div>` +
            `<button type="button" class="track-id-hist-remove" data-i="${i}" title="Remove from history" aria-label="Remove from history">` +
              `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>` +
            `</button>` +
          `</div>`
        );
      }).join("") + `</div>`;
    }
    this._render(
      `<div class="track-id-hist-head">` +
        `<span class="track-id-hist-heading">Recently identified</span>` +
        (list.length ? `<button type="button" class="track-id-footer-btn track-id-hist-clear" data-act="clear">Clear</button>` : "") +
      `</div>` + body,
      "history"
    );
    const p = this.panel;
    p.querySelectorAll(".track-id-hist-item").forEach((el) => {
      const open = () => {
        const e = loadHistory()[Number(el.getAttribute("data-i"))];
        if (e) this._renderMatch(e, { fromHistory: true });
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
    });
    p.querySelectorAll(".track-id-hist-remove").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const next = loadHistory();
        next.splice(Number(btn.getAttribute("data-i")), 1);
        saveHistory(next);
        this.showHistory();
      });
    });
    // two-step clear so one stray click can't wipe the whole history
    p.querySelector('[data-act="clear"]')?.addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      if (!this._clearArmed) {
        this._clearArmed = true;
        btn.textContent = "Clear all?";
        btn.classList.add("armed");
        return;
      }
      saveHistory([]);
      this.showHistory();
    });
  }

  _renderMatch(m, { fromHistory = false } = {}) {
    const cover = m.album_art
      ? `<img class="track-id-cover" src="${escapeAttr(m.album_art)}" alt="" />`
      : "";
    // prefer per-service links; fall back to song.link / Shazam
    let links = "";
    if (Array.isArray(m.providers) && m.providers.length) {
      links =
        `<div class="track-id-links">` +
        m.providers
          .slice(0, 4)
          .map((p) => `<button class="track-id-link" data-url="${escapeAttr(p.url)}">${escapeHtml(p.name)}</button>`)
          .join("") +
        `</div>`;
    } else {
      const url = m.song_link || m.shazam_url;
      if (url) links = `<div class="track-id-links"><button class="track-id-link" data-url="${escapeAttr(url)}">Open</button></div>`;
    }
    this._render(`
      <div class="track-id-result">
        ${cover}
        <div class="track-id-meta">
          <div class="track-id-title">${escapeHtml(m.title)}</div>
          <div class="track-id-artist">${escapeHtml(m.artist || "")}</div>
          ${links}
        </div>
      </div>
      ${fromHistory
        ? `<div class="track-id-footer"><button type="button" class="track-id-footer-btn" data-act="history">&larr; Back to history</button></div>`
        : this._historyFooter()}
    `);
    this._wireFooter();
    this.panel.querySelectorAll(".track-id-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = btn.getAttribute("data-url");
        if (u) openUrl(u).catch(() => {});
      });
    });
  }

  _render(html, mode = "") {
    if (!this.panel) return;
    this.panel.classList.toggle("is-history", mode === "history");
    this.panel.innerHTML = html;
    this.panel.style.display = "block";
    this._position();
  }

  _hide() {
    if (this.panel) this.panel.style.display = "none";
  }

  _position() {
    if (!this.btn || !this.panel) return;
    const r = this.btn.getBoundingClientRect();
    const pr = this.panel.getBoundingClientRect();
    let left = Math.max(8, r.right - pr.width);
    let top = r.top - pr.height - 8;
    if (top < 8) top = r.bottom + 8;
    this.panel.style.left = `${Math.round(left)}px`;
    this.panel.style.top = `${Math.round(top)}px`;
  }
}

// linear-resample Float32 [-1,1] to mono `outRate` and clamp to i16 (matches the Rust fingerprinter's input)
function toMono16kPcm(input, inRate, outRate) {
  const clamp = (s) => {
    s = Math.max(-1, Math.min(1, s));
    return s < 0 ? s * 0x8000 : s * 0x7fff;
  };
  if (inRate === outRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = clamp(input[i]);
    return out;
  }
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = clamp(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return out;
}

// little-endian i16 PCM -> base64
function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
