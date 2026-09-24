// feeds a continuous fMP4 byte stream from the local Rust relay (stream_relay.rs) into a
// <video> via Media Source Extensions. hls.js is wrong here: it wants an .m3u8 + segment URLs
// it fetches itself, but browser JS is subject to CORS and Twitch's CDN won't allow this
// origin. routing through streamlink + a local relay sidesteps CORS but yields one continuous
// byte stream, which MSE's appendBuffer() consumes directly

// walk the fMP4 box tree for a box type ("avcC"/"hvcC"), returning its payload or null. used
// to build the exact codec string: isTypeSupported() needs an exact match, and addSourceBuffer()
// accepts a wrong-but-constructible string that then fails as MEDIA_ERR_DECODE
function findBoxPayload(bytes, boxType) {
  const typeBytes = [...boxType].map((c) => c.charCodeAt(0));

  function scan(start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      // >>> 0 for an unsigned 32-bit read, else a box whose size byte starts >= 0x80 sign-extends
      // negative via << 24 and aborts the scan
      const size =
        (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);

      if (size < 8) {
        // malformed: size=0 ("extends to EOF") or size=1 (64-bit largesize, unsupported), abort this level only
        return null;
      }

      const isMatch =
        bytes[offset + 4] === typeBytes[0] &&
        bytes[offset + 5] === typeBytes[1] &&
        bytes[offset + 6] === typeBytes[2] &&
        bytes[offset + 7] === typeBytes[3];
      if (isMatch) {
        return bytes.subarray(offset + 8, offset + size);
      }

      // container boxes worth descending into for avcC/hvcC (deep inside moov); everything else is
      // leaf/media. three "where do children start" rules per ISO/IEC 14496-12: plain box-of-boxes at
      // +8, stsd (a FullBox with entry_count) at +16, visual sample entries after 78 bytes
      const typeStr = String.fromCharCode(
        bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const plainContainers = ["moov", "trak", "mdia", "minf", "stbl"];
      const fullBoxContainers = ["stsd"];
      // extended list: avc2/dvav (Dolby Vision AVC), dvh1/hvc2 (Dolby Vision HEVC), encv (Common Encryption), av01 (AV1)
      const sampleEntryContainers = ["avc1", "hvc1", "hev1", "avc3", "avc2", "dvav", "dvh1", "hvc2", "encv", "av01"];

      let childStart = null;
      if (plainContainers.includes(typeStr)) childStart = offset + 8;
      else if (fullBoxContainers.includes(typeStr)) childStart = offset + 8 + 8;
      else if (sampleEntryContainers.includes(typeStr)) childStart = offset + 8 + 78;

      if (childStart !== null) {
        // for known container boxes whose declared size overshoots the bytes we have, clamp the
        // sub-scan to what we have rather than failing the level. matters when the relay sends
        // init_bytes + overflow as one burst and a large mdat overshoots after moov already appeared
        const subEnd = Math.min(offset + size, end);
        const found = scan(childStart, subEnd);
        if (found) return found;
      }

      if (offset + size > end) {
        // leaf/unknown box whose end is past our data, can't find the next box, stop this level
        break;
      }
      offset += size;
    }
    return null;
  }

  return scan(0, bytes.length);
}

// true once the top-level moov box has arrived IN FULL (its declared size fits in the bytes we have).
// the init segment arrives in pieces; only a complete moov can prove a stream has NO video track
function moovIsComplete(bytes) {
  let off = 0;
  while (off + 8 <= bytes.length) {
    const size = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    if (size < 8) return false;
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (type === "moov") return off + size <= bytes.length;
    off += size;
  }
  return false;
}

