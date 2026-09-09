// remember what was playing across a reload. F5 wipes JS state and dumps you on Home
// even though the relay may still be alive, so replay the last watch call on next boot.
// stores only the identity; quality/lowLatency/position recover on their own, and reload
// and cold start are deliberately the same path

const KEY = "activeSession";

// position is deliberately not stored here, get_vod_progress owns it. vodTotalSeconds is
// carried so the replay can draw its scrub bar without a refetch
export function rememberSession(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    // persistence is a nicety, never load-bearing, a full localStorage mustn't break playback
    console.warn("[session-restore] failed to save session:", err);
  }
}

// clear on Stop, so an explicit Stop is respected across a reload
export function forgetSession() {
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    console.warn("[session-restore] failed to clear session:", err);
  }
}

// watchers are injected to dodge a circular import. failures swallow to Home (offline
// channel, deleted VOD, bad storage); the return is informational, caller shows Home anyway
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
        // startPositionSecs omitted -> watchVod consults get_vod_progress, same as a fresh card
        // click, so you resume where you left off
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
