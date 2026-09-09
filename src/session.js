// shared "what's currently playing" state in one object, so every module gets a live
// writable view (ES module `let` bindings are read-only to importers). only cross-module
// state belongs here

export const session = {

  playing: false,

  // the channel (or "vod:<id>") the user MEANT to watch. async callbacks re-check this
  // after every await; if it changed, the work belongs to a dead session and gets dropped
  intendedChannel: null,

  // the quality streamlink last launched with. switching relaunches streamlink rather
  // than flipping an HLS level, so this is the record of it
  currentQuality: "best",

  lowLatency: localStorage.getItem("lowLatency") === "true",

  liveDvrInfo: null,

  // cached DVR playlist, keyed by videoId+quality so a stale entry is never reused
  liveDvrM3u8Cache: null,

  lastLiveDvrClampNoticeAt: 0,

  // set when the Twitch stream ended and playback failed over to the Kick simulcast
  kickFailover: null,

  // a stream dying right after every restart means something's wrong, so give up after
  // 4 attempts in a 2-minute window. any 2 minutes of health resets it

  streamRecoveryAttempts: 0,
  lastStreamRecoveryAt: 0,

  lastActivePage: "home",

  pageVisible: true,

  vodsChannel: null,
  vodsChannelIsKick: false,
};
