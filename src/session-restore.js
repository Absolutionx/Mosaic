// Remember what was playing across a reload. F5 wipes JS state and drops you on Home even
// though the relay may still be alive, so this replays the last watch call on next boot. It
// stores only the identity (id, platform, entry point); quality/lowLatency/position recover
// on their own. Reload and cold start are intentionally the same path.

const KEY = "activeSession";

/**
 * Records the current watch session so the next boot can replay it.
 * @param {object} s
 * @param {"twitchLive"|"kickLive"|"twitchVod"|"kickVod"} s.kind - which watch fn to replay.
 * @param {string} s.id - channel login (live) or video id (vod).
 * @param {number} [s.vodTotalSeconds] - carried so the replay renders its scrub bar without
 *   a refetch; position is not stored (get_vod_progress owns it).
 */
export function rememberSession(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    // Persistence is a nicety, never load-bearing - a full localStorage must not break
    // playback.
    console.warn("[session-restore] failed to save session:", err);
  }
}

/** Clears the remembered session on Stop, so an explicit Stop is respected across a
 *  reload. */
export function forgetSession() {
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    console.warn("[session-restore] failed to clear session:", err);
  }
}

/**
 * Replays the remembered session, if any, via the matching watch function. Called once at
 * boot. Failures swallow to Home (offline channel, deleted VOD, bad storage).
 * @param {object} watchers - the four entry points, injected to avoid a circular import.
 * @returns {boolean} true if replayed (informational - the caller shows Home regardless).
 */
export function restoreSession(watchers) {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return false;
  }
  if (!s || !s.kind || !s.id) return false;

  try {
    switch (s.kind) {
      case "twitchLive":
        watchers.watchChannel(s.id);
        return true;
      case "kickLive":
        watchers.watchKickChannel(s.id);
        return true;
      case "twitchVod":
        // startPositionSecs omitted -> watchVod consults get_vod_progress, like a fresh card
        // click, so you resume where you left off.
        watchers.watchVod(s.id, s.vodTotalSeconds || 0, s.broadcastLogin || "");
        return true;
      case "kickVod":
        watchers.watchKickVod(s.id, s.vodTotalSeconds || 0);
        return true;
      default:
        return false;
    }
  } catch (err) {
    console.warn("[session-restore] failed to replay session:", err);
    return false;
  }
}
