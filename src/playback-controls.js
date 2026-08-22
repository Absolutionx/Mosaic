// Custom playback controls for the <video> element, fed via MSE from the local relay
// (stream_relay.rs, stream-player.js). streamlink's remuxed output is relayed over local HTTP and
// appended with attachMseStream() (hls.js has no continuous-byte-stream mode). Controls use the
// standard HTMLMediaElement API.

import { invoke } from "@tauri-apps/api/core";
import { fetchVodChapters, fetchVodSeekPreviewsUrl } from "./chapters.js";
import { loadVodStoryboard } from "./seek-thumbnails.js";
import { attachHlsVod } from "./vod-player.js";
import { attachMseStream } from "./stream-player.js";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";

const HIDE_DELAY_MS = 2000;
// Live-edge bookkeeping needs a periodic tick, now just reading video.currentTime/.buffered (no
// IPC), kept at the old cadence so seek-bar/time updates feel the same.
const PROGRESS_POLL_MS = 1000;
// How far behind the live edge (video.seekable's end) still counts as "effectively live" for the
// Live button/time display - live playback always trails the edge by a small latency buffer.
const LIVE_EDGE_THRESHOLD_SECONDS = 2;
// How often _maybeStepUpAutoQuality() polls downlink. Deliberately much slower than the
// stall-driven step-down (~3s): a wrong step-up costs a visible restart and likely a stall, so
// there's no benefit to checking faster, only more risk of acting on a blip.
const STEP_UP_CHECK_MS = 20_000;
// Minimum time since the last stall (_lastStallAt) before a step-up is even considered. A stall
// is ground-truth that the network failed at the CURRENT tier; downlink recovering moments later
// doesn't undo that. Independent of (and longer than) the stall counter's 90s reset.
const STEP_UP_MIN_QUIET_MS = 60_000;
// Bandwidth a tier typically needs (Mbps), keyed by the leading resolution number
// _rankResolution() extracts. Mid-range live-H.264 ladder bitrates (actual varies, which is why
// STEP_UP_HEADROOM exists). Unknown resolutions scale from the nearest entry by pixel ratio (see
// _requiredMbpsForResolution()).
const RESOLUTION_MBPS = {
  160: 0.4,   // audio-only-equivalent tiers some channels expose as e.g. "160p30"
  240: 0.6,
  360: 1.2,
  480: 2.0,
  720: 3.5,
  1080: 6.0,
  1440: 10.0,
  2160: 20.0,
};
// A step-up must clear the next tier's bitrate by this multiple, not just match it - the
// "upload ~1.4x your bitrate" streaming margin applied in reverse, since downlink is an estimate
// and other apps on the network can eat into it unseen.
const STEP_UP_HEADROOM = 1.4;

export class PlaybackControls {
  /**
   * @param {object} [opts]
   * @param {(quality: string) => void} [opts.onQualityChange] - called when the user picks a
   *   quality. Switching means restarting streamlink with a new quality arg (no in-memory rendition
   *   switch), so this file asks main.js to redo start_stream and feed it the fresh relay URL via
   *   start() again.
   */
  constructor({ onQualityChange = () => {}, onLowLatencyChange = () => {}, onSeek = () => {}, onLiveDvrSeek = null, onLiveDvrClamped = null, onStreamDead = null, onStreamSilent = null, lowLatency = false } = {}) {
    this.onQualityChange = onQualityChange;
    // Fired when the live relay source dies (attachMseStream's onDead) so main.js can auto-restart;
    // reason string passed through for its status line.
    this.onStreamDead = onStreamDead;
    // Early warning that the relay went quiet (onSilence). NOT a death - playback continues. Lets
    // main.js ask Helix whether the broadcast ended, so a real end hands to Kick in seconds.
    this.onStreamSilent = onStreamSilent;
    this.onLowLatencyChange = onLowLatencyChange;
    this.onSeek = onSeek;
    // Called by main.js when live-DVR is available for the channel (Twitch has a recording VOD).
    // When set, a seek past the MSE buffer calls this instead of clamping; the callback gets the
    // target seconds-behind-live and switches to HLS.js on the VOD. Null = clamp to the buffer.
    this.onLiveDvrSeek = onLiveDvrSeek;
    // Fires when a live seek wanted to go further back than Kick can reach (past the buffered
    // window, no VOD to swap onto), so the playhead clamped to the earliest buffered point.
    // Informational - lets main.js explain the clamp. Gets the asked and landed seconds-behind-live.
    this.onLiveDvrClamped = onLiveDvrClamped;
    // Reflects the current low-latency setting. Kept in sync by main.js
    // so the toggle in the quality menu shows the correct on/off state.
    this.lowLatency = lowLatency;
    this.videoFrame = document.getElementById("video-frame");
    this.videoRegion = document.getElementById("video-region");
    this.videoEl = document.getElementById("video-element");
    this.controlsBar = document.getElementById("controls-bar");
    this.playPauseBtn = document.getElementById("play-pause-btn");
    this.playIcon = document.getElementById("play-icon");
    this.pauseIcon = document.getElementById("pause-icon");
    this.centerPlayBtn = document.getElementById("center-play-btn");
    this.seekBarTrack = document.getElementById("seek-bar-track");
    this.seekBarFill = document.getElementById("seek-bar-fill");
    this.mutedSegmentsContainer = document.getElementById("seek-bar-muted-segments");
    this.seekBarTooltip = document.getElementById("seek-bar-tooltip");
    this.seekBarThumbnail = document.getElementById("seek-bar-thumbnail");
    this.timeDisplay = document.getElementById("time-display");
    this.liveBtn = document.getElementById("live-btn");
    this.muteBtn = document.getElementById("mute-btn");
    this.volumeIcon = document.getElementById("volume-icon");
    this.muteIcon = document.getElementById("mute-icon");
    this.volumeSlider = document.getElementById("volume-slider");
    this.settingsBtn = document.getElementById("settings-btn");
    this.chaptersBtn  = document.getElementById("chapters-btn");
    this.chaptersMenu = document.getElementById("chapters-menu");

    // HLS.js instance used for VOD playback (null for live streams or when
    // no VOD is playing). Seeking is just videoEl.currentTime = seconds.
    this._hlsVod = null;
    // Chapter list fetched once per VOD, cached for the session.
    this._chapters = [];
    this._chaptersLoaded = false;
    // No-op until _fetchStoryboard() resolves - frameFor() returning null means the hover tooltip
    // shows just the time, the right fallback for live (no storyboard) and before a VOD's loads.
    this._storyboard = { frameFor: () => null };
    this.qualityMenu = document.getElementById("quality-menu");
    this.pipBtn = document.getElementById("pip-btn");
    // Rescue controls in the PiP placeholder (index.html): recover a PiP window stranded on an
    // unplugged or input-switched monitor. It's frameless/always-on-top/skip-taskbar, so once
    // off-display the OS offers no way to reach it - these buttons are that way.
    this.pipBringBtn = document.getElementById("pip-bring-btn");
    this.pipCloseRemoteBtn = document.getElementById("pip-close-remote-btn");
    this.videoRegionEl = document.getElementById("video-region");

    // The MSE feeder's controller for the current stream/VOD (attachMseStream). Created in start(),
    // torn down in stop().
    this.mseController = null;

    this.hideTimer = null;
    this.inPip = false;
    // Document PiP state (enterDocPip): the PiP Window while open, the videoEl's original DOM
    // position, an AbortController scoping every PiP-only listener (the video element survives the PiP
    // window), and refs to the PiP controls so setVolume/setMuteIcon/setPauseIcon stay in sync.
    this.docPipWindow = null;
    this._docPipRestore = null;
    this._docPipAbort = null;
    // Native always-on-top PiP window (enterNativePip) - the third PiP tier, for webviews where
    // neither Document PiP nor classic video PiP works (WebView2 exposes both but requestWindow throws
    // and pictureInPictureEnabled is false).
    this.nativePipWindow = null;
    this._nativePipRestore = null;
    // What attachStream/attachLiveMse/attachHlsDvr most recently fed the player (relay URL or VOD
    // m3u8), so enterNativePip can hand the PiP window the same source. Relay URLs are safe to share:
    // the relay is a multi-subscriber broadcast, so PiP is a second consumer, not a second stream.
    this._currentSourceUrl = null;
    this._pipEls = null;
    this.progressInterval = null;
    this.isMuted = false;
    this.lastVolumeBeforeMute = 100;
    this.active = false;
    // Cached from the last pollProgress() tick, so the Live button and seek tooltip compute values
    // without re-reading video.buffered per mouse move.
    this.lastKnownPosition = 0;
    this.lastKnownDuration = 0;
    // Copyright-muted VOD ranges (renderMutedSegments), for seek-bar markers and the hover label.
    // Raw {offset, duration} from Helix, kept so updateSeekTooltip doesn't need them passed in.
    this._mutedSegments = [];
    // See pollProgress's "normal live" branch - anchors currentTime (session-relative) to the
    // broadcast's absolute elapsed time (from liveDvrStreamStartedAt). Re-derived per session; null =
    // not yet available.
    this._liveSessionAbsoluteStart = null;
    // Live-DVR state: set when the user seeks past the MSE buffer into the live stream's recording
    // VOD (HLS.js). Null during normal live/VOD. { channel, videoId, streamStartedAt } - streamStartedAt
    // (the VOD's created_at) computes the VOD offset and maps position back to wall-clock for the bar.
    this._liveDvr = null;
    // Set by main.js once get_live_vod_info resolves. Lets the seek bar expand to the full stream
    // duration before the first DVR click, and lets seekToClickPosition compute the VOD offset.
    this.liveDvrStreamStartedAt = null;
    // True for a Kick live session (startKick/attachHlsDvr on Kick's live m3u8). Kick has no separate
    // VOD endpoint to swap onto like Twitch's onLiveDvrSeek - its "DVR" is whatever hls.js still has
    // buffered. liveDvrStreamStartedAt is still set (to expand the bar/behind-live display), but seeking
    // past the buffer must CLAMP for Kick. See seekToClickPosition/seekRelative.
    this._isKickSession = false;
    // True once main.js resolved an in-progress RECORDING for the Kick session (get_kick_live_dvr) -
    // what makes a Twitch-style DVR swap possible on Kick. While false, Kick seeks past the buffer keep
    // the clamp-with-notice; while true they route into onLiveDvrSeek. Reset with _isKickSession.
    this.kickDvrAvailable = false;
    // The Kick rendition label ("720p60") the user picked. hls.js level indices are per-manifest and
    // a Kick session attaches a fresh hls on every live<->DVR swap, so remembering the LABEL and
    // re-matching keeps quality sticky across swaps. null = auto. Reset on channel change only.
    this._kickPreferredLevelLabel = null;
    // Set by main.js right before start() is called, so the quality menu
    // knows which channel/VOD to ask get_available_qualities about.
    this.currentChannel = null;
    this.currentQuality = "best";
    // Prefetched quality list for the current channel, populated in the background by
    // _prefetchQualities() at start() so the settings menu renders instantly. Cleared in stop() and on
    // channel change.
    this.cachedQualities = null;
    this._qualitiesPromise = null;

    // Auto quality: step down on sustained buffering (_handleAutoStall), step up when downlink clears
    // the next tier and no recent stall (_maybeStepUpAutoQuality). _autoTierIdx indexes _autoQualityTiers
    // ascending; -1 = 'best'. Each switch restarts streamlink, so both directions are debounced, step-up
    // more conservatively.
    this.autoQualityMode = false;
    this._autoTierIdx = -1;
    this._autoStallCount = 0;
    this._autoStallDebounce = null;
    this._autoStallResetTimer = null;
    // Date.now() of the most recent stall DETECTION (the post-debounce increment, not a raw
    // 'waiting'). Read by _maybeStepUpAutoQuality() so a step-up never fires too soon after the network
    // proved it couldn't keep up, even after _autoStallCount's 90s reset.
    this._lastStallAt = 0;
    // Recurring timer polling for a step-up while auto mode is on and not at 'best'. Separate from
    // the event-driven step-down path.
    this._autoStepUpInterval = null;
    // Stable bound reference so we can addEventListener/removeEventListener
    // with the same function object.
    this._boundAutoStall = () => this._handleAutoStall();

    this.bindEvents();
  }

