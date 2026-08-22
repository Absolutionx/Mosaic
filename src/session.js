// Shared "what is currently playing" state, in one object so every module gets a live,
// writable view (an object, since ES module `let` bindings are read-only to importers). Only
// cross-module state belongs here.

export const session = {
  // --- Playback ---

  /** Is a stream/VOD currently playing? */
  playing: false,

  /** The channel (or "vod:<id>") the user MEANT to watch. Async callbacks re-check this
   * after every await; if it changed, the work belongs to a dead session and is dropped. */
  intendedChannel: null,

  /** The quality streamlink last launched with. Switching relaunches streamlink rather than
   * flipping an HLS level, so this IS the record of it. */
  currentQuality: "best",

  /** Twitch's low-latency mode (TLLS). Persisted across restarts. */
  lowLatency: localStorage.getItem("lowLatency") === "true",

  // --- Live DVR ---

  /** Live-DVR info for the current live stream, or null. */
  liveDvrInfo: null,

  /** Cached DVR playlist, keyed by videoId+quality so a stale entry is never reused.
   * { videoId, quality, url }. */
  liveDvrM3u8Cache: null,

  /** Rate-limits the "clamped to the start of the DVR window" notice. */
  lastLiveDvrClampNoticeAt: 0,

  // --- Kick failover ---

  /** Set when the Twitch stream ended and playback failed over to the Kick simulcast. Null
   * on Twitch. */
  kickFailover: null,

  // --- Reconnect budget ---
  // A stream dying right after every restart means something's wrong - give up after 4
  // attempts in a 2-minute window. Any 2 minutes of health resets it.

  streamRecoveryAttempts: 0,
  lastStreamRecoveryAt: 0,

  // --- Navigation ---

  /** Which page to return to when the user leaves the player. */
  lastActivePage: "home",

  /** Is a page (home/browse/vods) showing over the player? */
  pageVisible: true,

  /** The channel whose VODs the VODs page is currently showing. */
  vodsChannel: null,
  vodsChannelIsKick: false,
};
