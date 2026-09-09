// "Track ID": grabs a few seconds of whatever's playing and asks the Rust backend to identify the
// song. Capture is off the <video> via captureStream() (never touches the element's own audio routing,
// so playback isn't muted), then resampled to mono 16 kHz i16 PCM — the exact format the native Shazam
// fingerprinter in song_id/ expects. Works the same for Twitch and Kick, live and VOD.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// how long to listen; Shazam matches on ~5s+, a little longer rides out talking/noise
const CAPTURE_SECONDS = 8;
const OUT_RATE = 16000;

export class TrackId {
  constructor(videoEl) {
    this.videoEl = videoEl;
    this.btn = document.getElementById("track-id-btn");
    this.panel = document.getElementById("track-id-panel");
    this.busy = false;

    if (this.btn) this.btn.addEventListener("click", () => this.identify());
    document.addEventListener("click", (e) => {
      if (!this.panel || this.panel.style.display === "none") return;
      if (this.panel.contains(e.target) || this.btn?.contains(e.target)) return;
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
      if (match && match.title) this._renderMatch(match);
      else
        this._render(
          `<div class="track-id-status">No match found.</div><div class="track-id-sub">Try again during a clearer stretch of the song.</div>`
        );
    } catch (err) {
      const msg = typeof err === "string" ? err : err?.message || "Something went wrong.";
      this._render(`<div class="track-id-status">Couldn't identify.</div><div class="track-id-sub">${escapeHtml(msg)}</div>`);
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

  _renderMatch(m) {
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
    `);
    this.panel.querySelectorAll(".track-id-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        const u = btn.getAttribute("data-url");
        if (u) openUrl(u).catch(() => {});
      });
    });
  }

  _render(html) {
    if (!this.panel) return;
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