  bindEvents() {
    // Bound to videoFrame (parent of both #video-region and .controls-bar), not just videoRegion -
    // binding to videoRegion alone made moving onto the controls bar count as leaving, firing
    // hideControls() with the cursor on the seek bar.
    this.videoFrame.addEventListener("mousemove", () => this.showControls());
    this.videoFrame.addEventListener("mouseleave", () => this.hideControls());

    this.playPauseBtn.addEventListener("click", () => this.togglePause());
    // Clicking the video intentionally does NOT toggle pause: live has no meaningful pause (it just
    // freezes on the last frame while the broadcast continues), so accidental clicks are a nuisance. The
    // controls-bar button covers the rare intentional case.
    this.centerPlayBtn.addEventListener("click", () => this.togglePause());

    this.muteBtn.addEventListener("click", () => this.toggleMute());

    // The slider's 'input' fires continuously while dragging. video.volume is a synchronous set (no
    // IPC), so unlike the old mpv version this needs no debouncing - every event sets it directly.
    this.volumeSlider.addEventListener("input", (e) => {
      this.setVolume(Number(e.target.value));
    });

    this.seekBarTrack.addEventListener("click", (e) => {
      this.seekToClickPosition(e);
    });

    this.seekBarTrack.addEventListener("mousemove", (e) => {
      this.updateSeekTooltip(e);
    });
    this.seekBarTrack.addEventListener("mouseleave", () => {
      this.seekBarTooltip.classList.remove("visible");
      this.seekBarThumbnail.classList.remove("visible");
    });

    this.liveBtn.addEventListener("click", () => this.jumpToLive());

    this.pipBtn?.addEventListener("click", () => this.togglePip());
    this.pipBringBtn?.addEventListener("click", () => this.rescueNativePip());
    this.pipCloseRemoteBtn?.addEventListener("click", () => this.closePipAnyTier());
    // A "pip"-labeled window can outlive our handle (the webview reloaded while PiP was open) -
    // without re-adopting it, the rescue UI never shows and the pip button would try to CREATE one
    // instead of closing the running one.
    this._adoptStrayPip();
    this.settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleQualityMenu();
    });

    this.chaptersBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleChaptersMenu();
    });

    // Close any open menus when clicking anywhere outside them.
    document.addEventListener("click", () => {
      this.qualityMenu.classList.remove("open");
      this.chaptersMenu?.classList.remove("open");
    });

    // Keep the play/pause icon and center button in sync with whatever changed video.paused - not
    // just our clicks, but the element's own changes (autoplay, or a shortcut calling
    // video.play()/.pause() directly).
    this.videoEl.addEventListener("play", () => this.setPauseIcon(false));
    this.videoEl.addEventListener("pause", () => this.setPauseIcon(true));

    // Exiting native PiP other than via our pipBtn (the OS window's own close) must reflect back in
    // our UI - see togglePip()/applyPipUiState().
    this.videoEl.addEventListener("leavepictureinpicture", () => {
      this.applyPipUiState(false);
    });
  }

  // @param channel         the channel being watched
  // @param relayUrl        local relay URL from start_stream (127.0.0.1:PORT)
  // @param quality         initial quality label (highlight only; switching restarts start_stream)
  // @param vodTotalSeconds Helix VOD duration, ground truth for the seek bar
  // @param opts.kickVod    a Kick recording off a proxied master playlist. Seeks are identical, but
  //                        Twitch-only side fetches (quality probe, chapters, storyboard) must not
  //                        fire; quality uses the hls.js level menu.
  start(channel, url, quality = "best", vodTotalSeconds = 0, startPositionSecs = 0, opts = {}) {
    const kickVod = Boolean(opts.kickVod);
    // macOS native-HLS live path (attachStream): live m3u8 via hls.js instead of the MSE relay, but
    // all of start()'s control/UI setup is identical - which is why this must go THROUGH start() (going
    // around it left PiP, the overlay, and cursor auto-hide uninitialized).
    this._nativeHlsLive = Boolean(opts.nativeHlsLive);
    this.active = true;
    // Clear the quality cache on a channel switch so the new channel re-probes. Keep it for
    // same-channel calls (a quality switch restarts the stream but the available qualities don't
    // change). Also exit auto mode on a real switch; keep it for same-channel step restarts.
    if (channel !== this.currentChannel) {
      this.cachedQualities = null;
      this._qualitiesPromise = null;
      this._disableAutoMode();
      // Markers are tied to a VOD's muted_segments - a same-channel restart keeps the same VOD, but a
      // real switch means these belong to the old one. main.js re-fetches; this just hides the stale
      // markers meanwhile.
      this.renderMutedSegments([], 0);
    }
    this.currentChannel = channel;
    // False for every Twitch stream/VOD; true for a Kick VOD (the kickVod param). With isVod=true
    // its live-session clamp branches are unreachable; its only live effect is routing the quality menu
    // to _loadKickQualityMenu.
    this._isKickSession = kickVod;
    this.kickDvrAvailable = false;
    // When in auto mode, keep displaying 'auto' as the active quality even
    // though the stream is actually playing at a specific resolution tier.
    if (!this.autoQualityMode) {
      this.currentQuality = quality;
    }
    // Channels prefixed with "vod:" are past broadcasts - they have a
    // fixed duration and no live edge, so live-specific UI is hidden.
    this.isVod = channel.startsWith("vod:");
    this.vodTotalSeconds = vodTotalSeconds;
    this._chapters = [];
    this._chaptersLoaded = false;
    // Reset so a new VOD doesn't briefly show the previous one's stale
    // thumbnails while its own storyboard loads.
    this._storyboard = { frameFor: () => null };
    if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
    if (this.chaptersMenu) { this.chaptersMenu.innerHTML = ""; this.chaptersMenu.classList.remove("open"); }
    this.liveBtn.style.display = this.isVod ? "none" : "";
    this.showControls();

    this.attachStream(url, startPositionSecs);

    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = setInterval(() => this.pollProgress(), PROGRESS_POLL_MS);

    // Kick VODs: no streamlink probe (the quality menu reads hls.js levels), no GQL chapters, no
    // storyboard - all three are Twitch APIs that would 4xx for a Kick uuid.
    if (!kickVod && !this.cachedQualities && !this._qualitiesPromise) {
      this._prefetchQualities();
    }

    // For VODs, fetch chapters and the seek-preview storyboard in the background so they're ready.
    // Live (not yet in DVR) never gets here - Twitch only generates storyboards for finished/recording
    // VODs.
    if (this.isVod && !kickVod) {
      this._fetchChapters();
      this._fetchStoryboard();
    }
  }

  /** Tears down any previous MSE attachment and attaches a fresh one (attachMseStream) - "one
   * feeder per source, not reused". VODs: HLS.js on a CDN M3U8 (instant seeking; startPositionSecs
   * jumps to a second). Live: the Rust relay + MSE pipeline. */
  attachStream(url, startPositionSecs = 0) {
    this._currentSourceUrl = url;
    // A source change makes an open native PiP stale (it's playing the OLD relay/VOD, about to be
    // torn down) - close it; the user can re-open on the new source.
    this._closeNativePip();
    if (this._nativeHlsLive) {
      // macOS native-HLS live: a live m3u8 via hls.js instead of the MSE relay. No MSE controller;
      // everything else start() sets up is identical (see attachHlsLive / the useNativeHlsForLive toggle).
      if (this.mseController) {
        this.mseController.stop();
        this.mseController = null;
      }
      if (this._hlsVod) {
        this._hlsVod.destroy();
        this._hlsVod = null;
      }
      this._hlsVod = attachHlsVod(this.videoEl, url, {
        startPosition: -1,
        liveEdge: true,
        onFatalError: (data) => {
          console.error("[hls.js] fatal in live:", data);
          this.onStreamDead?.("hls.js live pipeline failed");
        },
      });
    } else if (this.isVod) {
      // Tear down any existing HLS.js instance first.
      if (this._hlsVod) {
        this._hlsVod.destroy();
        this._hlsVod = null;
      }
      this._hlsVod = attachHlsVod(this.videoEl, url, {
        startPosition: startPositionSecs,
        onFatalError: (data) => console.error("[hls.js] fatal:", data),
      });
    } else {
      // Live: relay + MSE.
      if (this.mseController) {
        this.mseController.stop();
        this.mseController = null;
      }
      this.mseController = attachMseStream(this.videoEl, url, {
        isVod: false,
        onFatalError: () => {
          console.error("MSE stream attachment failed fatally for", url);
          // An append failure leaves the pipeline as dead as a vanished relay (a poisoned demuxer never
          // recovers) - route it into the same auto-restart.
          this.onStreamDead?.("MSE pipeline failed");
        },
        onDead: (reason) => this.onStreamDead?.(reason),
        onSilence: (secs) => this.onStreamSilent?.(secs),
      });
    }
  }

  // Switch to hls.js on a VOD URL for live-DVR: tear down the MSE relay, attach at the offset, keep
  // isVod false so the live UI stays. No storyboard fetch (Twitch's CDN 403s for an in-progress VOD).
  // startKick starts a Kick HLS feed (the failover path): start()'s bookkeeping minus attachStream,
  // since Kick is a plain live playlist through hls.js (attachHlsDvr at -1 = live edge).
  startKick(channel, url) {
    this.active = true;
    if (channel !== this.currentChannel) {
      // Same reset start() does on a real channel switch - see its
      // comments for why each of these can't be left stale.
      this.cachedQualities = null;
      this._qualitiesPromise = null;
      this._disableAutoMode();
      this.renderMutedSegments([], 0);
      this._kickPreferredLevelLabel = null; // new channel, fresh quality choice
    }
    this.currentChannel = channel;
    this.isVod = false;
    // See this flag's own comment (constructor) - drives Kick-specific
    // clamp-instead-of-DVR-swap handling in seekToClickPosition/seekRelative.
    this._isKickSession = true;
    // Resolved (or not) per session by main.js AFTER this returns - a
    // previous session's availability must never leak into a new one.
    this.kickDvrAvailable = false;
    this.vodTotalSeconds = 0;
    // Chapters/storyboard belong to a Twitch VOD - Kick has neither, and for the failover case these
    // belong to the ended Twitch stream.
    this._chapters = [];
    this._chaptersLoaded = false;
    this._storyboard = { frameFor: () => null };
    if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
    if (this.chaptersMenu) {
      this.chaptersMenu.innerHTML = "";
      this.chaptersMenu.classList.remove("open");
    }
    this.liveBtn.style.display = "";
    // Live-DVR bookkeeping belongs to a Twitch session. In Kick mode the bar must reflect the hls.js
    // buffer only - stale values here would drive the behind-live/duration math off the ended Twitch
    // timeline.
    this._liveDvr = null;
    this.liveDvrStreamStartedAt = null;
    this._liveSessionAbsoluteStart = null;
    this.showControls();
    this.attachHlsDvr(url, -1);
    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = setInterval(() => this.pollProgress(), PROGRESS_POLL_MS);
  }

  attachHlsDvr(vodUrl, vodOffsetSecs) {
    this._currentSourceUrl = vodUrl;
    this._closeNativePip();
    if (this.mseController) {
      this.mseController.stop();
      this.mseController = null;
    }
    if (this._hlsVod) {
      this._hlsVod.destroy();
      this._hlsVod = null;
    }
    this._hlsVod = attachHlsVod(this.videoEl, vodUrl, {
      startPosition: vodOffsetSecs,
      onFatalError: (data) => console.error("[hls.js] fatal in DVR:", data),
      // Twitch's onLiveDvrSeek swaps onto a finite in-progress RECORDING (ordinary VOD buffering is
      // right). Kick's startKick() calls this for its live m3u8 (offset -1 = live edge). A Kick DVR attach
      // (offset >= 0) is the RECORDING case - the offset sign distinguishes the two within a Kick session.
      liveEdge: this._isKickSession && vodOffsetSecs < 0,
    });
    // Every Kick attach (live start, DVR entry, go-live return) builds a
    // new hls instance - re-pin the user's picked rendition on it.
    if (this._isKickSession) this._applyKickPreferredLevel();
  }

  /**
   * Tells the CURRENT live relay attachment it's about to be killed on purpose, so its EOF isn't
   * mistaken for the stream ending. Call before anything that restarts streamlink server-side (a
   * start_stream on a playing channel), which kills the old relay while this attachment still reads
   * it. No-op on VODs and when nothing is attached.
   */
  expectRelayTeardown() {
    this.mseController?.expectTeardown?.();
  }

  /** DEV ONLY: make the live relay attachment act as though the broadcast ended (bytes stop,
   * connection stays open). Drives the real silence/death detectors, not their conclusions. */
  simulateRelaySilence() {
    this.mseController?.simulateSilence?.();
  }

  attachLiveMse(relayUrl) {
    // Reaching the live relay only happens for a Twitch session - belt-and-braces reset alongside
    // start()'s, so a stale true from a Kick session can't linger.
    this._isKickSession = false;
    this.kickDvrAvailable = false;
    if (this._hlsVod) {
      this._hlsVod.destroy();
      this._hlsVod = null;
    }
    if (this.mseController) {
      this.mseController.stop();
      this.mseController = null;
    }
    // See pollProgress's "normal live" branch - re-derived every session; a stale value would
    // silently corrupt the "how far behind live" math for the new one.
    this._liveSessionAbsoluteStart = null;
    this._currentSourceUrl = relayUrl;
    this._closeNativePip();
    this.mseController = attachMseStream(this.videoEl, relayUrl, {
      isVod: false,
      onFatalError: () => {
        console.error("MSE stream attachment failed fatally for", relayUrl);
          // An append failure leaves the pipeline as dead as a vanished relay - route it into the same
          // auto-restart.
          this.onStreamDead?.("MSE pipeline failed");
      },
      onDead: (reason) => this.onStreamDead?.(reason),
      onSilence: (secs) => this.onStreamSilent?.(secs),
    });
  }

  /** Toggles the browser's native PiP for #video-element. Replaces the old approach (detaching
   * mpv's HWND into a Win32 popup via SetParent) - a real <video> gets this from the standard PiP Web
   * API with no window-management code. */
  async togglePip() {
    try {
      if (this.nativePipWindow) {
        // Restoration lives in the tauri://destroyed handler (enterNativePip), which fires for our
        // button and the window's own X alike - one path for every close.
        this._closeNativePip();
      } else if (this.docPipWindow) {
        // Same single-path principle: restoration happens in the doc-PiP
        // window's own pagehide handler (see enterDocPip).
        this.docPipWindow.close();
      } else if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        this.applyPipUiState(false);
      } else {
        // The native always-on-top window (enterNativePip) is the FIRST choice, not the fallback; Document
        // PiP is only tried if it fails to open. This inverts the old probe-first order deliberately:
        // WebView2's requestWindow isn't a fixed property - on the same build/machine it sometimes
        // succeeds and sometimes throws, so probe-first was a coin-flip between two PiP windows. The
        // native window can't be flaky (a real OS window), so leading with it is deterministic.
        try {
          await this.enterNativePip();
        } catch (err) {
          console.warn("Native PiP window failed, falling back to webview PiP tiers:", err?.message || err);
          if (window.documentPictureInPicture && !this._docPipBroken) {
            // Document PiP (Chromium 116+): hosts our own DOM, so the mini-player gets real controls
            // (enterDocPip). First fallback because when it works it shares the main video element - no
            // second stream consumer.
            try {
              await this.enterDocPip();
            } catch (err2) {
              this._docPipBroken = true;
              console.warn("Document PiP also unavailable (falling back to classic video PiP):", err2?.message || err2);
              // Don't leak a half-built doc-PiP window if a later setup step failed after requestWindow
              // succeeded (_restoreFromDocPip is null-guarded at every stage).
              if (this.docPipWindow) {
                try { this.docPipWindow.close(); } catch (_) {}
                this._restoreFromDocPip();
              }
              if (document.pictureInPictureEnabled) {
                await this.videoEl.requestPictureInPicture();
                this.applyPipUiState(true);
              } else {
                console.warn("Picture-in-Picture is not supported in this webview.");
              }
            }
          } else if (document.pictureInPictureEnabled) {
            await this.videoEl.requestPictureInPicture();
            this.applyPipUiState(true);
          } else {
            console.warn("Picture-in-Picture is not supported in this webview.");
          }
        }
      }
    } catch (err) {
      console.error("togglePip failed:", err);
    }
  }

  /**
   * Opens the native always-on-top PiP window (pip.html) - the tier that works everywhere, being a
   * real OS window rather than a webview API WebView2 fakes (see togglePip). It plays its own copy of
   * the source (live: second relay subscriber; VOD: own hls.js at the current position); the main
   * video keeps playing MUTED underneath so live stays at the edge and closing is an instant unmute.
   */
  async enterNativePip() {
    if (!this._currentSourceUrl) {
      console.warn("PiP: no active stream source to hand to the PiP window.");
      return;
    }
    // Suppresses tab-out auto-PiP during creation: making a Tauri window
    // steals focus, which would otherwise re-trigger the focus handler.
    this._openingPip = true;
    setTimeout(() => { this._openingPip = false; }, 800);
    // A "pip"-labeled window can outlive our handle (dev reload, a creation racing teardown), and
    // labels are unique, so creating over a stale one fails - adopt-and-close any stray first.
    const stale = await WebviewWindow.getByLabel("pip").catch(() => null);
    if (stale) {
      await stale.close().catch(() => {});
    }
    const params = new URLSearchParams({
      mode: this._hlsVod ? "vod" : "live",
      src: this._currentSourceUrl,
      pos: String(this.videoEl.currentTime || 0),
      volume: String(this.videoEl.volume),
      muted: this.videoEl.muted ? "1" : "0",
      channel: (this.currentChannel || "").replace(/^vod:/, ""),
      // The PiP window is its OWN document - the main window's body.kick-mode doesn't reach it, so its
      // accent controls rendered Twitch purple in Kick sessions. pip.js reads this and applies the class.
      kick: this._isKickSession ? "1" : "0",
    });
    // VOD: hand the pip the pre-resolved LOW quality playlist if cached (resolvePipVodUrl) - the pip
    // prefers it and falls back to the main-quality src.
    if (this._hlsVod) {
      const vid = (this.currentChannel || "").replace(/^vod:/, "");
      try {
        const cached = JSON.parse(localStorage.getItem(`pipVodLowUrl:${vid}`) || "null");
        // Port match = minted by this session; see resolvePipVodUrl for why a stale session's URL is a
        // dead localhost port, not just lower quality.
        const samePort = cached?.url && this._currentSourceUrl &&
          new URL(cached.url).port === new URL(this._currentSourceUrl).port;
        if (samePort && Date.now() - cached.ts < 3 * 3600_000) {
          params.set("lowsrc", cached.url);
        }
      } catch (_) {}
    }
    const win = new WebviewWindow("pip", {
      url: `pip.html?${params}`,
      // True 16:9. The old 302 height was doc-pip's "16:9 plus a controls strip", but here controls are
      // a hover overlay so the video fills the window (480x302 showed ~16px of letterbox). pip.js also
      // snaps to the video's real aspect after a resize.
      width: 480,
      height: 270,
      // Floor stops resizes into unusable slivers and gives pip.js's
      // aspect snap a sane minimum to work against.
      minWidth: 192,
      minHeight: 108,
      alwaysOnTop: true,
      decorations: false,
      resizable: true,
      // Maximize makes no sense for an aspect-locked floating player, and a maximize/restore leaves it
      // misshapen (the restore's resize runs the aspect snap against the distorted axis). The drag-region
      // double-click is intercepted in pip.js; this shuts the OS routes (Win+Up, snap layouts) too.
      maximizable: false,
      // false = the window gets a taskbar button and alt-tab entry. skipTaskbar:true applies
      // WS_EX_TOOLWINDOW on Windows, which also removes it from alt-tab - and a frameless always-on-top
      // window with no alt-tab entry is unreachable once its monitor goes away (why rescueNativePip
      // exists). So take both: alt-tab focus + Win+Shift+arrow works as a manual rescue too.
      skipTaskbar: false,
      title: "PiP",
      // Created INVISIBLE on purpose: pip.js restores the last position (or computes the default) and
      // only then shows it - otherwise the OS places it at its cascade position first and it teleports.
      visible: false,
    });
    await new Promise((resolve, reject) => {
      win.once("tauri://created", resolve);
      win.once("tauri://error", (e) => reject(new Error(e?.payload ?? "PiP window creation failed")));
    });
    this.nativePipWindow = win;
    this._nativePipRestore = { muted: this.videoEl.muted };
    this.videoEl.muted = true;
    this.applyPipUiState(true);
    // Fires for every way the window can die - our button, its X, or the OS - so, like the doc-pip
    // pagehide handler, restoration lives in one place.
    win.once("tauri://destroyed", () => {
      if (this.nativePipWindow !== win) return; // a newer PiP already replaced this one
      this.nativePipWindow = null;
      if (this._nativePipRestore) {
        this.videoEl.muted = this._nativePipRestore.muted;
        this._nativePipRestore = null;
      }
      this.applyPipUiState(false);
    });
  }

  /** Closes the native PiP window if open. Safe any time; state restoration happens in the
   * tauri://destroyed handler, not here. */
  _closeNativePip() {
    if (this.nativePipWindow) {
      this.nativePipWindow.close().catch(() => {});
    }
  }

  /**
   * Moves the native PiP window onto the SAME monitor as the main window (bottom-right) and focuses
   * it. Recovery for a PiP stranded on an unplugged/input-switched display, where the frameless
   * always-on-top skip-taskbar window has no alt-tab/taskbar/title-bar to reach it. Looks up by label
   * so it works on a stray window too; moving it fires the pip's onMoved, so the NEXT PiP opens on the
   * visible monitor.
   */
  async rescueNativePip() {
    const win = this.nativePipWindow
      || await WebviewWindow.getByLabel("pip").catch(() => null);
    if (!win) {
      // Nothing to rescue - the UI was stale; square it up.
      this.applyPipUiState(false);
      return;
    }
    try {
      // currentMonitor() is relative to the calling webview's window - THIS main window's monitor,
      // which the user can see (they just clicked a button on it).
      const mon = await currentMonitor();
      if (!mon) return;
      // A size saved on a big external display may not fit the screen we're rescuing onto - shrink to
      // fit first so "bottom-right with margin" can't hang off-screen.
      let w = 480, h = 270;
      const size = await win.outerSize().catch(() => null);
      if (size?.width && size?.height) { w = size.width; h = size.height; }
      const maxW = Math.round(mon.size.width * 0.9);
      const maxH = Math.round(mon.size.height * 0.9);
      if (w > maxW || h > maxH) {
        const scale = Math.min(maxW / w, maxH / h);
        w = Math.max(192, Math.round(w * scale));
        h = Math.max(108, Math.round(h * scale));
        await win.setSize(new PhysicalSize(w, h)).catch(() => {});
      }
      const margin = Math.round(24 * (mon.scaleFactor || 1));
      await win.setPosition(new PhysicalPosition(
        mon.position.x + mon.size.width - w - margin,
        mon.position.y + mon.size.height - h - margin,
      ));
      // show() covers a window that died between hidden creation and placeWindow's show; setFocus makes
      // the rescue visibly land and lets keyboard/drag work immediately.
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
    } catch (err) {
      console.warn("PiP rescue failed:", err?.message || err);
    }
  }

  /** Close button in the PiP placeholder: closes whichever tier is open (the placeholder shows for
   * all three), including a stray native window we lost the handle to. */
  async closePipAnyTier() {
    if (this.nativePipWindow) { this._closeNativePip(); return; }
    if (this.docPipWindow) { this.docPipWindow.close(); return; }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture().catch(() => {});
      this.applyPipUiState(false);
      return;
    }
    const stray = await WebviewWindow.getByLabel("pip").catch(() => null);
    if (stray) await stray.close().catch(() => {});
    this.applyPipUiState(false);
  }

  /**
   * Re-adopts a "pip"-labeled window that survived a main-webview reload. Without this, nativePipWindow
   * is null while the window exists: the rescue UI never appears and togglePip would CREATE a new one
   * (reopening at the saved position, right back on the unreachable monitor). Adoption is minimal:
   * track the handle, show the UI, clear both when it dies. No mute state to restore.
   */
  async _adoptStrayPip() {
    if (this.nativePipWindow) return;
    const stray = await WebviewWindow.getByLabel("pip").catch(() => null);
    if (!stray || this.nativePipWindow) return; // second check: enterNativePip may have raced us
    this.nativePipWindow = stray;
    this._nativePipRestore = null;
    this.applyPipUiState(true);
    stray.once("tauri://destroyed", () => {
      if (this.nativePipWindow !== stray) return;
      this.nativePipWindow = null;
      this.applyPipUiState(false);
    });
  }


  /**
   * Opens a Document PiP window and MOVES the live <video> into it, with a mini controls bar (the
   * volume slider being the whole reason this exists). Moving the element is the API's designed usage;
   * playback continues, and nothing touches videoEl.src or load() (which would reset the MSE pipeline).
   * The pagehide handler restores everything - one place for every close path.
   */
  async enterDocPip() {
    const pipWin = await window.documentPictureInPicture.requestWindow({
      width: 480,
      height: 302, // 16:9 video + the 32px controls bar
    });
    this.docPipWindow = pipWin;
    this._docPipAbort = new AbortController();
    const signal = this._docPipAbort.signal;

    // Copy the app's stylesheets into the PiP document so the controls pick up the theme. Rule-by-rule
    // rather than cloning <link> nodes (the PiP document's base URL differs, so relative hrefs wouldn't
    // resolve); same-origin, so cssRules access can't throw.
    for (const sheet of document.styleSheets) {
      try {
        const style = pipWin.document.createElement("style");
        style.textContent = [...sheet.cssRules].map((r) => r.cssText).join("\n");
        pipWin.document.head.appendChild(style);
      } catch (_) {
        if (sheet.href) {
          const link = pipWin.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          pipWin.document.head.appendChild(link);
        }
      }
    }

    // Remember where the video came from so it goes back exactly - nextSibling included, since
    // #video-region has other children (center play button, PiP placeholder) and CSS order matters.
    this._docPipRestore = {
      parent: this.videoEl.parentNode,
      nextSibling: this.videoEl.nextSibling,
    };

    const doc = pipWin.document;
    doc.body.className = "docpip-body";
    // Same reason as enterNativePip's `kick` param: the copied stylesheet has the body.kick-mode
    // overrides, but this document's body needs the class, else the slider's accent resolves to the :root
    // default (Twitch purple) mid-Kick-session.
    if (this._isKickSession) doc.body.classList.add("kick-mode");
    doc.body.appendChild(this.videoEl); // implicit adoptNode; playback continues

    const bar = doc.createElement("div");
    bar.className = "docpip-controls";
    // Small inline SVGs rather than cloning the main window's - those carry ids (#volume-icon) that
    // must stay unique per document, and the paths are tiny.
    bar.innerHTML = `
      <button class="docpip-btn" data-act="playpause" title="Play/Pause">
        <svg class="docpip-pause-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>
        <svg class="docpip-play-icon" viewBox="0 0 24 24" width="16" height="16" style="display:none"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
      </button>
      <button class="docpip-btn" data-act="mute" title="Mute/Unmute">
        <svg class="docpip-vol-icon" viewBox="0 0 24 24" width="16" height="16"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/></svg>
        <svg class="docpip-mute-icon" viewBox="0 0 24 24" width="16" height="16" style="display:none"><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7z" fill="currentColor"/></svg>
      </button>
      <input class="docpip-volume volume-slider" type="range" min="0" max="130" title="Volume" />
    `;
    doc.body.appendChild(bar);

    this._pipEls = {
      slider: bar.querySelector(".docpip-volume"),
      volIcon: bar.querySelector(".docpip-vol-icon"),
      muteIcon: bar.querySelector(".docpip-mute-icon"),
      playIcon: bar.querySelector(".docpip-play-icon"),
      pauseIcon: bar.querySelector(".docpip-pause-icon"),
    };
    // Initial state mirrors the main window's right now.
    this._pipEls.slider.value = this.volumeSlider.value;
    this._syncPipMuteIcon(this.isMuted);
    this._syncPipPauseIcon(this.videoEl.paused);

    // The slider drives the same path as the main one (including unmute-on-volume-up); setVolume()
    // mirrors the value onto BOTH sliders, so they can never disagree.
    this._pipEls.slider.addEventListener("input", (e) => {
      this.setVolume(Number(e.target.value));
    }, { signal });
    bar.querySelector('[data-act="mute"]').addEventListener("click", () => {
      this.toggleMute();
    }, { signal });
    bar.querySelector('[data-act="playpause"]').addEventListener("click", () => {
      this.togglePause();
    }, { signal });
    // Same "reflect whatever changed video.paused" as bindEvents(), but PiP-scoped (AbortController)
    // since the video element outlives the PiP window and must not accumulate a listener pair per
    // session.
    this.videoEl.addEventListener("play", () => this._syncPipPauseIcon(false), { signal });
    this.videoEl.addEventListener("pause", () => this._syncPipPauseIcon(true), { signal });

    pipWin.addEventListener("pagehide", () => this._restoreFromDocPip(), { signal });

    this.applyPipUiState(true);
  }

  /** Puts the video element back where enterDocPip took it and clears PiP-scoped state/listeners.
   * Runs on the PiP window's pagehide - the one choke point for every close. */
  _restoreFromDocPip() {
    const restore = this._docPipRestore;
    if (restore?.parent) {
      restore.parent.insertBefore(this.videoEl, restore.nextSibling);
    }
    this._docPipAbort?.abort();
    this._docPipAbort = null;
    this._docPipRestore = null;
    this._pipEls = null;
    this.docPipWindow = null;
    this.applyPipUiState(false);
  }

  _syncPipMuteIcon(muted) {
    if (!this._pipEls) return;
    this._pipEls.volIcon.style.display = muted ? "none" : "block";
    this._pipEls.muteIcon.style.display = muted ? "block" : "none";
    // Tooltip carries the actual level, not just "Volume". The slider runs 0-130 (above 100 is boost),
    // so the percentage is the raw value. Called from every mute-state path, and setVolume mirrors onto
    // both sliders, so this keeps the tooltip truthful for drags on either and for mute toggles.
    this._pipEls.slider.title = muted
      ? "Muted"
      : `${Math.round(Number(this._pipEls.slider.value))}%`;
  }

  _syncPipPauseIcon(paused) {
    if (!this._pipEls) return;
    this._pipEls.playIcon.style.display = paused ? "block" : "none";
    this._pipEls.pauseIcon.style.display = paused ? "none" : "block";
  }

  /** Updates all PiP-related UI (button state, placeholder) to match the given in-PiP state. Shared
   * by togglePip and the leavepictureinpicture listener, since both must land on the same visual end
   * state. */
  applyPipUiState(inPip) {
    this.inPip = inPip;
    // "Bring PiP to this screen" only makes sense for the native tier - doc-pip and classic video PiP
    // are OS/browser-managed windows Tauri can't reposition. The close button stays for all tiers.
    if (this.pipBringBtn) {
      this.pipBringBtn.style.display = (inPip && this.nativePipWindow) ? "" : "none";
    }
    if (inPip) {
      this.pipBtn?.classList.add("pip-active");
      this.pipBtn?.setAttribute("title", "Return from Picture in Picture");
      // Show the PiP placeholder so the blank video area isn't confusing.
      this.videoRegionEl?.classList.add("in-pip");
      // Hide the controls bar - there's no video to hover over anymore.
      this.videoFrame.classList.remove("controls-visible");
    } else {
      this.pipBtn?.classList.remove("pip-active");
      this.pipBtn?.setAttribute("title", "Picture in Picture");
      this.videoRegionEl?.classList.remove("in-pip");
    }
  }

  stop() {
    if (this.docPipWindow) {
      // close() fires the PiP window's pagehide, whose handler synchronously puts the video element back
      // in the main DOM - which must happen BEFORE the src teardown below so load() runs on an element in
      // its real home.
      this.docPipWindow.close();
    }
    this._closeNativePip();
    if (this.inPip) {
      this.inPip = false;
      this.pipBtn?.classList.remove("pip-active");
      this.pipBtn?.setAttribute("title", "Picture in Picture");
      this.videoRegionEl?.classList.remove("in-pip");
    }
    if (document.pictureInPictureElement === this.videoEl) {
      document.exitPictureInPicture().catch(() => {});
    }
    this.active = false;
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this._hlsVod) {
      this._hlsVod.destroy();
      this._hlsVod = null;
    }
    if (this.mseController) {
      this.mseController.stop();
      this.mseController = null;
    }
    this.videoEl.removeAttribute("src");
    this.videoEl.load();
    this.videoFrame.classList.remove("controls-visible");
    this.setPauseIcon(false);
    this.seekBarFill.style.width = "0%";
    this.renderMutedSegments([], 0);
    this.isVod = false;
    this.vodTotalSeconds = 0;
    this._liveDvr = null;
    this.liveDvrStreamStartedAt = null;
    this.liveBtn.style.display = "";
    this.timeDisplay.textContent = "live";
    this.liveBtn.classList.remove("at-live-edge");
    this.lastKnownPosition = 0;
    this.lastKnownDuration = 0;
    this._liveSessionAbsoluteStart = null;
    this.qualityMenu.classList.remove("open");
    this.qualityMenu.innerHTML = "";
    this.cachedQualities = null;
    this._qualitiesPromise = null;
    this._disableAutoMode();
  }

  /** Shows/hides the quality dropdown. Opening renders from the prefetched cache if ready, or waits
   * for the in-flight prefetch (brief "Loading..." then instant). */
  toggleQualityMenu() {
    const opening = !this.qualityMenu.classList.contains("open");
    if (opening) {
      this.positionQualityMenu();
      this.loadQualityMenu();
    }
    this.qualityMenu.classList.toggle("open", opening);
  }

  /**
   * Positions the quality menu as a horizontal flyout extending leftward from the settings button,
   * vertically centered. Computed from the button's current position (which changes on
   * resize/move).
   */
  positionQualityMenu() {
    const buttonRect = this.settingsBtn.getBoundingClientRect();

    this.qualityMenu.style.left = "";
    this.qualityMenu.style.right = `${window.innerWidth - buttonRect.right}px`;
    // Open upward: bottom of menu sits 4px above the top of the button.
    this.qualityMenu.style.bottom = `${window.innerHeight - buttonRect.top + 4}px`;
    this.qualityMenu.style.top = "";
    this.qualityMenu.style.transform = "";
  }

  /** Removes streamlink's "audio_only" entry - there's no video for it (it would black-screen the
   * <video> this app feeds), so it was never a meaningful menu choice. _autoQualityTiers() already
   * filters it; calling this at both resolution points means cachedQualities never contains it, so
   * every consumer is covered by construction. */
  _stripAudioOnly(qualities) {
    if (!Array.isArray(qualities)) return qualities;
    return qualities.filter((q) => q !== "audio_only");
  }

  /** Fires the streamlink quality probe in the background and caches it. Called once from start() so
   * the result is ready by menu-open. The promise is stored in _qualitiesPromise so loadQualityMenu()
   * can await it if the menu opens first. */
  _prefetchQualities() {
    if (!this.currentChannel) return;
    this._qualitiesPromise = (
      this.isVod
        ? invoke("get_available_vod_qualities", {
            videoId: this.currentChannel.replace(/^vod:/, ""),
          })
        : invoke("get_available_qualities", { channel: this.currentChannel })
    )
      .then((qualities) => {
        this.cachedQualities = Array.isArray(qualities) ? this._stripAudioOnly(qualities) : null;
        this._qualitiesPromise = null;
        return this.cachedQualities;
      })
      .catch((err) => {
        console.error("[quality prefetch] failed:", err);
        this._qualitiesPromise = null;
        return null;
      });
  }

  /**
   * Opens the quality dropdown. If the prefetch resolved, no "Loading..." flash; if still in flight,
   * shows "Loading..." and renders when it resolves (usually a fraction of a second). A full fresh
   * fetch is a last resort (prefetch never started).
   */
  async loadQualityMenu() {
    if (!this.currentChannel) return;

    // Kick sessions play hls.js on Kick's master playlist, which lists every rendition - quality means
    // picking an hls.js LEVEL, not restarting a relay (there's no streamlink, and get_available_qualities
    // would probe the wrong site). Twitch's relay-restart machinery below stays untouched.
    if (this._isKickSession) {
      this._loadKickQualityMenu();
      return;
    }

    // Already cached - render immediately with zero latency.
    if (this.cachedQualities) {
      this._renderQualityItems(this.cachedQualities);
      return;
    }

    this.qualityMenu.innerHTML = '<div class="quality-menu-empty">Loading…</div>';

    let qualities;
    try {
      if (this._qualitiesPromise) {
        // Prefetch in progress - await it instead of starting a duplicate probe.
        qualities = await this._qualitiesPromise;
      } else {
        // Fallback: start a fresh fetch (shouldn't normally happen).
        qualities = this.isVod
          ? await invoke("get_available_vod_qualities", {
              videoId: this.currentChannel.replace(/^vod:/, ""),
            })
          : await invoke("get_available_qualities", { channel: this.currentChannel });
      }
    } catch (err) {
      console.error("Failed to load qualities:", err);
      this.qualityMenu.innerHTML = '<div class="quality-menu-empty">Failed to load</div>';
      return;
    }
    qualities = this._stripAudioOnly(qualities);

    if (!qualities || qualities.length === 0) {
      this.qualityMenu.innerHTML = '<div class="quality-menu-empty">No qualities found</div>';
      return;
    }

    this._renderQualityItems(qualities);
  }

  /** Kick counterpart of loadQualityMenu's fetch: the "fetch" is just reading _hlsVod.levels
   * (populated at MANIFEST_PARSED). If that hasn't happened yet, show Loading and re-render when it
   * does - same UX as a Twitch prefetch in flight. */
  _loadKickQualityMenu() {
    const hls = this._hlsVod;
    if (!hls) {
      // Native-HLS fallback path (attachHlsVod returned null): the
      // <video> element owns rendition choice, nothing to offer.
      this.qualityMenu.innerHTML =
        '<div class="quality-menu-empty">Quality selection unavailable</div>';
      return;
    }
    if (!Array.isArray(hls.levels) || hls.levels.length === 0) {
      this.qualityMenu.innerHTML = '<div class="quality-menu-empty">Loading…</div>';
      // 'hlsManifestParsed' === Hls.Events.MANIFEST_PARSED - string literal so this file needs no hls.js
      // import (vod-player.js owns it).
      hls.once("hlsManifestParsed", () => {
        // Only if the user still has the menu open on the same session.
        if (this._isKickSession && this.qualityMenu.classList.contains("open")) {
          this._renderKickQualityItems();
        }
      });
      return;
    }
    this._renderKickQualityItems();
  }

  /** Human label for one hls.js level. Kick's IVS playlists usually carry a NAME ("1080p60"); fall
   * back to height+fps, then bitrate, so a schema change degrades to something meaningful. */
  _kickLevelLabel(level) {
    const name = level?.attrs?.NAME || level?.name;
    if (name) return String(name);
    if (level?.height) {
      const fps =
        level.frameRate && Math.round(level.frameRate) > 30
          ? String(Math.round(level.frameRate))
          : "";
      return `${level.height}p${fps}`;
    }
    if (level?.bitrate) return `${Math.round(level.bitrate / 1000)} kbps`;
    return "Unknown";
  }

  /** Renders the Kick quality pills: Auto (hls.js ABR) + one per level, highest first. Same pill
   * classes as the Twitch renderer; no Low Latency toggle (a streamlink concept with no Kick
   * equivalent). */
  _renderKickQualityItems() {
    const hls = this._hlsVod;
    if (!hls) return;
    this.qualityMenu.innerHTML = "";

    const pillsRow = document.createElement("div");
    pillsRow.className = "quality-menu-pills";

    const auto = hls.autoLevelEnabled;

    const autoItem = document.createElement("button");
    autoItem.className = "quality-menu-item" + (auto ? " active" : "");
    autoItem.textContent = "Auto";
    autoItem.title = "Adaptive - picks the rendition for current bandwidth";
    autoItem.addEventListener("click", (e) => {
      e.stopPropagation();
      this._selectKickLevel(-1);
    });
    pillsRow.appendChild(autoItem);

    const sep = document.createElement("div");
    sep.className = "quality-menu-sep";
    pillsRow.appendChild(sep);

    // Display order: highest first (resolution, then bitrate as the
    // tiebreaker) - indices into hls.levels are preserved via map.
    const orderedIdxs = hls.levels
      .map((_, i) => i)
      .sort(
        (a, b) =>
          (hls.levels[b].height || 0) - (hls.levels[a].height || 0) ||
          (hls.levels[b].bitrate || 0) - (hls.levels[a].bitrate || 0)
      );
    for (const i of orderedIdxs) {
      const item = document.createElement("button");
      item.className = "quality-menu-item";
      if (!auto && hls.currentLevel === i) item.classList.add("active");
      item.textContent = this._kickLevelLabel(hls.levels[i]);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectKickLevel(i);
      });
      pillsRow.appendChild(item);
    }

    this.qualityMenu.appendChild(pillsRow);
  }

  /** Applies a Kick quality pick: -1 = auto, else an index into _hlsVod.levels. currentLevel (not
   * nextLevel) so the switch is immediate - hls.js flushes the forward buffer and fetches the new
   * rendition from the current position, like a Twitch quality click. */
  _selectKickLevel(idx) {
    const hls = this._hlsVod;
    if (!hls) return;
    hls.currentLevel = idx;
    this._kickPreferredLevelLabel =
      idx === -1 ? null : this._kickLevelLabel(hls.levels[idx]);
    // Kept for display parity (anything showing currentQuality) - the
    // Twitch restart machinery never reads it during a Kick session.
    this.currentQuality = idx === -1 ? "auto" : this._kickPreferredLevelLabel;
    this.qualityMenu.classList.remove("open");
  }

  /** Re-applies the remembered Kick rendition on a freshly-attached hls instance (every live<->DVR
   * swap creates one; indices don't survive across manifests, labels do). Called from attachHlsDvr; a
   * no-op when on auto. */
  _applyKickPreferredLevel() {
    const wanted = this._kickPreferredLevelLabel;
    const hls = this._hlsVod;
    if (!wanted || !hls) return;
    const apply = () => {
      if (this._hlsVod !== hls) return; // superseded by another attach
      const idx = hls.levels.findIndex(
        (lv) => this._kickLevelLabel(lv) === wanted
      );
      if (idx >= 0) {
        hls.currentLevel = idx;
      }
      // No exact match (renditions can differ between the live playlist
      // and the recording): stay on auto rather than guessing wrong.
    };
    if (Array.isArray(hls.levels) && hls.levels.length > 0) apply();
    else hls.once("hlsManifestParsed", apply);
  }

  /** Renders the quality pill buttons from a resolved qualities array,
   * plus the Low Latency toggle below them (live streams only). */
  _renderQualityItems(qualities) {
    this.qualityMenu.innerHTML = "";

    const pillsRow = document.createElement("div");
    pillsRow.className = "quality-menu-pills";

    // --- Auto quality (live only) ---
    if (!this.isVod) {
      const autoItem = document.createElement("button");
      autoItem.className = "quality-menu-item" + (this.autoQualityMode ? " active" : "");
      autoItem.textContent = "Auto";
      autoItem.title = "Starts at best quality, steps down automatically when buffering";
      autoItem.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectQuality("auto");
      });
      pillsRow.appendChild(autoItem);

      const sep = document.createElement("div");
      sep.className = "quality-menu-sep";
      pillsRow.appendChild(sep);
    }

    // --- Specific quality options ---
    // Reversed for DISPLAY only (highest first, how viewers scan) - qualities itself must stay in the
    // ascending order Rust returns, since _autoQualityTiers() indexes into that. Spread before reversing
    // so this.cachedQualities isn't mutated.
    const ordered = ["best", ...[...qualities].reverse()];
    for (const quality of ordered) {
      const item = document.createElement("button");
      item.className = "quality-menu-item";
      // In auto mode no specific quality is highlighted; 'Auto' row is.
      if (!this.autoQualityMode && quality === this.currentQuality) {
        item.classList.add("active");
      }
      item.textContent =
        quality === "best" ? "Best" : quality === "worst" ? "Worst" : quality;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectQuality(quality);
      });
      pillsRow.appendChild(item);
    }
    this.qualityMenu.appendChild(pillsRow);

    // --- Low Latency toggle (live streams only) ---
    if (!this.isVod) {
      const divider = document.createElement("div");
      divider.className = "quality-menu-divider";
      this.qualityMenu.appendChild(divider);

      const toggle = document.createElement("button");
      toggle.className = "quality-menu-toggle" + (this.lowLatency ? " on" : "");
      toggle.title = "Reduces stream delay to ~3-5 s (requires stream restart)";

      const switchPip = document.createElement("span");
      switchPip.className = "quality-toggle-switch";

      const label = document.createElement("span");
      label.textContent = "Low Latency";

      toggle.appendChild(switchPip);
      toggle.appendChild(label);

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        this.lowLatency = !this.lowLatency;
        toggle.classList.toggle("on", this.lowLatency);
        this.onLowLatencyChange(this.lowLatency);
        this.qualityMenu.classList.remove("open");
      });

      this.qualityMenu.appendChild(toggle);
    }

    // --- Auto-PiP on tab-out (global pref, live + vod) ---
    {
      const divider2 = document.createElement("div");
      divider2.className = "quality-menu-divider";
      this.qualityMenu.appendChild(divider2);

      const autoPipOn = localStorage.getItem("autoPipOnBlur") === "1";
      const t2 = document.createElement("button");
      t2.className = "quality-menu-toggle" + (autoPipOn ? " on" : "");
      t2.title = "Automatically open Picture-in-Picture when you switch away from the app";
      const sw2 = document.createElement("span");
      sw2.className = "quality-toggle-switch";
      const l2 = document.createElement("span");
      l2.textContent = "Auto-PiP on tab-out";
      t2.appendChild(sw2);
      t2.appendChild(l2);
      t2.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = localStorage.getItem("autoPipOnBlur") !== "1";
        localStorage.setItem("autoPipOnBlur", next ? "1" : "0");
        t2.classList.toggle("on", next);
        this.qualityMenu.classList.remove("open");
      });
      this.qualityMenu.appendChild(t2);
    }
  }

  // Auto quality: adaptive step-down on stalls, step-up on sustained good network (see the
  // constructor comment for why the two directions use different signals).

  /** Enables auto mode: starts listening for stall events on the video,
   * and starts the step-up polling timer. */
  _enableAutoMode() {
    this.autoQualityMode = true;
    this._autoTierIdx   = -1; // -1 = currently at 'best'
    this._autoStallCount = 0;
    this._lastStallAt = 0;
    clearTimeout(this._autoStallDebounce);
    clearTimeout(this._autoStallResetTimer);
    this.videoEl.addEventListener("waiting", this._boundAutoStall);

    clearInterval(this._autoStepUpInterval);
    this._autoStepUpInterval = setInterval(
      () => this._maybeStepUpAutoQuality(),
      STEP_UP_CHECK_MS,
    );
  }

  /** Disables auto mode, removes stall listeners, and stops the step-up
   * polling timer. */
  _disableAutoMode() {
    if (!this.autoQualityMode) return;
    this.autoQualityMode  = false;
    this._autoTierIdx     = -1;
    this._autoStallCount  = 0;
    this._lastStallAt = 0;
    clearTimeout(this._autoStallDebounce);
    clearTimeout(this._autoStallResetTimer);
    this._autoStallDebounce  = null;
    this._autoStallResetTimer = null;
    this.videoEl.removeEventListener("waiting", this._boundAutoStall);

    clearInterval(this._autoStepUpInterval);
    this._autoStepUpInterval = null;
  }

  /**
   * Called on every 'waiting'. A 3s debounce tells a real stall from network jitter: if still
   * low-readyState after 3s, count it. Two stalls within 90s -> step down one tier.
   */
  _handleAutoStall() {
    if (!this.autoQualityMode) return;
    clearTimeout(this._autoStallDebounce);
    this._autoStallDebounce = setTimeout(() => {
      if (!this.autoQualityMode) return;
      // Only act if the video is genuinely still buffering (readyState < 3).
      if (this.videoEl.readyState < HTMLVideoElement.HAVE_FUTURE_DATA) {
        this._autoStallCount++;
        // Recorded whether or not this stall crosses the step-down threshold - _maybeStepUpAutoQuality()
        // uses it alone to refuse a step-up shortly after ANY stall.
        this._lastStallAt = Date.now();
        // Reset the stall counter after 90 s of smooth playback so old
        // stalls don't accumulate against a later, unrelated network blip.
        clearTimeout(this._autoStallResetTimer);
        this._autoStallResetTimer = setTimeout(() => {
          this._autoStallCount = 0;
        }, 90_000);

        if (this._autoStallCount >= 2) {
          this._autoStallCount = 0;
          this._stepDownAutoQuality();
        }
      }
    }, 3000);
  }

  /**
   * Steps down one tier. Tiers are sorted lowest-to-highest, so just decrement the index. At 'best'
   * we jump to the top named tier; at the bottom we give up.
   */
  _stepDownAutoQuality() {
    const tiers = this._autoQualityTiers();
    if (!tiers.length) return;

    if (this._autoTierIdx === -1) {
      // Currently at 'best' - move to the highest specific tier.
      this._autoTierIdx = tiers.length - 1;
    } else if (this._autoTierIdx > 0) {
      this._autoTierIdx--;
    } else {
      return; // already at the lowest; nothing lower to try
    }

    const next = tiers[this._autoTierIdx];
    console.log(`[auto quality] buffering - stepping down to ${next}`);
    this.onQualityChange(next); // triggers restartStreamWithQuality in main.js
  }

  /**
   * Returns the browser's downlink estimate in Mbps (Chromium-only Network Information API), or null
   * if unsupported (Firefox/Safari). Even in Chromium it's an estimate, which is why
   * _maybeStepUpAutoQuality() also requires a stall-free quiet period. null (vs 0/Infinity) lets the
   * caller treat "no signal" distinctly from "bandwidth is bad" - it just never steps up.
   */
  _estimateDownlinkMbps() {
    const conn = navigator.connection
      || navigator.mozConnection
      || navigator.webkitConnection;
    if (!conn || typeof conn.downlink !== "number") return null;
    return conn.downlink;
  }

  /**
   * Looks up RESOLUTION_MBPS exactly, or for an unlisted resolution scales from the nearest entry by
   * the resolution ratio squared (bitrate scales with pixel count), so an unusual tier still gets a
   * sane estimate instead of NaN.
   */
  _requiredMbpsForResolution(res) {
    if (RESOLUTION_MBPS[res] != null) return RESOLUTION_MBPS[res];
    const known = Object.keys(RESOLUTION_MBPS).map(Number);
    const nearest = known.reduce((a, b) =>
      Math.abs(b - res) < Math.abs(a - res) ? b : a
    );
    const scale = (res * res) / (nearest * nearest);
    return RESOLUTION_MBPS[nearest] * scale;
  }

  // Polled while auto mode is active. Steps up one tier (never straight to 'best') when: not at top,
  // no stall in STEP_UP_MIN_QUIET_MS, and downlink clears the next tier by STEP_UP_HEADROOM. One tier at
  // a time so a wrong guess costs one restart. No downlink support means this no-ops, leaving
  // step-down.
  _maybeStepUpAutoQuality() {
    if (!this.autoQualityMode) return;
    if (this._autoTierIdx === -1) return; // already at 'best'

    if (Date.now() - this._lastStallAt < STEP_UP_MIN_QUIET_MS) return;

    const tiers = this._autoQualityTiers();
    if (!tiers.length) return;

    // _autoTierIdx indexes tiers when not at 'best' (-1). The tier ABOVE is index + 1; tiers.length
    // means "above the highest specific tier", i.e. 'best'.
    const nextIdx = this._autoTierIdx + 1;
    const movingToBest = nextIdx >= tiers.length;
    const nextLabel = movingToBest ? "best" : tiers[nextIdx];

    const downlinkMbps = this._estimateDownlinkMbps();
    if (downlinkMbps == null) return; // unsupported browser - never guess blind

    // 'best' has no resolution to look up - use the highest specific tier's requirement as the bar,
    // since 'best' is never lower bitrate than that.
    const targetRes = movingToBest
      ? this._rankResolution(tiers[tiers.length - 1])
      : this._rankResolution(nextLabel);
    const requiredMbps = this._requiredMbpsForResolution(targetRes);

    if (downlinkMbps < requiredMbps * STEP_UP_HEADROOM) return;

    this._autoTierIdx = movingToBest ? -1 : nextIdx;
    console.log(
      `[auto quality] network supports more (~${downlinkMbps.toFixed(1)} Mbps) ` +
      `- stepping up to ${nextLabel}`
    );
    this.onQualityChange(nextLabel);
  }

  /** Shared resolution-number extraction, used by both _autoQualityTiers()'s sort and the step-up
   * bitrate lookup, so the two can't drift on what "the resolution" means. */
  _rankResolution(q) {
    const m = q.match(/^(\d+)/);
    return m ? +m[1] : 0;
  }

  /**
   * Returns cached qualities sorted ascending (worst->best). The audio_only filter here is a
   * defensive backstop - _stripAudioOnly() already removes it at the source, so cachedQualities
   * shouldn't contain it. Kept in case cachedQualities is ever set from a path that bypasses that.
   */
  _autoQualityTiers() {
    if (!this.cachedQualities) return [];
    return [...this.cachedQualities]
      .filter((q) => q !== "audio_only")
      .sort((a, b) => this._rankResolution(a) - this._rankResolution(b));
  }

  // --- VOD chapters ---

  /** Fetches chapter markers from the Twitch GQL API and, if any exist,
   * shows the chapters button and caches the list. */
  async _fetchChapters() {
    if (!this.isVod || !this.currentChannel) return;
    const videoId = this.currentChannel.replace(/^vod:/, "");

    if (this.chaptersBtn) {
      this.chaptersBtn.style.display = "";
      this.chaptersBtn.style.opacity = "0.4";
      this.chaptersBtn.title = "Chapters (loading…)";
    }

    try {
      const chapters = await fetchVodChapters(videoId);
      if (!chapters.length) {
        if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
        return;
      }
      this._chapters      = chapters;
      this._chaptersLoaded = true;
      if (this.chaptersBtn) {
        this.chaptersBtn.style.display = "";
        this.chaptersBtn.style.opacity = "";
        this.chaptersBtn.title = `Chapters (${chapters.length})`;
      }
    } catch (err) {
      console.error("[chapters] fetch failed:", err);
      if (this.chaptersBtn) this.chaptersBtn.style.display = "none";
    }
  }

  /** Fetches the VOD's storyboard (seek-preview thumbnails) in the background - see
   * seek-thumbnails.js. VOD-only: Twitch's storyboard CDN 403s for the underlying VOD while the
   * broadcast is still live (storyboards aren't generated until it ends). Never throws or blocks:
   * loadVodStoryboard() resolves to a no-op on failure, and a stale videoId/isVod guard drops the
   * result if the user navigated away. */
  async _fetchStoryboard() {
    if (!this.isVod || !this.currentChannel) return;
    const videoId = this.currentChannel.replace(/^vod:/, "");
    const seekPreviewsUrl = await fetchVodSeekPreviewsUrl(videoId).catch((err) => {
      console.warn("[seek-thumbnails] failed to fetch seekPreviewsURL:", err);
      return null;
    });
    const storyboard = await loadVodStoryboard(seekPreviewsUrl);
    // Stale guard: only apply if still on the same VOD this was fetched for.
    if (this.isVod && this.currentChannel === `vod:${videoId}`) {
      this._storyboard = storyboard;
    }
  }

  /** Formats a seconds value as H:MM:SS (or M:SS for < 1 hour). */
  _formatChapterTime(totalSec) {
    const s = Math.floor(totalSec % 60);
    const m = Math.floor((totalSec / 60) % 60);
    const h = Math.floor(totalSec / 3600);
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  /** Returns the current playback position in VOD-relative seconds
   * (i.e. removes the HLS timestamp offset). */
  _vodPositionSec() {
    // HLS.js sets videoEl.currentTime in VOD seconds (0 = start of VOD).
    return this.videoEl.currentTime || 0;
  }

  /** Index of the chapter currently playing (-1 if no chapters). */
  _activeChapterIndex() {
    if (!this._chapters.length) return -1;
    const pos = this._vodPositionSec();
    let active = 0;
    for (let i = 0; i < this._chapters.length; i++) {
      if (this._chapters[i].positionSec <= pos) active = i;
    }
    return active;
  }

  toggleChaptersMenu() {
    if (!this._chaptersLoaded) return;
    const opening = !this.chaptersMenu.classList.contains("open");
    if (opening) {
      this._renderChapters();
      this._positionChaptersMenu();
    }
    this.chaptersMenu.classList.toggle("open", opening);
  }

  _positionChaptersMenu() {
    const rect = this.chaptersBtn.getBoundingClientRect();
    this.chaptersMenu.style.right  = `${window.innerWidth - rect.right}px`;
    this.chaptersMenu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    this.chaptersMenu.style.left   = "";
    this.chaptersMenu.style.top    = "";
  }

  _renderChapters() {
    this.chaptersMenu.innerHTML = "";
    const activeIdx = this._activeChapterIndex();
    this._chapters.forEach((ch, i) => {
      const item = document.createElement("button");
      item.className = "chapters-item" + (i === activeIdx ? " active" : "");

      const timeEl = document.createElement("span");
      timeEl.className = "chapters-item-time";
      timeEl.textContent = this._formatChapterTime(ch.positionSec);

      const titleEl = document.createElement("span");
      titleEl.className = "chapters-item-title";
      titleEl.textContent = ch.title;

      item.appendChild(timeEl);
      item.appendChild(titleEl);
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        // HLS.js handles seeking to any position instantly.
        this.videoEl.currentTime = ch.positionSec;
        this.onSeek(this.videoEl.currentTime);
        this.chaptersMenu.classList.remove("open");
      });
      this.chaptersMenu.appendChild(item);
    });

    // Scroll the active chapter into view.
    const activeEl = this.chaptersMenu.querySelector(".chapters-item.active");
    activeEl?.scrollIntoView({ block: "nearest" });
  }

  /**
   * Switches quality. 'auto' enables adaptive mode (starts at 'best', steps down on sustained
   * buffering); any specific quality exits auto mode.
   */
  selectQuality(quality) {
    this.qualityMenu.classList.remove("open");
    if (quality === "auto") {
      if (this.autoQualityMode) return; // already in auto, no-op
      this.currentQuality = "auto";
      this._enableAutoMode();
      this.onQualityChange("best"); // start at highest, step down if needed
      return;
    }
    // Manual selection -> exit auto mode so the user stays at their choice.
    this._disableAutoMode();
    if (quality === this.currentQuality) return;
    this.currentQuality = quality;
    this.onQualityChange(quality);
  }

  showControls() {
    if (!this.active) return;
    this.videoFrame.classList.add("controls-visible");
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hideControls(), HIDE_DELAY_MS);
  }

  hideControls() {
    this.videoFrame.classList.remove("controls-visible");
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  togglePause() {
    if (this.videoEl.paused || this.videoEl.ended) {
      this.videoEl.play().catch((err) => console.error("play() failed:", err));
    } else {
      this.videoEl.pause();
    }
    // setPauseIcon is also called by the 'play'/'pause' listeners in bindEvents - calling it here too
    // keeps the icon snappy rather than waiting for the event, while the listeners stay the source of
    // truth for changes not from this method.
    this.setPauseIcon(this.videoEl.paused);
  }

  setPauseIcon(paused) {
    this.playIcon.style.display = paused ? "block" : "none";
    this.pauseIcon.style.display = paused ? "none" : "block";
    this.centerPlayBtn.style.display = paused ? "flex" : "none";
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    this.videoEl.muted = this.isMuted;
    this.setMuteIcon(this.isMuted);
  }

  setMuteIcon(muted) {
    this.volumeIcon.style.display = muted ? "none" : "block";
    this.muteIcon.style.display = muted ? "block" : "none";
    this._syncPipMuteIcon(muted);
  }

  /** @param {number} volume - 0 to 130, matching the slider. HTMLMediaElement.volume only accepts
   * 0..1, so values above 100 (the old mpv --volume-max=130 boost) clamp to 100 - the web <video> has
   * no equivalent of mpv's amplification past unity. */
  setVolume(volume) {
    const clamped = Math.min(100, Math.max(0, volume));
    this.videoEl.volume = clamped / 100;
    // Mirror the raw (pre-clamp) value onto both sliders so the main and Document PiP volume UIs agree
    // whichever was dragged - assigning .value doesn't re-fire 'input', so no feedback loop.
    this.volumeSlider.value = volume;
    if (this._pipEls) {
      this._pipEls.slider.value = volume;
      // Keep the tooltip in step on plain volume drags too - _syncPipMuteIcon (which also writes this
      // title) only runs on mute-state changes, and most drags don't change it.
      if (!this.isMuted || volume > 0) {
        this._pipEls.slider.title = `${Math.round(volume)}%`;
      }
    }
    if (volume > 0 && this.isMuted) {
      this.isMuted = false;
      this.videoEl.muted = false;
      this.setMuteIcon(false);
    }
  }

  /**
   * seekable spans the WHOLE stream (0 to live edge) even after trimBuffered() evicted old data - it
   * reflects the MediaSource's duration, not what's still present to play. So reachability checks use
   * this (the real appended ranges). Returns the buffered range containing (or nearest) currentTime,
   * the contiguous window playback can reach without stalling on evicted data.
   */
  _getActualBufferedRange() {
    const buffered = this.videoEl.buffered;
    if (!buffered || buffered.length === 0) return null;
    const currentTime = this.videoEl.currentTime;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
        return { start: buffered.start(i), end: buffered.end(i) };
      }
    }
    // Fallback: the playhead isn't inside any buffered range (shouldn't normally happen) - use the
    // most recent range, nearest the live edge.
    const last = buffered.length - 1;
    return { start: buffered.start(last), end: buffered.end(last) };
  }

  /**
   * Kick counterpart to _getActualBufferedRange(). Kick's live session runs on hls.js, which computes
   * `seekable` from the live playlist's own sliding window (Kick's CDN retains more so its player can
   * rewind - see liveEdge in vod-player.js), independent of the decode buffer. Trusting seekable lets a
   * Kick session rewind as far as the manifest allows (hls.js refetches an evicted fragment). Falls
   * back to the buffered range if seekable is empty (e.g. right at attach).
   */
  _getKickSeekableRange() {
    const seekable = this.videoEl.seekable;
    if (seekable && seekable.length > 0) {
      const end = seekable.end(seekable.length - 1);
      return { start: seekable.start(0), end };
    }
    return this._getActualBufferedRange();
  }

  // Seek live within what the MSE feeder buffered. Twitch live is limited to that window (one byte
  // stream from the live edge, no on-demand segments, trimBuffered() evicts past TRAILING_WINDOW). Kick
  // shares this branch but has a real server-side DVR window via hls.js, so it can seek anywhere in
  // that window.
  seekToClickPosition(event) {
    const rect = this.seekBarTrack.getBoundingClientRect();
    const clickRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));

    if (this.isVod) {
      // With HLS.js, seeking is instant - just set currentTime.
      // HLS.js handles loading segments around the new position automatically.
      const total = this.videoEl.duration || this.vodTotalSeconds || 0;
      if (total <= 0) return;
      this.videoEl.currentTime = clickRatio * total;
      this.onSeek(this.videoEl.currentTime);
    } else if (this._liveDvr) {
      // Already in live-DVR mode: seek bar spans stream start to now.
      const streamStartedAt = this._liveDvr.streamStartedAt;
      const totalSecs = (Date.now() - streamStartedAt) / 1000;
      const targetVodOffset = clickRatio * totalSecs;
      this.videoEl.currentTime = targetVodOffset;
      this.onSeek(this.videoEl.currentTime);
    } else {
      // Live: seek within the reachable window, OR trigger live-DVR.
      const seekable = this.videoEl.seekable;
      if (!seekable || seekable.length === 0) return;
      const end = seekable.end(seekable.length - 1);

      // Twitch's raw MSE relay: seekable spans the whole session even after trimming, so the
      // actually-buffered range (not seekable's start) is the real earliest reachable point. Kick's
      // hls.js seekable IS accurate for a live playlist (reflects the manifest's DVR window) - see
      // _getKickSeekableRange.
      const actualRange = this._isKickSession
        ? this._getKickSeekableRange()
        : this._getActualBufferedRange();
      const start = actualRange ? actualRange.start : end;
      const bufferDuration = end - start;
      if (bufferDuration <= 0) return;

      console.log(`[live-dvr] seekToClickPosition: clickRatio=${clickRatio.toFixed(3)} liveDvrStreamStartedAt=${this.liveDvrStreamStartedAt} onLiveDvrSeek=${!!this.onLiveDvrSeek} start=${start.toFixed(1)} end=${end.toFixed(1)} currentTime=${this.videoEl.currentTime.toFixed(1)}`);

      if (this.liveDvrStreamStartedAt && this.onLiveDvrSeek) {
        // Seek bar spans the full stream: map clickRatio to VOD time.
        const streamDuration = (Date.now() - this.liveDvrStreamStartedAt) / 1000;
        const targetStreamPos = clickRatio * streamDuration;
        const secondsBehindLive = streamDuration - targetStreamPos;

        console.log(`[live-dvr] streamDuration=${streamDuration.toFixed(1)} targetStreamPos=${targetStreamPos.toFixed(1)} secondsBehindLive=${secondsBehindLive.toFixed(1)} bufferDuration=${bufferDuration.toFixed(1)}`);

        if (secondsBehindLive < 10) {
          // Near the live edge: just jump to live edge in the buffer
          console.log(`[live-dvr] → jumping to live edge`);
          this.videoEl.currentTime = end;
        } else if (secondsBehindLive <= bufferDuration) {
          // Within the actually-buffered window: seek directly without
          // switching to DVR
          const absoluteTarget = end - secondsBehindLive;
          console.log(`[live-dvr] → seeking within buffer to ${absoluteTarget.toFixed(1)}`);
          this.videoEl.currentTime = Math.min(end, Math.max(start, absoluteTarget));
        } else if (this._isKickSession && !this.kickDvrAvailable) {
          // Kick session with no resolved recording to swap onto (VODs disabled, or the lookup hasn't
          // succeeded) - the furthest back is whatever hls.js still has, so clamp there with a notice. When
          // kickDvrAvailable IS set, this falls through to the same onLiveDvrSeek Twitch uses.
          console.log(`[live-dvr] → Kick (no DVR source): clamping to earliest buffered point (${start.toFixed(1)})`);
          this.videoEl.currentTime = start;
          if (this.onLiveDvrClamped) {
            this.onLiveDvrClamped({
              requestedSecondsBehindLive: secondsBehindLive,
              landedSecondsBehindLive: end - start,
            });
          }
        } else {
          // Past the actually-buffered window: trigger live-DVR
          console.log(`[live-dvr] → triggering DVR with secondsBehindLive=${secondsBehindLive.toFixed(1)}`);
          this.onLiveDvrSeek(secondsBehindLive);
        }
      } else {
        // No DVR info: plain live seek within the actually-buffered window
        const target = start + clickRatio * bufferDuration;
        console.log(`[live-dvr] → no DVR, seeking within buffer window to ${target.toFixed(1)}`);
        this.videoEl.currentTime = Math.min(end, Math.max(start, target));
      }
    }
  }

  /**
   * Seeks by `deltaSeconds` from the current position - backs the ArrowLeft/Right shortcuts. Mirrors
   * seekToClickPosition() (same live/VOD branching and live-buffer limit), just driven by a relative
   * delta instead of an absolute click-ratio.
   */
  seekRelative(deltaSeconds) {
    if (this.isVod || this._liveDvr) {
      // VOD or live-DVR: HLS.js handles arbitrary seeking.
      const total = this._liveDvr
        ? (Date.now() - this._liveDvr.streamStartedAt) / 1000
        : (this.videoEl.duration || this.vodTotalSeconds || 0);
      if (total <= 0) return;
      const target = this.videoEl.currentTime + deltaSeconds;
      this.videoEl.currentTime = Math.min(total, Math.max(0, target));
      this.onSeek(this.videoEl.currentTime);
    } else {
      const seekable = this.videoEl.seekable;
      if (!seekable || seekable.length === 0) return;
      const end = seekable.end(seekable.length - 1);

      // Same fix as seekToClickPosition: Kick's hls.js seekable is accurate (the live manifest's DVR
      // window); Twitch's raw MSE relay needs the actually-buffered range, since its seekable reports the
      // whole session even after trimming.
      const actualRange = this._isKickSession
        ? this._getKickSeekableRange()
        : this._getActualBufferedRange();
      const start = actualRange ? actualRange.start : end;
      if (end - start <= 0) return;
      const target = this.videoEl.currentTime + deltaSeconds;
      // ArrowLeft past the buffer start: trigger live-DVR if available. For Kick that means
      // kickDvrAvailable (a recording was resolved); without one it clamps with a notice.
      if (target < start && this.onLiveDvrSeek && (!this._isKickSession || this.kickDvrAvailable)) {
        // How far behind the live edge the user is trying to go -
        // current position minus the delta, measured from live edge.
        const secondsBehindLive = (end - this.videoEl.currentTime) + Math.abs(deltaSeconds);
        this.onLiveDvrSeek(secondsBehindLive);
      } else {
        if (target < start && this._isKickSession && !this.kickDvrAvailable && this.onLiveDvrClamped) {
          const secondsBehindLive = (end - this.videoEl.currentTime) + Math.abs(deltaSeconds);
          this.onLiveDvrClamped({
            requestedSecondsBehindLive: secondsBehindLive,
            landedSecondsBehindLive: end - start,
          });
        }
        this.videoEl.currentTime = Math.min(end, Math.max(start, target));
      }
    }
    this.showControls();
  }

  /** Shows a timestamp tooltip above the seek bar tracking the cursor's x position. */
  updateSeekTooltip(event) {
    const duration = this.lastKnownDuration;
    if (duration <= 0) {
      this.seekBarTooltip.classList.remove("visible");
      this.seekBarThumbnail.classList.remove("visible");
      return;
    }

    const rect = this.seekBarTrack.getBoundingClientRect();
    const hoverRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const hoverSeconds = hoverRatio * duration;

    if (this.isVod) {
      const total = this.vodTotalSeconds || duration;
      const absSeconds = hoverRatio * total;
      const muted = this._mutedSegments.some(
        (seg) => absSeconds >= (seg.offset ?? 0) && absSeconds < (seg.offset ?? 0) + (seg.duration ?? 0)
      );
      this.seekBarTooltip.textContent = muted
        ? `${this.formatDuration(absSeconds)} (Muted)`
        : this.formatDuration(absSeconds);

      this._updateSeekThumbnail(absSeconds);
    } else {
      // For live, show how far behind the live edge the cursor is.
      const behindSeconds = Math.max(0, duration - hoverSeconds);
      this.seekBarTooltip.textContent = behindSeconds < 1 ? "live" : `-${this.formatDuration(behindSeconds)}`;
      // No storyboard exists for live, including live-DVR - Twitch's CDN 403s for the underlying VOD
      // while the broadcast is in progress, so it isn't fetched for DVR (see attachHlsDvr).
      this._updateSeekThumbnail(null);
    }

    // Position the tooltip AND thumbnail horizontally at the cursor,
    // clamped so neither overflows past either edge of the track.
    const offsetX = event.clientX - rect.left;
    const clampedOffsetX = Math.min(Math.max(offsetX, 20), rect.width - 20);
    this.seekBarTooltip.style.left = `${clampedOffsetX}px`;
    this.seekBarThumbnail.style.left = `${clampedOffsetX}px`;
    this.seekBarTooltip.classList.add("visible");
  }

  /** Shows/hides and positions the storyboard thumbnail for the given absolute VOD position - shared
   * by updateSeekTooltip's VOD and live-DVR branches. Pass null to force-hide (e.g. live, no storyboard
   * there). */
  _updateSeekThumbnail(absSeconds) {
    const frame = absSeconds == null ? null : this._storyboard.frameFor(absSeconds);
    if (frame) {
      this.seekBarThumbnail.style.width = `${frame.width}px`;
      this.seekBarThumbnail.style.height = `${frame.height}px`;
      this.seekBarThumbnail.style.backgroundImage = `url("${frame.url}")`;
      this.seekBarThumbnail.style.backgroundPosition = `${frame.backgroundX}px ${frame.backgroundY}px`;
      this.seekBarThumbnail.classList.add("visible");
    } else {
      this.seekBarThumbnail.classList.remove("visible");
    }
  }

  /** Formats seconds as m:ss for tooltip/display purposes (e.g. 95 -> "1:35"). */
  formatDuration(totalSeconds) {
    const total = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** Jumps to the live edge. In normal live, seeks to the end of the MSE buffer. In live-DVR mode
   * (watching the in-progress VOD via HLS.js), fires onLiveDvrSeek(0) to signal "go back to live relay"
   * - main.js tears down HLS.js and reconnects the MSE feeder. */
  jumpToLive() {
    if (this._liveDvr) {
      // Signal main.js to switch back to the live relay (0 = live edge)
      if (this.onLiveDvrSeek) this.onLiveDvrSeek(0);
      return;
    }
    // Uses the ACTUAL buffered range, not videoEl.seekable - seekable reports the whole MediaSource
    // range regardless of what trimBuffered() evicted, same reason seekToClickPosition/seekRelative
    // stopped using it. Jumping to seekable's stale "end" would seek into a gap with nothing to play -
    // confirmed as why clicking Live did nothing during a stall.
    const actualRange = this._getActualBufferedRange();
    if (!actualRange) return;
    this.videoEl.currentTime = actualRange.end;
    // Drop the behind-live anchor so pollProgress re-derives it against this position. Without it the
    // readout kept accumulated drift and stayed stuck at something like "-11:36" after going live.
    this._liveSessionAbsoluteStart = null;
    // Force a resume in case the element got stuck "waiting" during the stall in a way a bare
    // currentTime change doesn't clear (see the stall-recovery watchdog in stream-player.js).
    this.videoEl.play().catch(() => {});
  }

  /**
   * Draws red seek-bar markers for copyright-muted VOD ranges (get_vod_muted_segments) and stores the
   * raw list so updateSeekTooltip can label them on hover.
   * @param {{offset, duration}[]} segments - Helix's muted_segments, seconds.
   * @param {number} totalDurationSecs - the VOD length, to convert offsets to seek-bar percentages.
   */
  renderMutedSegments(segments, totalDurationSecs) {
    this._mutedSegments = segments || [];
    this.mutedSegmentsContainer.innerHTML = "";
    if (!totalDurationSecs || totalDurationSecs <= 0 || this._mutedSegments.length === 0) return;

    for (const seg of this._mutedSegments) {
      const offset = seg.offset ?? 0;
      const duration = seg.duration ?? 0;
      if (duration <= 0) continue;
      // Clamp to the bar's [0, total] range - Twitch's data has included a segment extending slightly
      // past a VOD's reported duration (rounding on their end), which would overflow the bar past 100%.
      const startPct = Math.max(0, Math.min(100, (offset / totalDurationSecs) * 100));
      const endPct = Math.max(0, Math.min(100, ((offset + duration) / totalDurationSecs) * 100));
      if (endPct <= startPct) continue;

      const marker = document.createElement("div");
      marker.className = "seek-bar-muted-segment";
      marker.style.left = `${startPct}%`;
      marker.style.width = `${endPct - startPct}%`;
      this.mutedSegmentsContainer.appendChild(marker);
    }
  }

  pollProgress() {
    if (!this.active) return;

    const position = this.videoEl.currentTime;
    let duration;

    if (this.isVod) {
      duration = this.vodTotalSeconds || this.videoEl.duration || 0;
    } else if (this._liveDvr) {
      // Live-DVR: duration is the full stream length so far.
      duration = (Date.now() - this._liveDvr.streamStartedAt) / 1000;
    } else {
      const seekable = this.videoEl.seekable;
      if (seekable && seekable.length > 0) {
        duration = seekable.end(seekable.length - 1) - seekable.start(seekable.length - 1);
      } else {
        duration = 0;
      }
    }

    this.lastKnownPosition = position;
    this.lastKnownDuration = duration;

    if (this.isVod || this._liveDvr) {
      const vodPosSecs = position;
      const total = this._liveDvr ? duration : (this.videoEl.duration || this.vodTotalSeconds || 0);
      const ratio = total > 0 ? Math.min(1, Math.max(0, vodPosSecs / total)) : 0;
      this.seekBarFill.style.width = `${ratio * 100}%`;
      if (this._liveDvr) {
        const behindLive = Math.max(0, duration - position);
        this.timeDisplay.textContent = behindLive < 5
          ? "live"
          : `-${this.formatDuration(Math.round(behindLive))}`;
        this.liveBtn.classList.toggle("at-live-edge", behindLive < 5);
      } else {
        this.timeDisplay.textContent =
          `${this.formatDuration(vodPosSecs)} / ${this.formatDuration(total)}`;
      }
    } else {
      // Normal live, not yet in DVR. currentTime is session-relative (ffmpeg rebases timestamps to ~0),
      // so seekable.end() - currentTime measures buffering lag, not distance behind the broadcast. Anchor
      // against wall-clock (liveDvrStreamStartedAt) instead, derived from currentTime when first
      // available.
      if (this.liveDvrStreamStartedAt) {
        // Re-anchor whenever playback sits at the buffered live edge. Otherwise behindSeconds banks every
        // stall/pause permanently and drifts unbounded. Sitting at the buffered end is "live" for this
        // session, so re-anchoring there self-corrects; seeking back freezes the anchor so it correctly
        // reports how far back the user went.
        const liveRange = this._getActualBufferedRange();
        const atBufferedLiveEdge =
          liveRange && position >= liveRange.end - LIVE_EDGE_THRESHOLD_SECONDS;
        if (this._liveSessionAbsoluteStart == null || atBufferedLiveEdge) {
          // The broadcast-relative position at videoEl.currentTime === 0 - how far into the broadcast this
          // session started, working back from now.
          this._liveSessionAbsoluteStart =
            (Date.now() - this.liveDvrStreamStartedAt) / 1000 - position;
        }
        const absolutePosition = this._liveSessionAbsoluteStart + position;
        const broadcastElapsedNow = (Date.now() - this.liveDvrStreamStartedAt) / 1000;
        // The hover tooltip reads lastKnownDuration as the scale the bar's width represents - it was still
        // holding the ~120s MSE buffer value even though the bar spans the full broadcast once DVR info
        // exists, producing tooltip values like "-1:15" near the start of a multi-hour bar. Override it so
        // fill and tooltip share the broadcast scale; updateSeekTooltip is its only consumer.
        this.lastKnownDuration = broadcastElapsedNow;
        const behindSeconds = Math.max(0, broadcastElapsedNow - absolutePosition);
        const ratio = broadcastElapsedNow > 0
          ? Math.min(1, Math.max(0, absolutePosition / broadcastElapsedNow))
          : 1;
        this.seekBarFill.style.width = `${ratio * 100}%`;
        this.timeDisplay.textContent = behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS
          ? "live"
          : `-${this.formatDuration(behindSeconds)}`;
        this.liveBtn.classList.toggle("at-live-edge", behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS);
      } else {
        // No DVR info yet - the first ~30-60s, before Twitch's VOD-ready check resolves. Falls back to the
        // session-relative calc, harmless this early since real behind-live distance is small moments after
        // joining.
        const seekable = this.videoEl.seekable;
        const liveEdge = seekable && seekable.length > 0
          ? seekable.end(seekable.length - 1)
          : position;
        const behindSeconds = Math.max(0, liveEdge - position);
        const ratio = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 1;
        this.seekBarFill.style.width = `${ratio * 100}%`;
        this.timeDisplay.textContent = behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS
          ? "live"
          : `-${this.formatDuration(behindSeconds)}`;
        this.liveBtn.classList.toggle("at-live-edge", behindSeconds < LIVE_EDGE_THRESHOLD_SECONDS);
      }
    }
  }
}