// build the exact codecs="..." string from moov's avcC/hvcC/av1C rather than guessing.
// H.264: profile/constraint/level from avcC bytes 1-3. H.265: a Main-profile fallback (hvcC is
// complex). AV1: parsed per AV1-ISOBMFF. null if no recognized config box
function buildCodecStringFromInitSegment(bytes) {
  const avcC = findBoxPayload(bytes, "avcC");
  if (avcC && avcC.length >= 4) {
    const profileIdc = avcC[1];
    const constraintFlags = avcC[2];
    const levelIdc = avcC[3];
    const hex = (n) => n.toString(16).padStart(2, "0");
    const avcCodec = `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`;
    return `video/mp4; codecs="${avcCodec}, mp4a.40.2"`;
  }

  const hvcC = findBoxPayload(bytes, "hvcC");
  if (hvcC) {
    // HEVC isn't fully parsed, fall back to a broadly-compatible Main profile level string
    return 'video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"';
  }

  // Twitch has been rolling AV1 out; the av01 sample entry wraps an av1C box with the exact profile/level/tier/depth
  const av1C = findBoxPayload(bytes, "av1C");
  if (av1C && av1C.length >= 4) {
    const seqProfile   = (av1C[1] >> 5) & 0x07;
    const seqLevelIdx  =  av1C[1]       & 0x1f;
    const seqTier      = (av1C[2] >> 7) & 0x01;
    const highBitdepth = (av1C[2] >> 6) & 0x01;
    const twelveBit    = (av1C[2] >> 5) & 0x01;
    const bitDepth     = highBitdepth ? (twelveBit ? 12 : 10) : 8;
    const tier = seqTier ? "H" : "M";
    const ll   = String(seqLevelIdx).padStart(2, "0");
    const dd   = String(bitDepth).padStart(2, "0");
    return `video/mp4; codecs="av01.${seqProfile}.${ll}${tier}.${dd}, mp4a.40.2"`;
  }

  // audio-only stream (the player's "Audio only" quality): AAC with no video track. only accepted once
  // the WHOLE moov is here, so a video stream whose audio track merely arrived first can never be
  // mistaken for audio-only (that would play sound over a black screen)
  if (moovIsComplete(bytes) && findBoxPayload(bytes, "mp4a")) {
    return 'audio/mp4; codecs="mp4a.40.2"';
  }

  return null;
}

