// VOD playback via HLS.js. live uses the Rust relay + MSE, but for VODs HLS.js is the right
// tool: native fMP4 HLS, its own buffering, instant seeking (set currentTime and it loads
// the segments)

import Hls from "hls.js";

export { Hls };

export function attachHlsVod(videoEl, m3u8Url, {
  startPosition = 0,
  onFatalError   = null,
  // small-window mode (PiP): cap quality to the rendered size and keep buffers modest.
  // without it hls.js's default startLevel grabs the source variant, so a 480px PiP pulled
  // multi-MB segments and fought the main player, which showed as multi-second black screens
  smallPlayer = false,
  // Kick's live session (attachHlsDvr/startKick): a real live m3u8 with its own rolling DVR
  // window, not a finite VOD. the 30s back buffer suits scrubbing a complete Twitch VOD; here
  // a wider one avoids re-fetch churn on repeated backward scrubs within Kick's window
  liveEdge = false,
  // so the PiP window's hls output is distinguishable from the main player's
  logPrefix = "[hls.js]",
} = {}) {
  if (!Hls.isSupported()) {
    // native HLS (Safari / some Chromium)
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
    // jump straight to startPosition instead of buffering from 0
    startPosition,
    enableWorker: true,

    // 30s back for smooth backward scrubs, 60s ahead for instant in-range seeks. smallPlayer
    // trims all of it (PiP doesn't scrub); liveEdge keeps as much back buffer as Kick's window allows
    backBufferLength:   smallPlayer ? 10 : (liveEdge ? Infinity : 30),
    maxBufferLength:    smallPlayer ? 20 : 60,
    maxMaxBufferLength: smallPlayer ? 40 : 120,

    // pick a level matching the rendered size, not the manifest's source variant
    capLevelToPlayerSize: smallPlayer,

    // Twitch fMP4 segments can have big pts/dts gaps at ad/chapter boundaries, don't be strict
    maxFragLookUpTolerance: 0.5,
  });

  hls.loadSource(m3u8Url);
  hls.attachMedia(videoEl);

  // when a black screen lingers, these say which stage ate the time (playlist vs fragment vs decode)
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

  // bounded network-error recovery. the old code retried network errors forever and never
  // reached onFatalError, so a manifest that can never load (dead localhost proxy port) spun
  // ERR_CONNECTION_REFUSED and the caller's fallback never ran. manifest failures get 2 retries,
  // mid-stream errors keep the generous retry, capped at 5 in a row
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
