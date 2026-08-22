/**
 * VOD playback via HLS.js. Live uses the Rust relay + MSE; for VODs HLS.js is right - native
 * fMP4 HLS, its own buffering, instant seeking (set currentTime and it loads segments).
 *
 * Usage:
 *   const hls = attachHlsVod(videoEl, m3u8Url, { startPosition: 0 });
 *   hls.destroy();  // or destroyHlsVod()
 */

import Hls from "hls.js";

export { Hls };

/**
 * Attaches HLS.js for VOD playback.
 * @param {HTMLVideoElement} videoEl
 * @param {string} m3u8Url - authenticated CDN playlist URL
 * @param {object} [opts]
 * @param {number} [opts.startPosition=0] - VOD second to start from
 * @param {(data:any)=>void} [opts.onFatalError] - called on unrecoverable error
 * @returns {Hls|null} HLS instance (null if native HLS is used)
 */
export function attachHlsVod(videoEl, m3u8Url, {
  startPosition = 0,
  onFatalError   = null,
  // Small-window mode (the PiP window): cap quality to the rendered size and keep buffers
  // modest. Without it, hls.js's default startLevel picks the first (source) variant, so a
  // 480px PiP fetched multi-MB source segments and contended with the main player - confirmed
  // as multi-second black screens on PiP open.
  smallPlayer = false,
  // True for Kick's live session (attachHlsDvr/startKick) - a real live m3u8 with its own
  // rolling DVR window, not a finite VOD. backBufferLength: 30 below suits scrubbing a complete
  // Twitch VOD; here a wider back buffer avoids re-fetch churn on repeated backward scrubs
  // within Kick's window.
  liveEdge = false,
  // Log prefix, so the PiP window's hls output is distinguishable from the main player's.
  logPrefix = "[hls.js]",
} = {}) {
  if (!Hls.isSupported()) {
    // Native HLS (Safari / some Chromium). Seeking still just works.
    videoEl.src = m3u8Url;
    if (startPosition > 0) {
      videoEl.addEventListener("loadedmetadata", () => {
        videoEl.currentTime = startPosition;
      }, { once: true });
    }
    videoEl.play().catch(() => {});
    return null;
  }

  const hls = new Hls({
    // Jump straight to startPosition instead of buffering from 0.
    startPosition,
    enableWorker: true,

    // Buffer config: 30s back for smooth backward scrubs, 60s ahead for instant in-range
    // seeks. smallPlayer trims all of it (PiP doesn't scrub); liveEdge keeps as much back
    // buffer as Kick's manifest window allows (see liveEdge above).
    backBufferLength:   smallPlayer ? 10 : (liveEdge ? Infinity : 30),
    maxBufferLength:    smallPlayer ? 20 : 60,
    maxMaxBufferLength: smallPlayer ? 40 : 120,

    // See smallPlayer - pick a level matching the rendered size, not the manifest's first
    // (source) variant.
    capLevelToPlayerSize: smallPlayer,

    // Twitch fMP4 segments can have large pts/dts gaps at ad/chapter boundaries - don't be
    // strict.
    maxFragLookUpTolerance: 0.5,
  });

  hls.loadSource(m3u8Url);
  hls.attachMedia(videoEl);

  // Startup-stage timing: when a black screen lingers, these say WHICH stage ate the time
  // (playlist vs first fragment vs decode).
  const t0 = performance.now();
  const sinceStart = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`;
  hls.once(Hls.Events.MANIFEST_PARSED, (_, data) => {
    console.log(`${logPrefix} ${sinceStart()} manifest parsed (${data?.levels?.length ?? "?"} levels)`);
  });
  hls.once(Hls.Events.FRAG_BUFFERED, () => {
    console.log(`${logPrefix} ${sinceStart()} first fragment buffered`);
  });
  videoEl.addEventListener("playing", () => {
    console.log(`${logPrefix} ${sinceStart()} first frame playing`);
  }, { once: true });

  hls.once(Hls.Events.MANIFEST_PARSED, () => {
    videoEl.play().catch(() => {});
  });

  // Bounded network-error recovery. The old code retried network errors unconditionally and
  // never reached onFatalError, so a manifest that can never load (a dead localhost proxy port)
  // spun ERR_CONNECTION_REFUSED forever and the caller's fallback never ran. Manifest failures
  // get 2 retries; mid-stream errors keep the generous retry, capped at 5 consecutive.
  let manifestRetries = 0;
  let consecutiveNetErrors = 0;
  hls.on(Hls.Events.FRAG_BUFFERED, () => { consecutiveNetErrors = 0; });
  hls.on(Hls.Events.ERROR, (_, data) => {
    if (!data.fatal) return;
    console.error(`${logPrefix} fatal error:`, data.type, data.details);
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      const manifestStage = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
        || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
        || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
      if (manifestStage ? ++manifestRetries > 2 : ++consecutiveNetErrors > 5) {
        console.error(`${logPrefix} network-error retries exhausted - giving up on this URL`);
        onFatalError?.(data);
        return;
      }
      hls.startLoad();
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
    } else {
      onFatalError?.(data);
    }
  });

  return hls;
}