// attach the relay URL via a fresh MediaSource and pump bytes. returns a controller with stop()
// (aborts the fetch, tears down the buffer, revokes the URL); call it before re-attaching or the
// old fetch runs forever. callbacks.isVod skips the live-edge jump; onFatalError fires when the
// stream can't play at all
export function attachMseStream(videoEl, relayUrl, callbacks = {}) {
  const {
    isVod = false,
    onFatalError = () => {},
    onVodStartOffset = null,
    vodStartOffsetSecs = 0,   // VOD position (seconds) this relay starts from
    // fires once when the relay has been SILENT for a few seconds, well before onDead's 20s. not a
    // death sentence (playback may recover); it lets a listener ask Helix whether the broadcast
    // ended instead of waiting out a guess. once per silent spell, re-arms when bytes flow
    onSilence = () => {},
    // fires once when the relay demonstrably stopped supplying a LIVE stream (body ended, fetch
    // failed after a healthy start, or 20s of no bytes). distinct from onFatalError (an MSE-level
    // failure): onDead means the SOURCE died (streamlink exited, network dropped), recoverable by
    // restarting the relay. the owner uses this to auto-restart
    onDead = null,
  } = callbacks;

  // set once the init segment resolves to an audio-only stream (the "Audio only" quality). audio needs more
  // start-up headroom than video: its data arrives in ~2s bursts (one HLS segment at a time), and starting
  // only 0.5s behind the newest data let the element run dry before the next burst and get stuck
  // "waiting" until the 6s stall watchdog rescued it (the ~4.5s of silence after switching to audio only)
  let isAudioOnly = false;

  // hard-reset the video element before a new MediaSource. without it, Chromium's decoder retains
  // state (frames, timestamp expectations, error flags) and new data with very different timestamps
  // (a VOD seek) throws MEDIA_ERR_DECODE. removeAttribute + load() gives a clean HAVE_NOTHING state
  videoEl.removeAttribute("src");
  // clear any prior <source> children from a previous ManagedMediaSource attach so they don't stack across re-attaches
  while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild);
  videoEl.load();

  // THE macOS BLACK-SCREEN FIX: WKWebView's classic MediaSource is unreliable (accepts a few
  // appends, then MEDIA_ERR_DECODE); its working path is ManagedMediaSource (Safari 17+). Chromium
  // has no ManagedMediaSource and classic works fine, so feature-detect and prefer Managed
  const MediaSourceImpl = window.ManagedMediaSource || window.MediaSource;
  const usingManaged = MediaSourceImpl === window.ManagedMediaSource;
  const mediaSource = new MediaSourceImpl();
  const objectUrl = URL.createObjectURL(mediaSource);

  if (usingManaged) {
    // ManagedMediaSource only fires sourceopen when remote playback is disabled or an AirPlay
    // alternative exists, else it silently never opens. disable remote playback and attach via a
    // <source> child, the form WebKit expects
    videoEl.disableRemotePlayback = true;
    const sourceEl = document.createElement("source");
    sourceEl.type = "video/mp4";
    sourceEl.src = objectUrl;
    videoEl.appendChild(sourceEl);
  } else {
    videoEl.src = objectUrl;
  }

  // appendBuffer() can't run while the SourceBuffer is updating, so chunks queue here and drain
  // one at a time from 'updateend'; appending while updating throws InvalidStateError and drops the chunk
  const pendingChunks = [];
  // consecutive InvalidStateError retries on the head chunk. WKWebView can throw on an append
  // Chromium would accept; retry rather than drop (a dropped chunk causes a decode-fatal gap), but
  // cap so a genuinely wedged buffer surfaces the failure
  let _invalidStateRetries = 0;
  const MAX_INVALID_STATE_RETRIES = 20;
  // ManagedMediaSource streaming gate: true while appends are permitted (between
  // startstreaming/endstreaming). starts true so the classic path (which ignores it) is unaffected;
  // the managed path flips it and re-drives/holds pumpQueue
  let _mmsStreaming = true;
  let sourceBuffer = null;
  let stopped = false;
  let abortController = new AbortController();
  let activeReader = null; // held so stop() can cancel it immediately
  // so start-of-playback handling only happens once per attachment
  let hasStartedPlayback = false;
  // tracks currentTime across checkForStall() calls to detect a genuine freeze despite data arriving
  let _lastStallCheckTime = performance.now();
  let _lastStallCheckPosition = -1;

  // seek a fresh live stream to the live edge (MSE won't on its own, so it'd sit frozen at the
  // first timestamp). VODs start at 0. waits for MIN_BUFFER_BEFORE_START_SECONDS so it doesn't
  // seek past the buffered range and stall
  function startPlaybackOnceBuffered() {
    if (hasStartedPlayback) return;
    if (stopped || !sourceBuffer || sourceBuffer.updating) {
      console.log("[stream-player] startPlaybackOnceBuffered: not ready", {
        stopped,
        hasSourceBuffer: !!sourceBuffer,
        updating: sourceBuffer?.updating,
      });
      return;
    }
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) {
      console.log("[stream-player] startPlaybackOnceBuffered: buffered.length is 0");
      return;
    }
    const start = buffered.start(buffered.length - 1);
    const end = buffered.end(buffered.length - 1);
    // audio-only: wait for a bit more and start further back, see isAudioOnly
    const MIN_BUFFER_BEFORE_START_SECONDS = isAudioOnly ? 1.5 : 1;
    console.log("[stream-player] buffered range:", { start, end, span: end - start, rangeCount: buffered.length });
    if (end - start < MIN_BUFFER_BEFORE_START_SECONDS) return;
    hasStartedPlayback = true;
    if (isVod) {
      // VOD HLS segments keep their source timestamps (e.g. 62s) but currentTime defaults to 0, so
      // without a seek the video stalls where no data exists. seek to the buffered range's start
      videoEl.currentTime = start;
      // tell the caller the HLS base offset so it can map chapter positions to currentTime
      onVodStartOffset?.(start);
    } else {
      // live: seek near the live edge with a small margin so currentTime doesn't overshoot before the next chunk
      // (audio-only gets a bigger margin: its next data can be ~2s away, see isAudioOnly)
      videoEl.currentTime = Math.max(start, end - (isAudioOnly ? 1.5 : 0.5));
    }
    console.log("[stream-player] starting playback, currentTime set to", videoEl.currentTime);
    videoEl.play().then(() => {
      console.log("[stream-player] play() resolved successfully");
    }).catch((err) => {
      console.warn("Autoplay was blocked:", err);
    });
  }

  // called after each append or remove ('updateend') and on every enqueue
  function pumpQueue() {
    if (stopped || !sourceBuffer || sourceBuffer.updating) return;
    // ManagedMediaSource only permits appendBuffer while actively streaming; outside that window
    // it's rejected with InvalidStateError (poisons the buffer -> macOS black screen). chunks stay
    // queued until startstreaming re-drives this. prefer the live `streaming` property when exposed
    const canAppend = typeof mediaSource.streaming === "boolean"
      ? mediaSource.streaming
      : _mmsStreaming;
    if (usingManaged && !canAppend) return;
    if (pendingChunks.length === 0) return;
    const chunk = pendingChunks.shift();
    try {
      sourceBuffer.appendBuffer(chunk);
      _invalidStateRetries = 0; // success clears the WKWebView retry counter
      if (_bytesAppended === 0) _firstAppendAt = performance.now();
      _bytesAppended += chunk.byteLength;
      console.log("[stream-player] appendBuffer called with", chunk.byteLength, "bytes, queue remaining:", pendingChunks.length);
    } catch (err) {
      if (err.name === "QuotaExceededError") {
        // SourceBuffer full. put the chunk back at the FRONT (dropping it gaps the byte stream ->
        // MEDIA_ERR_DECODE), then trim aggressively; trimBuffered's updateend re-pumps once there's room
        pendingChunks.unshift(chunk);
        emergencyTrim();
      } else if (err.name === "InvalidStateError") {
        // WKWebView intermittently throws InvalidStateError on an append Chromium would accept. the old
        // code dropped the chunk, the macOS black-screen cause (a gap -> MEDIA_ERR_DECODE -> restart loop).
        // instead keep it (front of queue) and retry next pump, so the byte stream stays contiguous
        pendingChunks.unshift(chunk);
        _invalidStateRetries += 1;
        if (_invalidStateRetries > MAX_INVALID_STATE_RETRIES) {
          // genuinely wedged, stop retrying so this surfaces as a real failure (and the restart path can re-attach)
          _invalidStateRetries = 0;
          pendingChunks.shift(); // drop the wedged head, we're giving up on it
          if (!stopped) console.error("appendBuffer InvalidStateError exceeded retries; dropping chunk");
        } else if (!sourceBuffer.updating) {
          // nothing will fire updateend to re-drive the queue, so nudge it on the next microtask (letting WebKit settle)
          queueMicrotask(() => {
            if (!stopped) pumpQueue();
          });
        }
      } else {
        if (!stopped) console.error("appendBuffer failed, dropping chunk:", err);
      }
    }
  }

  // recover a frozen <video>: currentTime can stop advancing while the relay flows and appends
  // succeed, with no error. watch for it and nudge playback. live MSE only, VODs use hls.js's own recovery
  function checkForStall() {
    if (stopped || !hasStartedPlayback || isVod) {
      // pre-playback watchdog: appends succeeding while buffered stays EMPTY means MSE is silently
      // discarding every frame, the signature of an init segment that doesn't describe the fragments
      // (no error fires). after 3MB/8s of it, declare the source dead; reattaching gets a coherent pair
      if (!stopped && !isVod && !hasStartedPlayback && sourceBuffer &&
          _bytesAppended > 3_000_000 &&
          performance.now() - _firstAppendAt > 8_000 &&
          sourceBuffer.buffered.length === 0) {
        signalDead(`appended ${(_bytesAppended / 1e6).toFixed(1)}MB but nothing entered the buffer (init/fragment mismatch?)`);
      }
      return;
    }
    // byte starvation is checked BEFORE the paused early-return: a dead relay starves the download
    // regardless of pause state, and 20s of zero bytes on a live stream is unambiguous
    const silentFor = performance.now() - _lastByteAt;
    // early warning at 5s. a live relay ships continuously, so 5s of nothing means something's wrong,
    // but it could be a blip so this doesn't stop playback. it lets the listener ask Helix
    // (authoritative, fast) so an ended stream hands to Kick immediately instead of waiting out 20s
    if (silentFor > 5_000 && !_silenceSignaled && !stopped && !_teardownExpected && !isVod) {
      _silenceSignaled = true;
      onSilence(Math.round(silentFor / 1000));
    }
    if (silentFor > 20_000) {
      signalDead("no bytes from relay for 20s");
      return;
    }
    if (videoEl.paused || videoEl.ended) {
      // user-paused (or ended), nothing to fix. reset the tracker so resuming starts a fresh measurement instead of looking stalled
      _lastStallCheckPosition = videoEl.currentTime;
      _lastStallCheckTime = performance.now();
      return;
    }

    const pos = videoEl.currentTime;
    const now = performance.now();
    if (pos > _lastStallCheckPosition + 0.1) {
      // genuinely advancing since the last check, playing normally
      _lastStallCheckPosition = pos;
      _lastStallCheckTime = now;
      return;
    }
    if (pos < _lastStallCheckPosition) {
      // playback moved BACKWARD, which playback alone can't: someone seeked. this is why rewinding live
      // used to snap back to the edge (the baseline held the pre-seek position, so the advancing check
      // couldn't match and recovery fired). re-baselining here makes a seek look like a fresh start
      _lastStallCheckPosition = pos;
      _lastStallCheckTime = now;
      return;
    }

    // only act after currentTime's been stuck a while, not on the first flat reading, a brief pause between checks is normal jitter
    // audio-only: rescue much sooner, silence is far more noticeable than a paused picture
    const STALL_THRESHOLD_MS = isAudioOnly ? 2_500 : 6_000;
    if (now - _lastStallCheckTime < STALL_THRESHOLD_MS) return;

    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const latestRangeStart = buffered.start(buffered.length - 1);
    const latestRangeEnd = buffered.end(buffered.length - 1);
    if (latestRangeEnd <= pos + 1) {
      // no new data past where playback is stuck either, a genuine relay/network outage, not the won't-resume-despite-data case this exists for
      return;
    }

    console.warn(
      `[stream-player] STALL detected: currentTime frozen at ${pos.toFixed(1)} for ` +
      `${((now - _lastStallCheckTime) / 1000).toFixed(1)}s while buffered data reaches ` +
      `${latestRangeEnd.toFixed(1)} - forcing recovery`
    );
    // same near-the-end target startPlaybackOnceBuffered uses for the live-edge jump (bigger margin for audio-only)
    videoEl.currentTime = Math.max(latestRangeStart, latestRangeEnd - (isAudioOnly ? 1.5 : 0.5));
    videoEl.play().catch((err) => console.warn("[stream-player] stall-recovery play() failed:", err));
    _lastStallCheckPosition = videoEl.currentTime;
    _lastStallCheckTime = now;
  }

  // remove old buffered ranges so a long stream doesn't grow SourceBuffer memory without bound.
  // keeps a short trailing window behind the playhead, and for VODs also caps how far ahead data
  // buffers (streamlink outruns real-time)
  function trimBuffered() {
    if (stopped) return; // controller already torn down, don't touch SourceBuffer
    if (!hasStartedPlayback) return;
    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const currentTime = videoEl.currentTime;

    // keep TRAILING_WINDOW behind the playhead (for live rewinding, see seekRelative, clamped to this
    // range). 120s trades a little memory for more rewind room; emergencyTrim() handles QuotaExceededError
    const TRAILING_WINDOW = 120;
    const removeEnd = currentTime - TRAILING_WINDOW;
    if (removeEnd > buffered.start(0) + 2) {
      try {
        sourceBuffer.remove(buffered.start(0), removeEnd);
        return; // remove triggers updateend -> pumpQueue runs next
      } catch (err) {
        console.warn("SourceBuffer.remove (trailing) failed:", err);
      }
    }

    // forward trim (VOD only): keep at most 3 min ahead. VOD seeks restart the relay anyway, so buffering hours ahead just fills the quota and crashes
    if (isVod) {
      const MAX_FORWARD = 180; // seconds
      const fwdEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0;
      const fwdTrimStart = currentTime + MAX_FORWARD;
      if (fwdEnd > fwdTrimStart + 10) {
        try {
          sourceBuffer.remove(fwdTrimStart, fwdEnd);
        } catch (err) {
          console.warn("SourceBuffer.remove (forward) failed:", err);
        }
      }
    }
  }

  // tries trailing data first; if none (common early in a VOD) trims the forward buffer
  function emergencyTrim() {
    if (!sourceBuffer || sourceBuffer.updating) return;
    const buffered = sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const currentTime = videoEl.currentTime;

    // prefer removing old data behind the playhead first
    const trailEnd = currentTime - 5;
    if (trailEnd > buffered.start(0) + 0.5) {
      try {
        sourceBuffer.remove(buffered.start(0), trailEnd);
        return; // updateend -> pumpQueue retry
      } catch (err) {
        console.warn("[stream-player] emergency trail trim failed:", err);
      }
    }

    // no trailing data worth removing (playhead near the start). trim the forward buffer, keep 30s ahead. VODs re-stream any discarded future data
    const fwdEnd = buffered.end(buffered.length - 1);
    const fwdKeepUntil = currentTime + 30;
    if (fwdEnd > fwdKeepUntil + 2) {
      try {
        console.log("[stream-player] emergency forward trim", fwdKeepUntil.toFixed(1), "→", fwdEnd.toFixed(1));
        sourceBuffer.remove(fwdKeepUntil, fwdEnd);
        // updateend -> pumpQueue will retry the rescued chunk
      } catch (err) {
        console.warn("[stream-player] emergency forward trim failed:", err);
      }
    }
  }

  // every 4s (down from 15s) so the buffer never fills enough to hit QuotaExceededError. checkForStall shares this cadence
  const trimInterval = setInterval(() => {
    checkForStall();
    trimBuffered();
  }, 4_000);

  let _lastByteAt = performance.now();
  let _deadSignaled = false;
  // set by expectTeardown() when the CALLER is about to kill this relay on purpose (a quality
  // restart). the body EOFs either way, and an EOF is indistinguishable here from the stream ending,
  // so the caller must say so, else a quality change trips Kick failover
  let _teardownExpected = false;
  // has onSilence fired for the CURRENT silent spell? reset when bytes arrive, so a later spell can probe again
  let _silenceSignaled = false;
  // DEV: set by simulateSilence() to reproduce a stream end. arriving chunks are DROPPED and
  // _lastByteAt goes stale, exactly what the player sees when a broadcast ends (the relay stops
  // supplying without closing). everything downstream then runs on real timers
  let _simulateSilence = false;
  // counters for the pre-playback mismatch watchdog in checkForStall
  let _bytesAppended = 0;
  let _firstAppendAt = 0;
  function signalDead(reason) {
    if (stopped || _teardownExpected || _deadSignaled || isVod || !onDead) return;
    _deadSignaled = true;
    console.warn(`[stream-player] relay source is dead (${reason})`);
    onDead(reason);
  }

  async function pumpFetch() {
    let response;
    try {
      response = await fetch(relayUrl, { signal: abortController.signal });
    } catch (err) {
      if (stopped) return; // expected, stop() aborted the fetch
      console.error("Failed to fetch relay stream:", err);
      onFatalError();
      signalDead(`relay fetch failed: ${err?.message || err}`);
      return;
    }

    console.log("[stream-player] fetch responded:", response.status, response.headers.get("content-type"));
      const snapshotNote = response.headers.get("x-relay-snapshot");
      if (snapshotNote) console.log("[stream-player] relay snapshot decision:", snapshotNote);

    if (!response.ok || !response.body) {
      console.error("Relay stream fetch returned a bad response:", response.status);
      onFatalError();
      return;
    }

    const reader = response.body.getReader();
    activeReader = reader;

    // before the SourceBuffer exists, the EXACT codec string must be read from this stream's init
    // segment (guessing isn't good enough). bytes accumulate raw here until that succeeds; the cap is
    // a safety valve so an unidentifiable stream doesn't accumulate forever
    const INIT_SEGMENT_SCAN_CAP_BYTES = 2 * 1024 * 1024;
    let initSegmentChunks = [];
    let initSegmentTotalBytes = 0;
    let codecResolved = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("[stream-player] relay stream reader done");
          // a live relay body ending is never normal mid-session, the pump only EOFs when streamlink exited
          signalDead("relay stream ended");
          break;
        }
        // DEV silence: drop the chunk and DON'T touch _lastByteAt, so the starvation timers age as if the relay went quiet
        if (_simulateSilence) continue;
        _lastByteAt = performance.now();
        // bytes flowing again, re-arm the early-silence probe (it's once-per-spell)
        _silenceSignaled = false;
        if (stopped) break;
        console.log("[stream-player] read chunk from relay:", value.byteLength, "bytes");

        if (!codecResolved) {
          initSegmentChunks.push(value);
          initSegmentTotalBytes += value.byteLength;

          // on the first chunk, log the leading bytes: fMP4 starts with a ftyp box ("ftyp" at offset 4-7); MPEG-TS starts with sync byte 0x47
          if (initSegmentChunks.length === 1) {
            const preview = Array.from(value.slice(0, 32))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ");
            console.log("[stream-player] first 32 stream bytes (hex):", preview);
          }

          const combined = new Uint8Array(initSegmentTotalBytes);
          let offset = 0;
          for (const chunk of initSegmentChunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
          }

          const mimeType = buildCodecStringFromInitSegment(combined);
          if (mimeType) {
            console.log("[stream-player] resolved codec from init segment:", mimeType);
            codecResolved = true;
            isAudioOnly = mimeType.startsWith("audio/");
            const created = createSourceBufferOrFail(mimeType);
            if (!created) return; // onFatalError already called
            // feed everything accumulated (the init segment plus any media in the same chunk) now that there's a SourceBuffer
            pendingChunks.push(combined);
            pumpQueue();
            initSegmentChunks = []; // free the now-redundant raw accumulator
          } else if (initSegmentTotalBytes > INIT_SEGMENT_SCAN_CAP_BYTES) {
            console.error(
              "[stream-player] Could not identify stream codec (no avcC/hvcC/av1C found)" +
              " within the first",
              INIT_SEGMENT_SCAN_CAP_BYTES,
              "bytes - giving up. Check the hex dump above to confirm this is fMP4.",
            );
            onFatalError();
            return;
          }
          // still accumulating, no codec yet, don't queue anything until there's a SourceBuffer
          continue;
        }

        pendingChunks.push(value);
        pumpQueue();

        // VOD backpressure: streamlink outruns real-time, so without throttling the SourceBuffer hits its
        // ~100-150MB quota within seconds of a long VOD and QuotaExceededError kills it. after each chunk,
        // if buffered >90s ahead, pause reading until the player drops below 60s
        if (isVod && hasStartedPlayback && sourceBuffer) {
          const MAX_AHEAD = 90;
          const MIN_AHEAD = 60;
          const bLen = () => sourceBuffer.buffered?.length ?? 0;
          const fwdSeconds = () =>
            bLen() > 0
              ? sourceBuffer.buffered.end(bLen() - 1) - videoEl.currentTime
              : 0;
          if (fwdSeconds() > MAX_AHEAD) {
            while (!stopped && fwdSeconds() > MIN_AHEAD) {
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        }
      }
    } catch (err) {
      if (!stopped) console.error("Relay stream read error:", err);
    } finally {
      activeReader = null;
    }

    // the relay connection ended, signal end-of-stream so the <video> knows playback finished rather than stalling forever on a closed connection
    if (!stopped && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch (err) {
        console.warn("endOfStream failed (non-fatal):", err);
      }
    }
  }

  // create the SourceBuffer with the exact codec string. returns true on success; calls
  // onFatalError() and returns false if even that exact string is rejected (a genuinely unsupported
  // codec, not a guessing problem)
  function createSourceBufferOrFail(mimeType) {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mimeType);
    } catch (err) {
      console.error("addSourceBuffer rejected the stream's own resolved codec:", mimeType, err);
      onFatalError();
      return false;
    }
    console.log("[stream-player] MSE attached with codec:", mimeType);
    // diagnostics for "video stays black even though bytes flow", which on macOS (WKWebView) usually
    // means the buffer was accepted but the codec can't decode (WKWebView's MSE codec support is
    // narrower; AV1 is unsupported on older Macs). isTypeSupported can return true while decode fails
    try {
      console.log(
        "[stream-player] isTypeSupported:", MediaSource.isTypeSupported(mimeType),
      );
    } catch {}
    setTimeout(() => {
      if (stopped) return;
      // videoWidth stays 0 until a frame decodes; readyState >= 2 means one is available. both zero with
      // data buffered = the decoder isn't producing frames (the black-screen signature), not a network issue
      console.log(
        "[stream-player] decode check:",
        "videoWidth =", videoEl.videoWidth,
        "| videoHeight =", videoEl.videoHeight,
        "| readyState =", videoEl.readyState,
        "| buffered ranges =", videoEl.buffered.length,
        "| codec =", mimeType,
      );
      // audio-only streams never have a frame, that's expected, not a decode failure
      if (!mimeType.startsWith("audio/") && videoEl.videoWidth === 0 && videoEl.buffered.length > 0) {
        console.error(
          "[stream-player] BLACK-SCREEN SIGNATURE: data is buffered but no frame decoded. " +
          "This webview likely cannot decode this codec (" + mimeType + ").",
        );
      }
    }, 5000);
    sourceBuffer.addEventListener("updateend", () => {
      if (stopped) return; // in-flight operation completed after stop(), ignore
      startPlaybackOnceBuffered();
      pumpQueue();
    });
    sourceBuffer.addEventListener("error", (e) => {
      console.error("SourceBuffer error:", e);
    });
    return true;
  }

  // any seek resets the stall baseline immediately. the periodic check handles backward jumps too,
  // but only every 4s; without this a seek just before a tick could measure against a stale baseline
  const onSeekResetStallBaseline = () => {
    _lastStallCheckPosition = videoEl.currentTime;
    _lastStallCheckTime = performance.now();
  };
  videoEl.addEventListener("seeking", onSeekResetStallBaseline);
  videoEl.addEventListener("seeked", onSeekResetStallBaseline);

  videoEl.addEventListener("error", () => {
    const mediaError = videoEl.error;
    const codeNames = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
    };
    console.error(
      "[stream-player] video element error:",
      mediaError ? `code=${mediaError.code} (${codeNames[mediaError.code] || "unknown"}) message=${mediaError.message}` : mediaError,
    );
    // MEDIA_ERR_DECODE means the MSE decoder is permanently errored, every further appendBuffer throws
    // InvalidStateError. stop pumping so the relay isn't held open just to drop chunks, and notify the
    // caller to recover (restart streamlink). MEDIA_ERR_ABORTED (from an explicit stop()) is excluded
    if (mediaError && mediaError.code === MediaError.MEDIA_ERR_DECODE && !stopped) {
      stopped = true;
      abortController.abort();
      onFatalError();
    }
  });
  mediaSource.addEventListener("sourceended", () => {
    console.log("[stream-player] mediaSource sourceended");
  });
  mediaSource.addEventListener("sourceclose", () => {
    console.log("[stream-player] mediaSource sourceclose");
  });

  if (usingManaged) {
    // gate appends on the managed source's streaming window: resume the queue on startstreaming, hold
    // on endstreaming. without it, appends outside the window throw InvalidStateError on WebKit and black-screen the stream
    mediaSource.addEventListener("startstreaming", () => {
      _mmsStreaming = true;
      if (!stopped) pumpQueue();
    });
    mediaSource.addEventListener("endstreaming", () => {
      _mmsStreaming = false;
    });
  }

  mediaSource.addEventListener("sourceopen", () => {
    if (stopped) return;
    console.log("[stream-player] mediaSource sourceopen fired");
    pumpFetch();
  }, { once: true });

  return {
    // announces this relay is about to be killed deliberately (a quality restart), so the EOF isn't
    // reported as a death. buffered bytes keep playing until the replacement calls stop()
    expectTeardown() {
      _teardownExpected = true;
    },
    // DEV ONLY (the "Test failover" button): make this attachment behave as though the broadcast just ended
    simulateSilence() {
      _simulateSilence = true;
    },
    stop() {
      stopped = true;
      clearInterval(trimInterval);
      videoEl.removeEventListener("seeking", onSeekResetStallBaseline);
      videoEl.removeEventListener("seeked", onSeekResetStallBaseline);
      if (activeReader) {
        try { activeReader.cancel(); } catch {}
        activeReader = null;
      }
      abortController.abort();
      try {
        if (mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch {
        // already closed/ended or in a state that doesn't allow this, fine, tearing down anyway
      }
      URL.revokeObjectURL(objectUrl);
    },
  };
}
