import "./titlebar.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { getCurrentWindow, currentMonitor, availableMonitors, cursorPosition } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TwitchChat } from "./chat.js";
import { openChatFilterModal } from "./chat-filter.js";
import { openPinAuthModal } from "./pin-auth.js";
import { openRewardsModal } from "./rewards.js";
import { initModLog, openModLogModal } from "./mod-log.js";
import { initModMenu } from "./mod-menu.js";
import { initWhispers, openWhispers } from "./whispers.js";
import { initCommandPalette } from "./command-palette.js";
import { showRaidBanner, showRaidArrived, hideRaidBanner } from "./raid-banner.js";
import { PlaybackControls } from "./playback-controls.js";
import { TrackId } from "./track-id.js";
import { startVodHeatmap } from "./vod-heatmap.js";
import { initTooltips } from "./tooltips.js";

// themed tooltips app-wide (replaces the OS-drawn `title` tooltips, see tooltips.js)
initTooltips();
import { TwitchAuth } from "./auth.js";
import { ChannelsSidebar } from "./sidebar.js";
import { startHypeBadgePolling } from "./hype-badges.js";
import { startDropsAutoClaim, stopDropsAutoClaim } from "./drops-autoclaim.js";
import { getSetting, setSetting, onSettingChange, applyAppearance } from "./settings.js";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { exportBackup, importBackup } from "./backup.js";
import { checkForUpdatesNow } from "./update-banner.js";
import { openSettingsPanel, configureSettingsPanel, getSettingsIndex } from "./settings-panel.js";
import { isKickFollowed, toggleKickFollow } from "./kick-follows.js";
import { getKickAlias, setKickAlias, kickSlugFor } from "./kick-aliases.js";
import { HomeFeed } from "./home.js";
import { BrowsePage } from "./browse.js";
import { isKick, togglePlatform, onPlatformChange, setPlatform, feedInvoke } from "./platform.js";
import { VodsPage } from "./vods.js";
import { streamHasDropsEnabled } from "./drops.js";
import { session } from "./session.js";
import { rememberSession, forgetSession, restoreSession } from "./session-restore.js";
import { formatViewerCount } from "./format.js";
import { checkStreamDeps } from "./deps-banner.js";
import { checkForUpdate } from "./update-banner.js";
import { MultiView } from "./multiview.js";
import { updateDropsBanner, hideDropsBanner, resetDropsDismissal } from "./drops-banner.js";
import { openHiddenChannelsModal } from "./hidden-channels.js";
import { initMiniPlayer, activateMiniPlayer, deactivateMiniPlayer, resetMiniPlayerDismissal } from "./mini-player.js";
import {
  initLayout, switchPage, updateBackToStreamBtn, setTheaterMode,
  toggleTheaterModeAndResync, toggleChatCollapse, toggleFullscreen,
  isAppFullscreen,
} from "./layout.js";
import {
  initChannelInfoBar, channelInfoKickAliasBtn,
  updateChannelInfoBar, updateKickChannelInfoBar, updateStreamInfoOverlay,
  hideChannelInfoBar, resyncChannelInfoBarVisibility, refreshKickAliasBtn,
  startChannelInfoRefresh, ensureChannelInfoBarFor, showVodInInfoBar,
  currentChannelFollowState, toggleCurrentFollow,
} from "./channel-info-bar.js";

const channelInput = document.getElementById("channel-input");
const watchBtn = document.getElementById("watch-btn");
const loginBtn = document.getElementById("login-btn");
const statusText = document.getElementById("status-text");
const videoPlaceholder = document.getElementById("video-placeholder");
const chatMessages = document.getElementById("chat-messages");
const chatStatus = document.getElementById("chat-status");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const appEl = document.getElementById("app");
const theaterBtn = document.getElementById("theater-btn");
const chatCollapseToggle = document.getElementById("chat-collapse-toggle");
const chatExpandStrip = document.getElementById("chat-expand-strip");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const appWindow = getCurrentWindow();

// the window is created hidden (visible:false) and maximized in Rust setup before its first
// paint. reveal it only after the dark UI has actually painted, so the WebView2 white surface is
// never visible (the real cure for the maximized-launch flash, see tauri#14068). double rAF
// guarantees a rendered frame; the timeout is a failsafe so the window can never stay stuck hidden
{
  let shown = false;
  const revealWindow = () => {
    if (shown) return;
    shown = true;
    appWindow.show().catch(() => {});
  };
  requestAnimationFrame(() => requestAnimationFrame(revealWindow));
  setTimeout(revealWindow, 3000);
}
const homeTab = document.getElementById("home-tab");
const browseTab = document.getElementById("browse-tab");
const backToStreamBtn = document.getElementById("back-to-stream-btn");
// alias-button visibility hook (no-op in production; the DEV "Test failover" button installs
// one). session.vodsChannel / vodsChannelIsKick track which channel's VODs the page opened for and
// whether it's a Kick slug, so Videos re-opens from the right platform

// live-DVR state (all on `session`): liveDvrInfo is the in-progress recording VOD for seeking
// past the MSE buffer; liveDvrM3u8Cache is its prefetched m3u8 (keyed by videoId+quality);
// lastLiveDvrClampNoticeAt throttles the Kick clamp notice

// resolves and caches the DVR VOD's m3u8 in the background. safe to call speculatively, failures are silent since onLiveDvrSeek resolves synchronously on a cache miss
function prefetchLiveDvrM3u8() {
  if (!session.liveDvrInfo) return;
  const { videoId } = session.liveDvrInfo;
  const quality = session.currentQuality;
  invoke("get_vod_m3u8_url", { videoId, quality })
    .then(url => {
      // only cache if still relevant (channel/VOD/quality unchanged while the request was in flight)
      if (session.liveDvrInfo?.videoId === videoId && session.currentQuality === quality) {
        session.liveDvrM3u8Cache = { videoId, quality, url };
        console.log(`[live-dvr] prefetched m3u8 for id=${videoId} quality=${quality}`);
      }
    })
    .catch(err => {
      console.log(`[live-dvr] prefetch failed (will resolve on demand instead): ${err}`);
    });
}
// session.intendedChannel is set synchronously atop watchChannel (before any await) so a late
// Helix lookup can't stomp the info bar after a switch; distinct from currentChannel (set only on
// start success). kickFailover is non-null while on a Kick simulcast; currentQuality is what streamlink last launched with

const chat = new TwitchChat({
  container: chatMessages,
  statusEl: chatStatus,
  inputEl: chatInput,
  sendBtn: chatSendBtn,
});
// the AutoMod toggle button lives in static HTML, so its click handler is wired here; chat.js still owns its visibility/count badge
const automodToggleBtn = document.getElementById("automod-toggle-btn");
automodToggleBtn?.addEventListener("click", () => chat.toggleAutomodPanel());
// persists across sessions. only applies to live streams

// background-resolves a LOW quality playlist for the current VOD and caches it for PiP. the main
// player's URL is a single-variant media playlist (streamlink resolves one quality), so
// capLevelToPlayerSize can't help and a ~480px PiP pulled source segments. resolving here pays the
// streamlink spawn once per VOD while nothing waits on it. PiP falls back to the main URL if this fails or goes stale
function resolvePipVodUrl(videoId, currentM3u8Url) {
  const key = `pipVodLowUrl:${videoId}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    // "fresh" means fresh for THIS session: these URLs point at the app's localhost HLS proxy, whose
    // port is ephemeral per launch, so a URL outliving its session points at a dead port. the current
    // main-player URL is from this session, so matching ports is the session check
    const samePort = cached?.url && currentM3u8Url &&
      new URL(cached.url).port === new URL(currentM3u8Url).port;
    if (samePort && Date.now() - cached.ts < 3 * 3600_000) return; // still fresh AND this session
  } catch (_) {}
  invoke("get_vod_m3u8_url", { videoId, quality: "480p,360p,worst" })
    .then((url) => {
      localStorage.setItem(key, JSON.stringify({ url, ts: Date.now() }));
      console.log(`[main] pre-resolved low-quality VOD playlist for PiP (${videoId})`);
    })
    .catch((err) => {
      console.warn("[main] PiP low-quality VOD pre-resolve failed (PiP will use the main-quality URL):", err);
    });
}

// auto-recovery guard for onStreamDead: allow a burst of restarts (blips recover on the first),
// but a relay dying right after every restart means something's wrong, give up after 4 attempts in
// a 2-minute window. any 2 minutes of health resets the budget

// schedules the next Twitch reconnect after a stream death that ISN'T a Kick handoff. holds the
// backoff ladder; after the budget is spent it makes one final failover attempt (covers a Kick
// stream that came online partway through the retries)
function scheduleTwitchReconnect(reason) {
  if (session.streamRecoveryAttempts >= 4) {
    // out of Twitch retries. last-ditch: maybe Kick came up during the retries (streamer restarted on Kick a beat after ending Twitch)
    tryKickFailover(session.intendedChannel).then((switched) => {
      if (!switched) setStatus("Stream connection lost - unable to recover automatically.");
    });
    return;
  }
  session.streamRecoveryAttempts++;
  session.lastStreamRecoveryAt = Date.now();
  const delaySecs = Math.min(2 * session.streamRecoveryAttempts, 10);
  setStatus(`Stream connection lost (${reason}) - reconnecting in ${delaySecs}s…`);
  const channelAtDeath = session.intendedChannel;
  setTimeout(() => {
    // re-validate: the user may have stopped or switched during the delay, so this recovery may belong to a session that no longer exists
    if (session.playing && session.intendedChannel === channelAtDeath && !session.intendedChannel.startsWith("vod:")) {
      console.warn(`[main] auto-restarting stream after relay death (attempt ${session.streamRecoveryAttempts})`);
      restartStreamWithQuality(session.currentQuality, { auto: true });
    }
  }, delaySecs * 1000);
}

// looksLikeStreamEnded is the single source of truth for "did the broadcast end?": streamlink's
// "No playable streams" or "closed without producing data", but NOT byte silence (ambiguous, goes to
// the retry ladder). the "ended" match is anchored so it doesn't also match "appended"
let _endedProbeInFlight = false;

// relay went quiet (5s) but isn't dead yet. ask Helix (authoritative, fast): no stream -> ended,
// fail over to Kick now; still live -> a blip, do nothing (onDead's 20s + retry ladder still run).
// only acts on a definite end, so a wrong guess never tears down a working stream
async function handleStreamSilent(secs) {
  if (_endedProbeInFlight) return;
  if (!session.playing || !session.intendedChannel) return;
  if (session.intendedChannel.startsWith("vod:")) return;
  if (session.kickFailover) return; // already on Kick

  const channelAtSilence = session.intendedChannel;
  _endedProbeInFlight = true;
  try {
    const raw = await invoke("get_stream_for_login", { login: channelAtSilence });
    const stream = JSON.parse(raw);
    // Helix returns no stream object for an offline channel
    if (stream) return; // still live -> a blip, not an end. let it ride

    // re-validate: the probe took real time, and the user may have stopped or switched channels in the meantime
    if (!session.playing || session.intendedChannel !== channelAtSilence) return;

    console.warn(
      `[main] relay silent ${secs}s and Helix reports ${channelAtSilence} offline - stream ended, failing over now`,
    );
    if (await tryKickFailover(channelAtSilence)) return;
    // no Kick simulcast: this IS the end, so say so rather than leaving a frozen frame until the 20s timeout fires
    setStatus(`${channelAtSilence} has ended the stream.`);
  } catch (err) {
    // probe failed (network, rate limit). not evidence of anything, fall through to the existing onDead/retry path
    console.warn("[main] stream-ended probe failed:", err);
  } finally {
    _endedProbeInFlight = false;
  }
}

function looksLikeStreamEnded(text) {
  return /No playable streams|closed its output without producing any data|offline|stream ended|\bended\b|404|not found/i.test(
    String(text || ""),
  );
}

function handleStreamDead(reason) {
  if (!session.playing || !session.intendedChannel || session.intendedChannel.startsWith("vod:")) return;
  const now = Date.now();
  if (now - session.lastStreamRecoveryAt > 120_000) session.streamRecoveryAttempts = 0;

  // before spending retries, check whether this is the Twitch stream ending with a Kick simulcast still live (the xQc case). only runs on a genuine-looking end, so a blip falls through to the retry ladder
  const looksEnded = looksLikeStreamEnded(reason);
  if (session.streamRecoveryAttempts === 0 && looksEnded) {
    const channelAtDeath = session.intendedChannel;
    tryKickFailover(channelAtDeath).then((switched) => {
      if (switched) return; // now session.playing Kick, done
      // not on Kick (or lookup failed): resume the normal Twitch reconnect, but only if this session is still live and nothing else advanced the retry state
      if (
        session.playing &&
        session.intendedChannel === channelAtDeath &&
        !session.intendedChannel.startsWith("vod:") &&
        session.streamRecoveryAttempts === 0
      ) {
        scheduleTwitchReconnect(reason);
      }
    });
    return;
  }

  scheduleTwitchReconnect(reason);
}

const playbackControls = new PlaybackControls({
  onQualityChange: (quality) => restartStreamWithQuality(quality),
  // the live relay source died (streamlink exited, network dropped, see attachMseStream's onDead).
  // nothing used to handle this, so the video froze indefinitely, half of why a blip made "stream and
  // chat just stop". chat reconnects on the Rust side; this is the video half
  onStreamDead: (reason) => handleStreamDead(reason),
  onStreamSilent: (secs) => handleStreamSilent(secs),
  onLowLatencyChange: (enabled) => {
    session.lowLatency = enabled;
    localStorage.setItem("lowLatency", enabled);
    if (session.playing && session.intendedChannel && !session.intendedChannel.startsWith("vod:")) {
      restartStreamWithQuality(session.currentQuality);
    }
  },
  onSeek: (newPositionSeconds) => chat.notifyVodSeek(newPositionSeconds),
  // fires when the user seeks past the MSE buffer start (further back than the ~2 min buffer), or clicks Live while in DVR mode (secondsBehindLive = 0 means "go live")
  onLiveDvrSeek: async (secondsBehindLive) => {
    if (!session.liveDvrInfo || !session.intendedChannel || session.intendedChannel.startsWith("vod:")) return;

    // same seek semantics as Twitch below, minus Twitch specifics: the recording URL is already
    // resolved, "go live" re-attaches the live playlist (not the MSE relay), and chat STAYS on live Kick
    // chat (no Kick chat-replay API to rewind)
    if (session.liveDvrInfo.kick) {
      // in a failover session intendedChannel is the TWITCH name, but the player/chat/DVR belong to the attached Kick slug. using the Twitch name would, with an alias set, restart under a different channel key and wipe per-channel state
      const kickSlug = session.kickFailover?.channel || session.intendedChannel;
      if (secondsBehindLive <= 0) {
        if (playbackControls._liveDvr) {
          playbackControls._liveDvr = null;
          const saved = session.liveDvrInfo;
          setStatus(`Returning to live…`);
          // startKick re-runs the per-session reset (wiping liveDvrStreamStartedAt, kickDvrAvailable), restore the pieces that still describe this continuing session
          playbackControls.startKick(kickSlug, saved.liveUrl);
          playbackControls.liveDvrStreamStartedAt = saved.streamStartedAt;
          playbackControls.kickDvrAvailable = true;
          session.liveDvrInfo = saved;
          setStatus(`Now playing ${kickSlug} on Kick`);
        }
        return;
      }
      const { vodUrl, streamStartedAt } = session.liveDvrInfo;
      const streamElapsedSecs = (Date.now() - streamStartedAt) / 1000;
      // same live-to-recording lag allowance as the Twitch path, Kick's IVS recordings trail the live edge by ~30-60s, and overshooting the end stalls hls.js
      const KICK_VOD_LIVE_DELAY_SECS = 45;
      const vodOffset = Math.max(0, streamElapsedSecs - secondsBehindLive - KICK_VOD_LIVE_DELAY_SECS);
      setStatus(`Loading DVR…`);
      playbackControls._liveDvr = { channel: kickSlug, videoId: null, streamStartedAt };
      playbackControls.attachHlsDvr(vodUrl, vodOffset);
      setStatus(`DVR: ${kickSlug} (Kick - chat stays live)`);
      return;
    }

    if (secondsBehindLive <= 0) {
      // "go live": tear down HLS.js, reconnect the MSE relay
      if (playbackControls._liveDvr) {
        playbackControls._liveDvr = null;
        const channel = session.intendedChannel;
        try {
          setStatus(`Returning to live…`);
          const relayUrl = await invoke("start_stream", { channel, quality: session.currentQuality, lowLatency: session.lowLatency });
          playbackControls.attachLiveMse(relayUrl);
          // switch chat back from VOD replay to live IRC
          await chat.connect(channel);
          setStatus(`Playing: ${channel}`);
        } catch (err) {
          console.error("Failed to return to live:", err);
          setStatus(`Error returning to live: ${err}`);
        }
      }
      return;
    }

    // seek further back than the buffer: switch to HLS.js on the live VOD
    const { videoId, streamStartedAt } = session.liveDvrInfo;
    const streamElapsedSecs = (Date.now() - streamStartedAt) / 1000;
    // add 45s for the VOD-to-live delay (the VOD trails the live edge by 30-60s), clamped to 0. without it the HLS.js position would be 45s ahead of the recording's content
    const VOD_LIVE_DELAY_SECS = 45;
    const vodOffset = Math.max(0, streamElapsedSecs - secondsBehindLive - VOD_LIVE_DELAY_SECS);

    try {
      const cached = session.liveDvrM3u8Cache;
      const cacheHit = cached && cached.videoId === videoId && cached.quality === session.currentQuality;
      // only the uncached path spawns a streamlink process and waits, so only it gets a distinct status; a cache hit goes straight to "DVR:"
      setStatus(cacheHit ? `Loading DVR…` : `Resolving DVR…`);
      const m3u8Url = cacheHit
        ? cached.url
        : await invoke("get_vod_m3u8_url", { videoId, quality: session.currentQuality });
      playbackControls._liveDvr = { channel: session.intendedChannel, videoId, streamStartedAt };
      playbackControls.attachHlsDvr(m3u8Url, vodOffset);
      resolvePipVodUrl(videoId, m3u8Url);
      // switch chat to VOD replay, using the channel login for badge loading. vodOffset tells replay where playback lands, see setVodMode's initialPositionSecs for why it matters on long streams
      await chat.setVodMode(videoId, () => playbackControls.lastKnownPosition, session.intendedChannel, vodOffset);
      setStatus(`DVR: ${session.intendedChannel}`);
    } catch (err) {
      console.error("Failed to enter live-DVR mode:", err);
      setStatus(`DVR error: ${err}`);
      playbackControls._liveDvr = null;
    }
  },
  // fires only for Kick sessions WITHOUT a resolved DVR recording (VODs disabled, or resolveKickDvr
  // couldn't find one), sessions WITH one route into onLiveDvrSeek. here the seek clamps at the
  // earliest buffered point; that clamp used to be silent, so clicking beyond the last ~1-2 min looked
  // like an arbitrary tiny rewind. surface it, throttled so a drag doesn't spam the status line
  onLiveDvrClamped: ({ landedSecondsBehindLive }) => {
    const now = Date.now();
    if (now - session.lastLiveDvrClampNoticeAt < 4000) return;
    session.lastLiveDvrClampNoticeAt = now;
    const behind = playbackControls.formatDuration(Math.round(landedSecondsBehindLive));
    setStatus(`No DVR recording available for this Kick channel - jumped to the earliest buffered point (-${behind})`);
  },
  lowLatency: session.lowLatency,
});
// Track ID button: identifies the music playing off the same <video> the controls drive
const trackId = new TrackId(playbackControls.videoEl, {
  // recorded with each identified song in Track ID's history: the channel (or the VOD's channel)
  getContext: () => {
    const ic = String(session.intendedChannel || "");
    if (ic.startsWith("vod:")) {
      return { channel: session.vodMeta?.channelName || session.vodMeta?.channelLogin || "", vod: true };
    }
    return { channel: ic.replace(/^kick:/, ""), vod: false };
  },
});
// Chat settings gear (in the composer, next to the emote button): a small popup menu that launches
// the chat-filter and pinned-messages flows, which used to be two separate toolbar buttons. The menu
// is a fixed-position flyout anchored to the gear, same pattern as the emote picker.
{
  const gearBtn = document.getElementById("chat-settings-btn");
  const menu = document.getElementById("chat-settings-menu");
  if (gearBtn && menu) {

    const positionMenu = () => {
      const r = gearBtn.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      // measure after making it visible so offsetHeight/Width are real
      const mh = menu.offsetHeight || 88;
      const mw = menu.offsetWidth || 200;
      // prefer above the gear; if the window's too short, drop below instead of off-screen
      let top = r.top - mh - 6;
      if (top < 6) top = r.bottom + 6;
      // right-align the menu to the gear, clamped to the viewport
      let left = r.right - mw;
      if (left < 6) left = 6;
      menu.style.top = top + "px";
      menu.style.left = left + "px";
    };

    const closeMenu = () => {
      menu.style.display = "none";
      gearBtn.classList.remove("open");
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", positionMenu);
    };
    const onDocDown = (e) => { if (!menu.contains(e.target) && e.target !== gearBtn && !gearBtn.contains(e.target)) closeMenu(); };
    const onKeyDown = (e) => { if (e.key === "Escape") closeMenu(); };

    const openMenu = () => {
      menu.style.visibility = "hidden";
      menu.style.display = "flex";
      positionMenu();
      menu.style.visibility = "";
      gearBtn.classList.add("open");
      document.addEventListener("mousedown", onDocDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("resize", positionMenu);
    };

    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.style.display === "none" || !menu.style.display) openMenu(); else closeMenu();
    });

    menu.querySelectorAll(".chat-settings-menu-item").forEach((item) => {
      // the tray toggle is a settings row, not a launcher — it manages its own checkbox and shouldn't
      // close the menu or dispatch an action
      if (item.classList.contains("chat-settings-menu-toggle")) return;
      item.addEventListener("click", () => {
        const action = item.dataset.action;
        closeMenu();
        // chat filter + hidden channels live in Settings > Chat > Filters now
        if (action === "settings") openSettingsPanel();
      });
    });
  }
}
document.getElementById("rewards-btn")?.addEventListener("click", () => {
  openRewardsModal(chat.channel, chat.roomId, () => {
    openPinAuthModal(() => { if (chat.roomId) chat._startPinPoll(chat.roomId); });
  });
});
// Mod action log (fills in only on channels you moderate; see mod-log.js + channel.moderate in eventsub.rs)
initModLog(chat);
document.getElementById("modlog-btn")?.addEventListener("click", () => openModLogModal());
initModMenu(chat);
initWhispers(chat);
startHypeBadgePolling();
if (getSetting("autoClaimDrops")) startDropsAutoClaim(); // Settings > App
// the shield (room controls) only makes sense where you can moderate
{
  const modmenuBtn = document.getElementById("modmenu-btn");
  const syncModMenu = (isMod) => { if (modmenuBtn) modmenuBtn.style.display = isMod ? "" : "none"; };
  syncModMenu(chat.isMod);
  chat.onModStatusChange(syncModMenu);
}

// Clip button: create a Twitch clip of the live stream and toast the editor link
const clipToast = document.getElementById("clip-toast");
let clipToastTimer = null;
function showClipToast(message, editUrl) {
  if (!clipToast) return;
  clipToast.replaceChildren();
  const msg = document.createElement("span");
  msg.textContent = message;
  clipToast.appendChild(msg);
  if (editUrl) {
    const btn = document.createElement("button");
    btn.className = "clip-toast-action";
    btn.textContent = "Open editor";
    btn.addEventListener("click", () => openUrl(editUrl).catch(() => {}));
    clipToast.appendChild(btn);
  }
  clipToast.style.display = "flex";
  clearTimeout(clipToastTimer);
  clipToastTimer = setTimeout(() => { clipToast.style.display = "none"; }, editUrl ? 12000 : 6000);
}
document.getElementById("clip-btn")?.addEventListener("click", async () => {
  if (!chat.roomId || chat._isKickChat) {
    showClipToast("Clips only work on live Twitch streams.");
    return;
  }
  showClipToast("Creating clip\u2026 (a few seconds)");
  try {
    const res = await invoke("create_clip", { broadcasterId: chat.roomId });
    const msg = res && res.ready ? "Clip created" : "Clip created — still rendering, give it a moment";
    showClipToast(msg, res && res.edit_url);
  } catch (err) {
    showClipToast(typeof err === "string" ? err : "Couldn't create clip.");
  }
});
// logging in WHILE a stream plays enables the input, but the IRC connection is still the anonymous
// one (Twitch IRC can't re-auth an existing connection, PASS only works at handshake), so sending
// fails with a clear error. stopping and restarting picks up the new credentials
const sidebar = new ChannelsSidebar({
  followedListEl: document.getElementById("followed-channels-list"),
  showMoreBtn: document.getElementById("followed-show-more-btn"),
  loginPromptEl: document.getElementById("followed-login-prompt"),
  topLiveListEl: document.getElementById("top-live-list"),
  onChannelSelect: (login, stream) => {
    channelInput.value = login;
    // Kick-sourced cards carry platform:"kick" (set by kick.rs); route those to the Kick watch path. checked on the STREAM, not just the current mode, so an already-rendered Kick card still routes right after a toggle flip
    if ((stream && stream.platform === "kick") || isKick()) {
      watchKickChannel(login);
    } else {
      watchChannel(login, stream);
    }
  },
});
sidebar.init();
// the channel info bar can start a stream, change page, and write the status line, app-shell concerns it can't import without a cycle, so they're handed to it here
checkStreamDeps();
// Windows-only in practice (the check no-ops on other platforms). fires once at startup; shows the update banner if a newer release exists
checkForUpdate();

// multi-stream grid overlay, seeded with the current channel. self-contained (multiview.js), uses the native-HLS path per tile, so it doesn't disturb the main relay player
const multiview = new MultiView();
// MultiView is a distinct mode: while open we fully STOP the main player, not pause it, pausing left the relay alive and could leak audio under the grid (double-audio). we remember what was playing and restart it on close
let _multiviewResume = null;
const multiviewHooks = {
  onOpen: () => {
    _multiviewResume =
      session.playing && session.intendedChannel ? session.intendedChannel : null;
    try { playbackControls.stop(); } catch {}
  },
  onClose: () => {
    // restart whatever was playing before, if anything
    if (_multiviewResume) {
      const ch = _multiviewResume;
      _multiviewResume = null;
      try { watchChannel(ch); } catch {}
    }
  },
};
document.getElementById("multiview-tab")?.addEventListener("click", () => {
  if (multiview.isOpen) { multiview.close(); return; }
  const seed = [];
  if (session.playing && session.intendedChannel) seed.push(session.intendedChannel);
  multiview.open(seed, multiviewHooks);
  if (currentLogin) {
    multiview.setLoggedIn(currentLogin.login, currentLogin.userId, currentLogin.displayName);
  }
});
// Home's MultiView launcher: open MultiView with exactly the streams, layout and audio picked there
function openMultiViewWith(channels, { layout = "grid", audio = null } = {}) {
  if (!channels || !channels.length) return;
  if (multiview.isOpen) multiview.close();
  multiview.setLayout(layout);
  multiview.open(channels, multiviewHooks);
  if (currentLogin) {
    multiview.setLoggedIn(currentLogin.login, currentLogin.userId, currentLogin.displayName);
  }
  // sound from the chosen stream (and, in Focus layout, it's the big one). tiles are registered as soon as
  // open() adds them, before their video loads, so this sticks
  if (audio) multiview.focus(String(audio).toLowerCase());
}

// navigating to Home/Browse closes the grid, so those tabs work even with the overlay up (it previously trapped the user, escapable only via the close button)
homeTab.addEventListener("click", () => { if (multiview.isOpen) multiview.close(); });
browseTab.addEventListener("click", () => { if (multiview.isOpen) multiview.close(); });

// auto-PiP on tab-out (opt-in via the settings toggle): when the window loses focus and something
// plays, pop into PiP; re-focusing closes it. uses Tauri's focus event (fires only for real OS focus
// changes, unlike 'blur'). guarded against typing / nothing playing
let _autoPipActive = false;
let _autoPipPendingTimer = null;

// true if the cursor is on a DIFFERENT monitor than the app window, tells "clicked something on my other screen" (don't PiP) from "alt-tabbed away here" (do PiP). fail-open: returns false if anything can't be resolved
async function cursorIsOnOtherMonitor() {
  try {
    const [cur, appMon, mons] = await Promise.all([
      cursorPosition(),
      currentMonitor(),
      availableMonitors().catch(() => []),
    ]);
    if (!cur || !appMon || !mons.length) return false;
    const inRect = (m) =>
      cur.x >= m.position.x && cur.x < m.position.x + m.size.width &&
      cur.y >= m.position.y && cur.y < m.position.y + m.size.height;
    const cursorMon = mons.find(inRect);
    if (!cursorMon) return false; // cursor off all screens: treat as same
    // compare by origin (monitors are uniquely placed on the virtual desktop)
    return cursorMon.position.x !== appMon.position.x ||
           cursorMon.position.y !== appMon.position.y;
  } catch {
    return false;
  }
}

appWindow.onFocusChanged(async ({ payload: focused }) => {
  if (localStorage.getItem("autoPipOnBlur") !== "1") return;

  if (!focused) {
    if (_autoPipActive) return;
    // don't fire when the focus loss was us opening a PiP window (creating a Tauri window steals focus), else a manual pop-out cascades into popping out every tile
    if (multiview.isOpeningPip || playbackControls._openingPip) return;
    // skip if the user just clicked onto another monitor (vs genuinely switching away from the app on this screen)
    if (await cursorIsOnOtherMonitor()) return;

    // debounce: a real tab-out keeps focus away, but a screenshot overlay, toast, or quick click steals it only briefly. wait, and only PiP if focus hasn't returned. the re-focus branch clears this timer
    if (_autoPipPendingTimer) clearTimeout(_autoPipPendingTimer);
    _autoPipPendingTimer = setTimeout(async () => {
      _autoPipPendingTimer = null;
      // re-check guards at fire time (state may have changed during the wait)
      if (_autoPipActive) return;
      if (multiview.isOpeningPip || playbackControls._openingPip) return;
      if (multiview.isOpen) {
        if (multiview.focusedChannel) {
          await multiview.popOutToNativePip(multiview.focusedChannel);
          _autoPipActive = true;
        }
      } else if (session.playing) {
        try { await playbackControls.enterNativePip(); _autoPipActive = true; } catch {}
      }
    }, 600);
  } else {
    // focus came back. cancel a pending PiP (the blip was brief), and close any auto-PiP we did open
    if (_autoPipPendingTimer) { clearTimeout(_autoPipPendingTimer); _autoPipPendingTimer = null; }
    if (_autoPipActive) {
      _autoPipActive = false;
      if (!multiview.isOpen) { try { playbackControls.closePipAnyTier?.(); } catch {} }
    }
  }
});

// show the app version in the window title so the live build is visible at a glance (handy for verifying an update applied). getVersion() reads the version from tauri.conf.json
getVersion()
  .then((v) => appWindow.setTitle(`Mosaic v${v}`))
  .catch(() => {}); // non-fatal: title just stays the static default
setInterval(maybeSaveVodProgress, 15_000);

const homeFeed = new HomeFeed({
  containerEl: document.getElementById("home-feed"),
  onChannelSelect: (login, stream) => {
    channelInput.value = login;
    // Kick-sourced cards carry platform:"kick"; route those to the Kick watch path. checked on the STREAM so an already-rendered Kick card routes right after a toggle flip
    if ((stream && stream.platform === "kick") || isKick()) {
      watchKickChannel(login);
    } else {
      watchChannel(login, stream);
    }
  },
  // MultiView launcher (top of Home): live favorites come from the sidebar, which already tracks follows,
  // favorites and live status. wrapped in try: the sidebar is created after Home
  getLiveFavorites: () => { try { return sidebar.getLiveFavorites(); } catch { return []; } },
  getLiveLogins: () => { try { return sidebar.getLiveLogins(); } catch { return new Set(); } },
  onOpenMultiView: (channels, opts) => openMultiViewWith(channels, opts),
  // "Continue where you left off": jump straight to the saved position (an explicit start offset, so
  // it wins over the resume-prompt logic) and keep recording its metadata
  onVodResume: (item) =>
    openVod(item.videoId, item.totalSecs, item.channelLogin, Math.floor(item.positionSecs), {
      title: item.title, channelName: item.channelName, channelLogin: item.channelLogin, thumbnailUrl: item.thumbnailUrl,
      createdAt: item.createdAt,
    }),
});

const browsePage = new BrowsePage({
  containerEl: document.getElementById("browse-page"),
  onChannelSelect: (login, stream) => {
    channelInput.value = login;
    // Kick-sourced cards carry platform:"kick"; route those to the Kick watch path. checked on the STREAM so an already-rendered Kick card routes right after a toggle flip
    if ((stream && stream.platform === "kick") || isKick()) {
      watchKickChannel(login);
    } else {
      watchChannel(login, stream);
    }
  },
});

// homeFeed and browsePage both toggle the same #video-frame visibility (only one of video/home/browse shows at a time), so browsePage.hide() must run BEFORE homeFeed.show(), else its "hide the video frame" would stomp the one that should stick
// Opens a VOD (Twitch or Kick), remembering its display metadata so progress saves can record it for
// Home's "Continue where you left off" row. Shared by the VODs page and that Home row.
function openVod(videoId, totalSeconds, broadcastLogin, startOffsetSeconds, meta) {
  session.vodMeta = meta ? { videoId: String(videoId), ...meta } : null;
  // Kick cards carry "kick:<uuid>" ids (kick_channel_videos in kick.rs), route those to the Kick VOD path; everything else is a Twitch archive id
  if (String(videoId).startsWith("kick:")) {
    watchKickVod(videoId, totalSeconds, startOffsetSeconds);
  } else {
    watchVod(videoId, totalSeconds, broadcastLogin, startOffsetSeconds);
  }
}

const vodsPage = new VodsPage({
  containerEl: document.getElementById("vods-page"),
  videoFrameEl: document.getElementById("video-frame"),
  onVodSelect: (videoId, totalSeconds, broadcastLogin, startOffsetSeconds, meta) =>
    openVod(videoId, totalSeconds, broadcastLogin, startOffsetSeconds, meta),
});

browsePage.hide();
// hand the extracted modules the collaborators they can't import without a cycle. must run AFTER the page objects above exist (const TDZ) and before any click handler fires
initLayout({
  homeFeed,
  browsePage,
  vodsPage,
  getCurrentChannel: () => playbackControls.currentChannel,
  miniPlayerOn: () => { if (getSetting("miniPlayer")) activateMiniPlayer(); }, // Settings > Player > Mini player
  miniPlayerOff: () => deactivateMiniPlayer(),
});
// ---- recently watched channels (command palette "Recent") ----
function rememberRecentChannel(login, stream) {
  try {
    const l = String(login).toLowerCase();
    const list = JSON.parse(localStorage.getItem("recentChannels") || "[]").filter((r) => r.login !== l);
    list.unshift({ login: l, name: (stream && (stream.user_name || stream.display_name)) || login, at: Date.now() });
    localStorage.setItem("recentChannels", JSON.stringify(list.slice(0, 8)));
  } catch { /* ignore */ }
}

// ---- Command palette (Ctrl+K, command-palette.js) ----
function paletteWatch(login) {
  channelInput.value = login;
  if (isKick()) watchKickChannel(login); else watchChannel(login);
}
// actions offered depend on what's playing: stream actions only while something is on
function paletteActions() {
  const out = [];
  const add = (title, sub, run, extra = {}) => out.push({ title, sub, run, ...extra });
  const playing = !!session.playing;
  const cur = String(playbackControls.currentChannel || "");
  const isVod = cur.startsWith("vod:");
  const channel = isVod ? "" : cur;
  const kick = !!playbackControls._isKickSession;
  if (playing) {
    add("Toggle theater mode", "Current stream", () => toggleTheaterModeAndResync(), { keys: ["T"], suggested: true });
    add("Fullscreen", "Current stream", () => toggleFullscreen(), { keys: ["F"] });
    add("Mute / unmute", "Current stream", () => playbackControls.toggleMute(), { keys: ["M"] });
    add("Pop out player", "Current stream", () => playbackControls.togglePip());
    if (!kick) {
      if (playbackControls.currentQuality === "audio_only") add("Back to video (Auto)", "Quality", () => playbackControls.selectQuality("auto"), { suggested: true });
      else add("Switch to Audio only", "Quality", () => playbackControls.selectQuality("audio_only"), { suggested: true });
      for (const q of playbackControls.cachedQualities || []) {
        if (q !== "audio_only") add(`Set quality: ${q === "best" ? "Source" : q}`, "Quality", () => playbackControls.selectQuality(q));
      }
      add("Set quality: Auto", "Quality", () => playbackControls.selectQuality("auto"));
    }
    if (playbackControls.isVod) {
      for (const sp of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
        add(sp === 1 ? "Playback speed: Normal" : `Playback speed: ${sp}×`, "VOD", () => playbackControls.setVodSpeed(sp), { keys: sp === 1 ? [] : undefined });
      }
    }
    add("Identify song (Track ID)", "Current stream", () => trackId.identify());
    const f = currentChannelFollowState();
    if (f) add(`${f.followed ? "Unfollow" : "Follow"} ${f.channel}`, "Current channel", () => toggleCurrentFollow(), { suggested: !f.followed });
    if (channel && !kick) {
      add(`Add ${channel} to MultiView`, "MultiView", () => {
        if (multiview.isOpen) multiview.addChannel(channel); else openMultiViewWith([channel], { audio: channel });
      }, { suggested: true });
      add("Copy stream link", "Current stream", () => {
        navigator.clipboard.writeText(`https://twitch.tv/${channel}`).then(() => setStatus("Stream link copied")).catch(() => {});
      });
      add(`Past broadcasts of ${channel}`, "Navigation", () => document.getElementById("channel-info-videos-btn")?.click(), { nav: true });
    }
    if (session.pageVisible) add("Back to stream", "Navigation", () => backToStreamBtn.click(), { nav: true, suggested: true });
    add("Stop watching", "Current stream", () => stopPlayback({ returnToPage: true, goHome: true }));
  }
  add("Go to Home", "Navigation", () => document.getElementById("home-tab")?.click(), { nav: true, suggested: !playing });
  add("Go to Browse", "Navigation", () => document.getElementById("browse-tab")?.click(), { nav: true, suggested: !playing });
  add("Open MultiView", "Navigation", () => document.getElementById("multiview-tab")?.click(), { nav: true });
  add("Open whispers", "Navigation", () => openWhispers(), { nav: true });
  add("Open settings", "Navigation", () => openSettingsPanel(), { nav: true, keys: ["Ctrl", ","], suggested: !playing });
  add("Check for updates", "App", () => checkForUpdatesNow().then((m) => setStatus(m)).catch(() => {}));
  return out;
}
initCommandPalette({
  getFollowed: () => (sidebar.followed || []).map((c) => ({
    login: String(c.login || "").toLowerCase(), name: c.name || c.login, live: !!c.live, viewers: c.viewers,
    game: c.game || "", avatar: c.avatar || "", favorite: !!sidebar._isFavorite?.(c.login),
  })),
  getRecent: () => { try { return JSON.parse(localStorage.getItem("recentChannels") || "[]"); } catch { return []; } },
  watch: paletteWatch,
  searchCategories: async (q) => JSON.parse(await feedInvoke("search_categories", { query: q })),
  openCategory: (game) => { document.getElementById("browse-tab")?.click(); browsePage.openGame(game); },
  getContinue: () => homeFeed.continueItems || [],
  resumeVod: (item) => homeFeed.onVodResume(item),
  getActions: paletteActions,
  getSettingsIndex: () => getSettingsIndex(),
  openSetting: (section, title) => openSettingsPanel(section, title),
});

// ---- Settings (settings.js / settings-panel.js) ----
applyAppearance(); // chat font size, emote size, timestamps
// settings that apply live the moment they change (the rest are read where they act)
onSettingChange((id, v) => {
  switch (id) {
    case "lowLatency":
      session.lowLatency = !!v;
      playbackControls.lowLatency = !!v;
      break;
    case "closeToTray":
      invoke("set_close_to_tray", { enabled: !!v }).catch(() => {});
      break;
    case "autoClaimDrops":
      if (v) startDropsAutoClaim(); else stopDropsAutoClaim();
      break;
    case "pinnedBanner":
      chat._renderPin?.(chat._lastPins || []);
      break;
    case "predictionsPolls":
      chat._leRender?.("pred");
      chat._leRender?.("poll");
      break;
    case "hypeGiftBanners":
      if (v) { if (chat._hype) chat._renderHype?.(false); }
      else {
        for (const bid of ["hype-train-banner", "gift-sub-banner"]) {
          const el = document.getElementById(bid);
          if (el) el.style.display = "none";
        }
      }
      break;
    case "homeLauncher":
      homeFeed._refreshLauncher?.();
      break;
    case "homeContinueRow":
    case "homeRecommendedRow":
      if (homeFeed.loaded) homeFeed.render();
      break;
    case "liveChannelsCount":
      sidebar.refreshTopLive?.();
      break;
    case "showOfflineFollowed":
    case "followedSort":
      sidebar.renderFollowed?.();
      break;
    case "autostart":
      invoke(v ? "plugin:autostart|enable" : "plugin:autostart|disable").catch((err) => {
        console.warn("[settings] autostart:", err);
        setStatus("Couldn't change the startup setting");
      });
      break;
    case "uiZoom":
      applyZoom();
      break;
  }
});

// Settings > App > Interface zoom (the webview's own zoom, like a browser's)
function applyZoom() {
  const z = Number(getSetting("uiZoom")) || 1;
  getCurrentWebview().setZoom(z).catch((err) => console.warn("[settings] zoom:", err));
}
applyZoom();

// Settings > App > Start with your computer: show the OS's real state (it can be changed outside Mosaic),
// and on a startup launch with "start minimized" on, go straight to the tray
(async () => {
  try {
    const enabled = await invoke("plugin:autostart|is_enabled");
    if (!!enabled !== !!getSetting("autostart")) setSetting("autostart", !!enabled);
  } catch { /* plugin unavailable: leave the setting as is */ }
  try {
    if (getSetting("startMinimized") && await invoke("launched_at_startup")) await getCurrentWindow().hide();
  } catch (err) { console.warn("[settings] start minimized:", err); }
})();
// the panel links to the editors that already exist rather than duplicating them
configureSettingsPanel({
  exportBackup, importBackup, checkForUpdatesNow,
  openChatFilter: () => openChatFilterModal(() => chat.reloadChatFilter()),
  openHiddenChannels: () => openHiddenChannelsModal(),
  openTwitchConnection: () => openPinAuthModal(() => { if (chat.roomId) chat._startPinPoll(chat.roomId); }),
});
document.getElementById("settings-open-btn")?.addEventListener("click", () => openSettingsPanel());
document.getElementById("user-menu-settings")?.addEventListener("click", () => {
  document.getElementById("user-menu")?.classList.remove("open");
  openSettingsPanel();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); openSettingsPanel(); }
});

initChannelInfoBar({
  watchChannel, switchPage, setStatus,
  // in-app Twitch follow (channel info bar): state from the sidebar's followed list; after a change,
  // refresh the sidebar so the channel appears in / leaves Followed (short delay: Twitch's follow list
  // takes a moment to catch up)
  isTwitchFollowed: (login) => {
    const l = String(login || "").toLowerCase();
    return (sidebar.followed || []).some((ch) => String(ch.login || "").toLowerCase() === l);
  },
  onTwitchFollowChanged: () => setTimeout(() => sidebar.refreshFollowed().catch?.(() => {}), 2500),
});

vodsPage.hide();
// reopen whatever was playing, but ONLY across an F5/reload, never a genuine launch.
// take_is_fresh_launch is true once per process, so a reload resumes while a cold start lands on
// Home. show Home first so boot never blocks on the backend; a reload swaps the stream in after
homeFeed.show();
(async () => {
  try {
    const freshLaunch = await invoke("take_is_fresh_launch");
    if (freshLaunch) return; // cold start: stay on Home
    // reload: replay the remembered session. it hides Home itself on success; if there's nothing to restore, Home just stays put
    restoreSession({ watchChannel, watchKickChannel, watchVod, watchKickVod });
  } catch (err) {
    console.warn("[main] fresh-launch check failed, staying on Home:", err);
  }
})();

// tracks whichever of {home, browse} was last shown, so the error and Stop paths restore the right one instead of always jumping to home. starts "home" to match the homeFeed.show() above

// whether Home/Browse is on screen now vs the video. watchChannel() hides both pages directly (not
// via switchPage) when playback starts, and the video keeps playing in the background while browsing.
// session.lastActivePage alone can't say which page is visible (it stays "home" while watching),
// which is why a second click on the already-"active" tab used to no-op

homeTab.addEventListener("click", () => switchPage("home"));
browseTab.addEventListener("click", () => switchPage("browse"));

function returnToFullStream() {
  if (!session.playing) return;
  // leaving the mini-player: restore the frame to full view. deactivate first so its floating
  // inline styles are cleared before the pages' hide() restores normal visibility.
  deactivateMiniPlayer();
  resetMiniPlayerDismissal(); // available again next time they navigate away
  // homeFeed.hide()/browsePage.hide() each restore #video-frame visibility as a side effect, so no need to touch it here. both are no-ops if that page wasn't showing
  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  // restore theater mode (switchPage turned it off on the way out) now the video is back and the sidebar collapse is worth it again
  if (getSetting("autoTheater")) setTheaterMode(true); // Settings > Player > Auto theater mode
  updateBackToStreamBtn();
  resyncChannelInfoBarVisibility();
}
backToStreamBtn.addEventListener("click", returnToFullStream);
initMiniPlayer({ expandToStream: returnToFullStream });

// latest Twitch login info (set on login), so views created lazily, like the MultiView chat, can be marked logged-in when they open
let currentLogin = null;
const auth = new TwitchAuth({
  loginBtn,
  userMenuEl:      document.getElementById("user-menu"),
  userMenuSignout: document.getElementById("user-menu-signout"),
  statusCallback: (login, userId, displayName) => {
    chat.setLoggedIn(login, userId, displayName);
    // remember the login so the MultiView chat (created lazily / may not exist yet at first login) can be marked logged-in when it opens
    currentLogin = { login, userId, displayName };
    if (multiview?.isOpen) multiview.setLoggedIn(login, userId, displayName);
    sidebar.onLogin();
    // homeFeed.show() at startup races ahead of login, so on a fresh launch the first fetch 401s and falls back to empty, and never retried. refresh() re-runs it now a valid token exists
    homeFeed.refresh();
    // Start the persistent account-level EventSub connection so whispers arrive app-wide, not only
    // while watching a stream. Fires on both fresh login and session restore (both hit this callback).
    invoke("start_account_eventsub").catch((err) => console.warn("[main] account eventsub start failed:", err));
  },
});

function setStatus(text) {
  // two non-statuses get no pill: "Idle" (not worth narrating) and "Playing: x" (redundant next to
  // the input reading "x" and a Stop button). Playing lights a small live dot in the launcher instead,
  // so the pill is reserved for real info: resolving, reconnecting, DVR, errors
  const isPlayingStatus = /^Playing: /.test(text);
  // Startup and failure messages are intentionally kept out of the titlebar pill.
  // The player/placeholder and console still provide the relevant feedback without
  // shifting the titlebar controls.
  const isTransientStreamStatus = /^(Starting stream for |Resolving |Couldn't play |Error(?::| switching)|Stream connection lost|Failed to start:)/.test(text);
  // a bare channel indicator ("#xqc", "#xqc (Kick)") is redundant next to the search field, chat
  // header, and channel info bar, so it gets no pill either
  const isChannelPill = /^#/.test(text);
  statusText.textContent = (text === "Idle" || isPlayingStatus || isChannelPill || isTransientStreamStatus) ? "" : text;
  document.querySelector(".channel-launcher")?.classList.toggle("playing", isPlayingStatus);
}

theaterBtn.addEventListener("click", toggleTheaterModeAndResync);

chatCollapseToggle.addEventListener("click", toggleChatCollapse);
chatExpandStrip.addEventListener("click", toggleChatCollapse);

fullscreenBtn.addEventListener("click", toggleFullscreen);

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    // both checked independently (not else-if), theater mode and fullscreen are unrelated states that can be active together, so one Escape exits both at once (like every video app)
    if (appEl.classList.contains("theater-mode")) {
      setTheaterMode(false);
    }
    if (isAppFullscreen()) {
      toggleFullscreen();
    }
    return;
  }

  // "T" toggles theater mode (the official shortcut), only when focus isn't in a text field so typing "t" doesn't trigger it
  if (e.key.toLowerCase() === "t") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    toggleTheaterModeAndResync();
    return;
  }

  // "F" toggles fullscreen, matching the official site's shortcut, same text-field guard as "T"
  if (e.key.toLowerCase() === "f") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    toggleFullscreen();
    return;
  }

  // "M" toggles mute (the official shortcut), same text-field guard as "T", reusing toggleMute(). no is-anything-playing check needed, toggleMute() is a harmless no-op against an empty <video>
  // < / > : VOD playback speed down / up (Shift+, / Shift+.), like YouTube
  if ((e.key === "<" || e.key === ">") && playbackControls.isVod) {
    e.preventDefault();
    playbackControls.stepVodSpeed(e.key === ">" ? 1 : -1);
    return;
  }
  if (e.key.toLowerCase() === "m") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    playbackControls.toggleMute();
  }

  // Space toggles pause/play (the official shortcut), blocked in text fields so a space in chat doesn't pause the stream
  if (e.key === " ") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault(); // stop the page from scrolling on space
    playbackControls.togglePause();
  }

  // ArrowLeft/Right seek 5s (10s with Shift), the official shortcut, with the same text-field guard (chat.js's own ArrowUp/Down history is scoped to the textarea, so no conflict). skipped entirely when nothing plays so we don't preventDefault() the arrow's normal behavior on pages with no video
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (!session.playing) return;
    e.preventDefault();
    const base = Number(getSetting("seekStep")) || 5; // Settings > Player > Seek step (Shift doubles it)
    const step = e.shiftKey ? base * 2 : base;
    playbackControls.seekRelative(e.key === "ArrowLeft" ? -step : step);
  }
});

// clears a stray focused text input (chat, channel field) when the window loses focus (alt-tab, another app, entering PiP). without it, a chat input could stay "focused" but no longer receive keystrokes, silently swallowing the next keypress
window.addEventListener("blur", () => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    document.activeElement.blur();
  }
});

// (Removed: the old CONTROLS_BAR_HEIGHT constant and syncVideoRegion() that pushed
// #video-region's pixel rect to Rust to move mpv's native window. The controls bar is a CSS overlay
// now and #video-element is a normal DOM element, so there's no second native surface to sync.)

// Kick live-DVR resolution, called by attachKickStream per Kick session. asks Rust
// (get_kick_live_dvr) for the in-progress recording; on success, arms the same
// session.liveDvrInfo/onLiveDvrSeek machinery Twitch uses (kick-shaped) and flips kickDvrAvailable so
// past-buffer seeks route into the swap. fails soft in every case (the session keeps the clamp-with-notice)
async function resolveKickDvr(channel, info) {
  let dvr = null;
  try {
    dvr = await invoke("get_kick_live_dvr", {
      slug: channel,
      livestreamId: info.livestream_id ?? null,
    });
  } catch (err) {
    console.log(`[kick-dvr] lookup failed (seeks will clamp to buffer): ${err}`);
    return;
  }
  if (!dvr || !dvr.proxied_vod_url) {
    console.log(`[kick-dvr] no in-progress recording for ${channel} (VODs disabled, or not listed yet)`);
    return;
  }
  // stale guard: the user may have stopped or switched during the two Kick lookups. session.intendedChannel is the TWITCH name in failover/offline-entry sessions, which may differ from the Kick slug via an alias, accept either the direct or aliased match
  if (
    !session.playing ||
    !session.kickFailover ||
    session.kickFailover.channel !== channel ||
    (session.intendedChannel !== channel && kickSlugFor(session.intendedChannel) !== channel)
  ) {
    return;
  }
  // the seek-position -> recording-offset math needs the broadcast's start wall clock; without one there's no way to know where a click lands in the recording
  const startedAtMs = info.started_at ? new Date(info.started_at).getTime() : NaN;
  if (Number.isNaN(startedAtMs)) {
    console.log("[kick-dvr] recording found but no stream start time - can't map seeks, keeping clamp behavior");
    return;
  }
  session.liveDvrInfo = {
    kick: true,
    vodUrl: dvr.proxied_vod_url, // already proxied, no resolve step at seek time
    liveUrl: info.proxied_url,   // for the "go live" return trip
    streamStartedAt: startedAtMs,
  };
  playbackControls.kickDvrAvailable = true;
  console.log(`[kick-dvr] DVR armed for ${channel}`);
}

// shared tail of both Kick entry points (tryKickFailover for a mid-session end, watchChannel's
// offline branch for entering a Twitch-offline channel): flips into Kick mode, attaches the feed, and
// swaps chat. callers have already decided to switch and arranged session/UI state; this does the common parts so both land identically
async function attachKickStream(channel, info, statusText) {
  session.kickFailover = { channel };
  // we're on Kick now, so a reload should resume Kick, not retry the ended Twitch channel. `channel` is the Kick slug the failover resolved to
  rememberSession({ kind: "kickLive", id: channel });
  // flip the whole app into Kick mode so the chrome matches (header, accent, feeds), the manual-toggle treatment. without it, a failover left a Kick stream under a Twitch header. setPlatform no-ops if already Kick
  setPlatform("kick");

  // Drops are Twitch-only, so the banner must never survive a hop to Kick. watchKickChannel() hides it on the way in, but the FAILOVER path starts from a live Twitch session where it may show, this shared tail covers both. no-op if already hidden
  hideDropsBanner();
  // clear any Twitch session's VOD-swap state, a backward seek on Kick must never switch onto the stale Twitch VOD. resolveKickDvr below repopulates liveDvrInfo with Kick-shaped state
  session.liveDvrInfo = null;
  session.liveDvrM3u8Cache = null;
  playbackControls.startKick(channel, info.proxied_url);
  // find this broadcast's in-progress recording in the background (needs two lookups, so never block playback). until it resolves, past-buffer seeks keep the clamp+notice
  resolveKickDvr(channel, info);
  // liveDvrStreamStartedAt is a SEPARATE, display-only mechanism (expands the seek bar to the full
  // broadcast + a "-X:XX" behind-live readout) that Kick can use too, unlike the VOD-swap state above:
  // Kick's stream-start wall clock is in `info` when kick.rs found one
  if (info.started_at) {
    const startedAtMs = new Date(info.started_at).getTime();
    if (!Number.isNaN(startedAtMs)) {
      playbackControls.liveDvrStreamStartedAt = startedAtMs;
    }
  }
  // swap chat too via chat.connectKick(): it disconnects Twitch chat, RE-REGISTERS the listeners
  // disconnect() tears down (the old code skipped that, so Kick events arrived with nobody listening and
  // the pane stayed empty), hides the input row, and starts the Pusher client. no chatroom_id -> keep Twitch chat rather than tearing it down for nothing
  if (info.chatroom_id) {
    await chat
      .connectKick(channel, info.chatroom_id, info.broadcaster_user_id, info.subscriber_badges)
      .catch((err) => console.warn("[kick] failed to start Kick chat:", err));
  }
  updateKickChannelInfoBar(channel, info);
  setStatus(statusText);
  console.warn(
    `[kick] playing Kick stream for ${channel}` +
    (info.viewer_count ? ` (${info.viewer_count.toLocaleString()} viewers)` : ""),
  );
}

// when a Twitch stream ends mid-watch, check if the same slug is live on Kick and swap onto Kick's HLS feed (via the hls.js DVR path). chat stays on Twitch. assumes Kick slug == Twitch login. returns true if now on Kick; a lookup error is "couldn't check"
async function tryKickFailover(channelAtDeath) {
  if (
    !session.playing ||
    !channelAtDeath ||
    session.intendedChannel !== channelAtDeath ||
    channelAtDeath.startsWith("vod:")
  ) {
    return false;
  }
  if (session.kickFailover) return true; // already on Kick for this session

  // the Kick identity may differ from Twitch's (zackrawrr -> asmongold), kick-aliases.js holds the user-set pairings; unset means same-name
  const kickSlug = kickSlugFor(channelAtDeath);
  if (kickSlug !== channelAtDeath) {
    console.log(`[kick] failover alias: ${channelAtDeath} (Twitch) -> ${kickSlug} (Kick)`);
  }

  let info = null;
  try {
    info = await invoke("get_kick_stream", { slug: kickSlug });
  } catch (err) {
    console.warn("[kick] live-status check failed (treating as no-failover):", err);
    return false;
  }
  if (!info) return false; // offline on Kick, or no such Kick channel

  // re-validate after the await: the user may have stopped or switched during the Kick lookup, so this failover may belong to a dead session
  if (!session.playing || session.intendedChannel !== channelAtDeath) return false;

  await attachKickStream(
    kickSlug,
    info,
    `Twitch stream ended - now playing ${kickSlug} on Kick`,
  );
  return true;
}

// VODs save position and resume at the same second; live streams rejoin near the live edge
// After a live quality switch: once the new stream actually plays, show how long it took in the status
// line ("Audio only · switched in 2.3s") and log the split between stream startup (relay: streamlink +
// remux + first chunk) and buffering (player: first second of media). Real numbers from the user's
// machine, so slow switches can be diagnosed instead of guessed at.
function reportQualitySwitchTiming(quality, startedAt, relayReadyAt) {
  const v = playbackControls.videoEl;
  const onPlaying = () => {
    const total = (performance.now() - startedAt) / 1000;
    const relay = (relayReadyAt - startedAt) / 1000;
    const label = quality === "audio_only" ? "Audio only" : quality === "best" ? "Best quality" : quality;
    setStatus(`${label} · switched in ${total.toFixed(1)}s`);
    console.log(`[quality-switch] ${quality}: ${total.toFixed(2)}s total ` +
      `(stream startup ${relay.toFixed(2)}s, buffering ${(total - relay).toFixed(2)}s)`);
  };
  v.addEventListener("playing", onPlaying, { once: true });
}

async function restartStreamWithQuality(quality, { auto = false } = {}) {
  if (!session.playing || !session.intendedChannel) return;
  session.currentQuality = quality;

  if (session.intendedChannel.startsWith("vod:")) {
    const videoId = session.intendedChannel.slice("vod:".length);
    const savedPosition = Math.floor(playbackControls.videoEl.currentTime);
    const vodTotalSeconds = playbackControls.vodTotalSeconds;
    try {
      const m3u8Url = await invoke("get_vod_m3u8_url", { videoId, quality });
      // the user may have switched away while the URL resolved; don't reattach a VOD they've navigated off of
      if (session.intendedChannel !== `vod:${videoId}`) return;
      // reattach HLS.js at the saved position, no progress lost
      playbackControls.attachStream(m3u8Url, savedPosition);
    } catch (err) {
      console.error("Failed to switch VOD quality:", err);
      setStatus(`Error switching quality: ${err}`);
    }
  } else if (session.useNativeHlsForLive) {
    // macOS native-HLS live: switch quality by resolving a fresh ad-free m3u8 and reattaching via hls.js, the live counterpart of the VOD switch above. no start_stream (that's the MSE path)
    const restartChannel = session.intendedChannel;
    try {
      const m3u8Url = await invoke("get_live_m3u8_url", { channel: restartChannel, quality });
      if (session.intendedChannel !== restartChannel) return;
      playbackControls.start(restartChannel, m3u8Url, quality, 0, 0, { nativeHlsLive: true });
      if (session.kickFailover) {
        invoke("stop_kick_chat").catch(() => {});
        session.kickFailover = null;
        await chat.connect(restartChannel).catch(() => {});
      }
    } catch (err) {
      if (String(err).includes("superseded")) return;
      console.error("Failed to switch live quality (native HLS):", err);
      setStatus(`Error switching quality: ${err}`);
    }
  } else {
    try {
      // expectRelayTeardown, because the quality restart kills streamlink and EOFs the body the current
      // attachment still reads, and that attachment isn't replaced until start() an await later.
      // unannounced, the EOF would surface as a death -> tryKickFailover, yanking the viewer to Kick on a quality change
      playbackControls.expectRelayTeardown();
      // capture the channel this restart is FOR: start_stream takes a second or two, and a switch mid-flight moves session.intendedChannel, so attaching with the live value would play the new channel through this one's relay URL. bind once, re-check after the await
      const restartChannel = session.intendedChannel;
      const switchStartedAt = performance.now();
      const relayUrl = await invoke("start_stream", { channel: restartChannel, quality, lowLatency: session.lowLatency });
      if (session.intendedChannel !== restartChannel) return; // superseded mid-restart
      playbackControls.lowLatency = session.lowLatency;
      playbackControls.start(restartChannel, relayUrl, quality);
      reportQualitySwitchTiming(quality, switchStartedAt, performance.now());
      // a successful Twitch start means we're on (or back on) Twitch, if this session had failed over to Kick, stop the Kick chat client and rejoin Twitch chat
      if (session.kickFailover) {
        invoke("stop_kick_chat").catch(() => {});
        chat.connect(restartChannel)
          .catch((err) => console.warn("[kick] failed to rejoin Twitch chat:", err));
        // back on a live Twitch stream, return the chrome to Twitch (undoes attachKickStream's setPlatform("kick"))
        setPlatform("twitch");
      }
      session.kickFailover = null;
      // quality changed: the cached DVR m3u8 is for the old quality, invalidate and re-resolve in the background so DVR seeking stays fast
      session.liveDvrM3u8Cache = null;
      prefetchLiveDvrM3u8();
    } catch (err) {
      // superseded by a newer start (start_relay's ticket guard), expected during rapid switching, not a failure. the newer session owns playback now
      if (String(err).includes("superseded")) return;
      console.error("Failed to restart stream at new quality:", err);
      // "No playable streams" is streamlink's offline message, the Twitch stream ENDED, not blipped, so check for a Kick simulcast. keyed on the offline error specifically: during a simulcast Kick is live too, so failing over on any error would yank a working stream
      const endedOnTwitch = looksLikeStreamEnded(err);
      if (endedOnTwitch) {
        if (session.kickFailover) {
          // already playing the Kick feed and Twitch is still offline (a quality change goes through Twitch). nothing was torn down, start_stream threw before any reattach, so Kick continues; just don't leave a scary error in the status bar
          setStatus(
            `Twitch still offline - continuing ${session.kickFailover.channel} on Kick ` +
            `(quality is automatic on the Kick feed)`,
          );
          return;
        }
        if (await tryKickFailover(session.intendedChannel)) return;
      }
      // an AUTO restart (the retry ladder) that fails must hand back to the ladder, or recovery dies here: nothing else re-arms it, so no attempt 2 and the attempt-4 failover is never reached. a USER quality change just reports the error
      if (
        auto &&
        session.playing &&
        session.intendedChannel &&
        !session.intendedChannel.startsWith("vod:")
      ) {
        scheduleTwitchReconnect(String(err));
        return;
      }
      setStatus(`Error switching quality: ${err}`);
    }
  }
}

// shared by the Watch button and sidebar/home/browse card clicks so all paths run the same logic. stream is the Helix stream object if the caller had one (cards do), null for a known-offline entry, undefined for the Watch button (which looks one up via get_stream_for_login)

// a VOD within this many seconds of its end is "finished", not "paused partway", matches Netflix/YouTube not offering to resume something basically watched
const VOD_RESUME_END_THRESHOLD_SECS = 30;

// saves the current VOD's position (no-op for live). called wherever playback is about to tear down (channel/VOD switch, Stop) and every 15s while watching, so a crash loses at most a few seconds
// VOD chat heatmap: one load at a time; a new VOD (or stopping) cancels the previous load so a slow
// one can't paint onto the wrong video. If the VOD's length isn't known yet (e.g. resumed via session
// restore), wait for the player to report it.
let _heatmapHandle = null;
function startChatHeatmap(videoId, totalSeconds) {
  _heatmapHandle?.cancel();
  _heatmapHandle = null;
  const begin = (total) => {
    if (session.intendedChannel !== `vod:${videoId}`) return; // moved on before the duration arrived
    _heatmapHandle = startVodHeatmap(videoId, total, (data) =>
      playbackControls.renderChatHeatmap(data, videoId));
  };
  if (totalSeconds > 0) { begin(totalSeconds); return; }
  const v = playbackControls.videoEl;
  const onMeta = () => { if (v.duration > 0 && Number.isFinite(v.duration)) begin(v.duration); };
  if (v.duration > 0 && Number.isFinite(v.duration)) onMeta();
  else v.addEventListener("loadedmetadata", onMeta, { once: true });
}

function maybeSaveVodProgress() {
  if (!session.playing || !playbackControls.isVod || !session.intendedChannel?.startsWith("vod:")) return;
  const videoId = session.intendedChannel.slice("vod:".length);
  const positionSecs = playbackControls.lastKnownPosition;
  const totalSecs = playbackControls.vodTotalSeconds;
  if (!totalSecs) return; // nothing meaningful to compare position against
  // attach display metadata (for Home's "Continue where you left off") when we have it for this VOD;
  // when we don't (e.g. a session-restored VOD), the backend keeps whatever it recorded before
  const meta = session.vodMeta && session.vodMeta.videoId === videoId ? session.vodMeta : null;
  invoke("save_vod_progress", {
    videoId, positionSecs, totalSecs,
    title: meta?.title || null,
    channelName: meta?.channelName || null,
    channelLogin: meta?.channelLogin || null,
    thumbnailUrl: meta?.thumbnailUrl || null,
    createdAt: meta?.createdAt || null,
  }).catch((err) => {
    console.warn("Failed to save VOD progress:", err);
  });
}

async function watchChannel(channel, stream) {
  if (!channel) return;
  hideRaidBanner(); // a raid banner belongs to the stream you were on
  session.intendedChannel = channel;
  rememberRecentChannel(channel, stream);
  if (session.kickFailover) {
    invoke("stop_kick_chat").catch(() => {});
    // coming from a failover/Kick session into an explicit Twitch watch, restore Twitch chrome (attachKickStream may have flipped to Kick)
    setPlatform("twitch");
  }
  session.kickFailover = null; // fresh session, any previous Kick failover is over

  // stop any running stream first. without it, clicking a new channel while one played would leave the old feeder/video attached while chat.connect() switched channels, so chat switched but the video kept showing the old stream
  if (session.playing) {
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  // hide BOTH pages, not just the active one, the user could start a stream from either home or Browse
  // starting playback always returns to the full-size player: if the mini player was floating (we
  // came from a page while something played), turn it off first so the new video doesn't open inside
  // it. must run before the pages' hide() so its floating inline styles are cleared first
  deactivateMiniPlayer();
  resetMiniPlayerDismissal();
  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  hideDropsBanner();
  hideChannelInfoBar();
  setStatus(`Starting stream for ${channel}...`);
  videoPlaceholder.textContent = "Resolving stream...";
  videoPlaceholder.style.display = "flex";

  // manual Watch: no stream object, so look one up immediately (before chat.connect and start_stream, which don't gate on it) so the info bar populates fast. awaited because we need Helix's live verdict up front: an offline channel skips to chat-only
  let streamPromise;
  if (stream !== undefined) {
    streamPromise = Promise.resolve(stream);
  } else {
    streamPromise = invoke("get_stream_for_login", { login: channel })
      .then((json) => JSON.parse(json))
      .catch((err) => {
        console.error("Failed to look up stream info for", channel, err);
        return null;
      });
  }
  streamPromise.then((s) => {
    // stale guard: if the user switched channels mid-lookup, session.intendedChannel points at the newer one, don't let this older resolution stomp it
    if (session.intendedChannel !== channel) return;
    updateDropsBanner(channel, s);
    updateChannelInfoBar(channel, s);
  });

  const resolvedStream = await streamPromise;
  // stale guard again for this awaited copy, the .then() above only protects the info bar/banner; without this, an old lookup could drive this function's own live/offline branch and start_stream for the channel they left
  if (session.intendedChannel !== channel) return;
  // Helix returns no entry for an offline channel (null here), type !== "live" also catches a channel present but not streaming (Helix has used other type values), so check both
  const isLive = Boolean(resolvedStream) && resolvedStream.type === "live";

  await chat.connect(channel);

  if (!isLive) {
    // Twitch reports offline, but simulcasters often keep Kick going, so check Kick before settling into offline chat-only. doubles as the practical way to exercise failover on demand. lookup errors mean "couldn't check", not "not on Kick" (unofficial API), and fall through
    const kickSlug = kickSlugFor(channel); // alias-aware (see kick-aliases.js)
    let kickInfo = null;
    try {
      kickInfo = await invoke("get_kick_stream", { slug: kickSlug });
    } catch (err) {
      console.warn("[kick] offline-entry live check failed:", err);
    }
    // stale guard for the await, same as the earlier ones: the user may have clicked another channel during the Kick lookup
    if (session.intendedChannel !== channel) return;

    if (kickInfo) {
      // set up live-session state, then hand off to the shared Kick attach. the Twitch chat connected above is swapped for Kick chat, brief churn accepted so the fast path doesn't wait on a Kick lookup
      session.playing = true;
      syncWatchBtn();
      if (getSetting("autoTheater")) setTheaterMode(true); // Settings > Player > Auto theater mode
      videoPlaceholder.style.display = "none";
      await attachKickStream(
        kickSlug,
        kickInfo,
        `${channel} is offline on Twitch. Playing on Kick.`,
      );
      updateBackToStreamBtn();
      resyncChannelInfoBarVisibility();
      return;
    }

    // offline channel: stop here rather than calling start_stream (it would just fail), and crucially WITHOUT touching pageVisible/chat, chat.connect() already succeeded and should stay as visible as for a live channel. this case used to land in the catch below, which restored the page and threw away the chat pane for a video-only problem
    setTheaterMode(false); // no video to give extra width to
    setStatus(`#${channel}`);
    videoPlaceholder.textContent = `${channel} is offline`;
    videoPlaceholder.style.display = "flex";
    updateBackToStreamBtn(); // session.playing is still false, the pill stays hidden
    resyncChannelInfoBarVisibility();
    return;
  }

  // theater mode: collapse the channels sidebar so the video gets the extra width, same as clicking "Theater Mode" on the official site
  if (getSetting("autoTheater")) setTheaterMode(true); // Settings > Player > Auto theater mode
  session.currentQuality = getSetting("defaultQuality"); // Settings > Player > Default quality

  try {
    // don't spawn a streamlink pipeline for a channel already clicked away from. start_stream takes ~1-2s, so without this guard rapid switching runs every intermediate channel's pipeline in sequence and the player crawls. the Helix lookup is already guarded; this covers the expensive step
    if (session.intendedChannel !== channel) return;

    // macOS native-HLS path: on macOS (WebKit) the MSE byte-relay is unreliable (see stream-player.js),
    // so resolve the ad-free m3u8 and play via hls.js/native HLS through attachHlsDvr, the path Kick and
    // live-DVR already use. Windows keeps the byte-relay (stronger ad splicing). session.useNativeHlsForLive is a runtime toggle (default on for macOS) so both can be compared without a rebuild
    if (session.useNativeHlsForLive) {
      try {
        setStatus(`Resolving ${channel}…`);
        const m3u8Url = await invoke("get_live_m3u8_url", {
          channel,
          quality: session.currentQuality,
        });
        if (session.intendedChannel !== channel) return;
        session.playing = true;
        rememberSession({ kind: "twitchLive", id: channel });
        session.liveDvrInfo = null;
        session.liveDvrM3u8Cache = null;
        playbackControls.liveDvrStreamStartedAt = null;
        syncWatchBtn();
        setStatus(`Playing: ${channel}`);
        videoPlaceholder.style.display = "none";
        // go through start() (not attachHlsLive directly) so every control it sets up (PiP, overlay, cursor auto-hide, seek bar, quality menu, poller) is initialized. the nativeHlsLive opt just swaps the MSE attach for hls.js inside attachStream
        playbackControls.start(channel, m3u8Url, session.currentQuality, 0, 0, { nativeHlsLive: true });
        updateBackToStreamBtn();
        resyncChannelInfoBarVisibility();

        // same background live-DVR + info-bar refresh the MSE path sets up, so DVR seeking and the viewer count work here too
        invoke("get_live_vod_info", { login: channel })
          .then((raw) => {
            const info = JSON.parse(raw);
            if (session.intendedChannel === channel && info?.video_id && info?.created_at) {
              session.liveDvrInfo = {
                videoId: info.video_id,
                streamStartedAt: new Date(info.created_at).getTime(),
              };
              playbackControls.liveDvrStreamStartedAt = session.liveDvrInfo.streamStartedAt;
              // chapters of the in-progress recording, so you can jump to an earlier game mid-stream
              playbackControls.loadLiveChapters(info.video_id);
              prefetchLiveDvrM3u8();
            }
          })
          .catch(() => {});
        startChannelInfoRefresh(
          channel,
          () => session.playing && playbackControls.currentChannel === channel,
        );
        return;
      } catch (err) {
        if (String(err).includes("superseded")) return;
        if (session.intendedChannel !== channel) return;
        console.error("[native-hls] failed to start live:", err);
        setStatus(`Couldn't play ${channel}: ${err}`);
        videoPlaceholder.textContent = `Couldn't play ${channel}: ${err}`;
        videoPlaceholder.style.display = "flex";
        return;
      }
    }
    const relayUrl = await invoke("start_stream", { channel, quality: session.currentQuality, lowLatency: session.lowLatency });
    // again after: the spawn took real time and the user may have switched, don't ATTACH a superseded stream. we don't stop the relay here: whichever channel they land on runs its own start_stream, which reaps the previous pipeline first. calling stop_stream from this stale path could race and kill the NEWER channel's relay
    if (session.intendedChannel !== channel) return;
    session.playing = true;
    rememberSession({ kind: "twitchLive", id: channel });
    session.liveDvrInfo = null; // clear any stale DVR info from previous channel
    session.liveDvrM3u8Cache = null;
    playbackControls.liveDvrStreamStartedAt = null;
    syncWatchBtn();
    setStatus(`Playing: ${channel}`);
    videoPlaceholder.style.display = "none";
    playbackControls.start(channel, relayUrl, session.currentQuality);
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();

    // fetch live VOD info in the background so live-DVR is ready the moment the user seeks past the buffer. fire-and-forget: on failure live-DVR stays unavailable and seeking clamps
    invoke("get_live_vod_info", { login: channel })
      .then(raw => {
        const info = JSON.parse(raw);
        // only store if still watching the same channel
        if (session.intendedChannel === channel && info?.video_id && info?.created_at) {
          session.liveDvrInfo = {
            videoId: info.video_id,
            streamStartedAt: new Date(info.created_at).getTime(),
          };
          // expand the seek bar to cover the full stream immediately
          playbackControls.liveDvrStreamStartedAt = session.liveDvrInfo.streamStartedAt;
          // chapters of the in-progress recording, so you can jump to an earlier game mid-stream
          playbackControls.loadLiveChapters(info.video_id);
          console.log(`[live-dvr] VOD ready: id=${info.video_id} started=${info.created_at}`);
          // resolve the VOD's m3u8 in the background now so it's cached by the time the user seeks past the buffer
          prefetchLiveDvrM3u8();
        }
      })
      .catch(err => {
        console.log(`[live-dvr] No live VOD available: ${err}`);
        // normal, streamer has VODs disabled, or Helix hasn't created the entry yet (can take ~30s after stream start). DVR stays disabled
      });

    // keep the info bar's viewer count fresh while watching (60s cadence)
    startChannelInfoRefresh(
      channel,
      () => session.playing && playbackControls.currentChannel === channel,
    );
  } catch (err) {
    // a "superseded" error is expected: the relay aborts a start_stream whose channel the user clicked away from. the newer channel owns the UI now, so this stale path must do NOTHING
    if (String(err).includes("superseded")) return;
    // this now only fires for a channel Helix said IS live (offline returned above), so a failure here is something else (streamlink missing, network blip), not "offline". falling back to the previous page is still right, no point staying on a watch view with no video and no clear reason chat alone is useful
    setTheaterMode(false);
    setStatus(`Error: ${err}`);
    videoPlaceholder.textContent = `Failed to start: ${err}`;
    if (session.lastActivePage === "browse") browsePage.show();
    else if (session.lastActivePage === "vods") vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    else homeFeed.show();
    session.pageVisible = true;
    session.intendedChannel = null;
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  }
}

// fired by Rust (eventsub.rs channel.raid) when the watched channel raids out. auto-follows the raid like Twitch's clients rather than freezing on the last frame. guarded on playing + channel match against a stale event
// Settings > Player > Follow raids: auto (5s countdown banner), ask, or off. the banner is the real feedback:
// following switches channels, which clears chat, so a chat line alone vanished the moment it appeared
listen("eventsub-raid", (event) => {
  const { to_login, to_name, viewers } = event.payload;
  if (!session.playing || !to_login) return;
  const watching = (playbackControls.currentChannel || "").toLowerCase();
  // currentChannel can be "vod:<id>", which a live raid should never match anyway, but the prefix check makes "not watching a live channel" explicit
  if (!watching || watching.startsWith("vod:")) return;

  const fromName = (sidebar.followed || []).find((c) => String(c.login).toLowerCase() === watching)?.name || watching;
  const toName = to_name || to_login;
  chat.systemLine(`${fromName} is raiding ${toName}${viewers ? ` with ${viewers.toLocaleString()} viewers` : ""}`);
  const stillWatching = () => session.playing && (playbackControls.currentChannel || "").toLowerCase() === watching;
  showRaidBanner({
    fromName, toName, viewers, mode: getSetting("followRaids"), stillWatching,
    go: async () => {
      if (!stillWatching()) return;
      await watchChannel(to_login);
      showRaidArrived(fromName);
    },
  });
});

// play a Twitch VOD via HLS.js pointed at the Twitch CDN M3U8 (from streamlink --stream-url). replaces the old relay approach, instant seeking, correct buffering, no timestamp overflow
async function watchVod(videoId, vodTotalSeconds = 0, broadcastLogin = "", startPositionSecs) {
  if (!videoId) return;
  hideRaidBanner(); // a raid banner belongs to the stream you were on

  // startPositionSecs is undefined for a plain VOD-card click, only then do we consult saved progress. a chapter click or explicit resume always passes a number (including 0 for chapter 1), which wins outright over older saved progress
  if (startPositionSecs == null) {
    startPositionSecs = 0;
    try {
      const saved = await invoke("get_vod_progress", { videoId });
      if (saved && saved.position_secs < saved.total_secs - VOD_RESUME_END_THRESHOLD_SECS) {
        startPositionSecs = saved.position_secs;
      }
    } catch (err) {
      console.warn("Failed to check saved VOD progress:", err);
    }
  }

  if (session.playing) {
    maybeSaveVodProgress();
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  // starting playback always returns to the full-size player: if the mini player was floating (we
  // came from a page while something played), turn it off first so the new video doesn't open inside
  // it. must run before the pages' hide() so its floating inline styles are cleared first
  deactivateMiniPlayer();
  resetMiniPlayerDismissal();
  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  session.intendedChannel = `vod:${videoId}`;
  if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
  session.kickFailover = null; // fresh session, any previous Kick failover is over
  setStatus(`Starting VOD ${videoId}…`);
  videoPlaceholder.textContent = "Resolving VOD…";
  videoPlaceholder.style.display = "flex";

  if (getSetting("autoTheater")) setTheaterMode(true); // Settings > Player > Auto theater mode
  session.currentQuality = getSetting("defaultQuality"); // Settings > Player > Default quality

  try {
    // chat.setVodMode() and URL resolution are independent (chat needs videoId/login/position, the URL needs videoId/quality), so run both together. this doesn't cut the dominant cost (HLS.js's own manifest fetch, which waits on the URL) but overlaps chat setup with URL resolution
    const [, m3u8Url] = await Promise.all([
      chat.setVodMode(videoId, () => playbackControls.lastKnownPosition, broadcastLogin, startPositionSecs),
      invoke("get_vod_m3u8_url", { videoId, quality: session.currentQuality }),
    ]);
    // URL resolution can take real time and the user may have clicked a different VOD/channel, if intendedChannel moved on, this attach belongs to a dead session and would yank the player onto the wrong VOD. the live paths guard every await; the VOD paths were missing it
    if (session.intendedChannel !== `vod:${videoId}`) return;
    session.playing = true;
    rememberSession({ kind: "twitchVod", id: videoId, vodTotalSeconds, broadcastLogin });
    syncWatchBtn();
    setStatus(`Playing VOD ${videoId}`);
    videoPlaceholder.style.display = "none";
    playbackControls.start(`vod:${videoId}`, m3u8Url, session.currentQuality, vodTotalSeconds, startPositionSecs);
    resolvePipVodUrl(videoId, m3u8Url);
    updateBackToStreamBtn();
    // show the VOD's channel in the info bar (Follow / Subscribe / Videos), even when it was opened
    // from Home where no channel info was loaded; keeps existing info when it's already this channel
    if (broadcastLogin) {
      ensureChannelInfoBarFor(broadcastLogin);
      // show the VOD's own title (not the channel's live-stream title/viewers). from the metadata recorded
      // when it was opened (VOD card / Home row); a session-restored VOD has none, so fall back to the
      // title saved with its progress
      const meta = session.vodMeta && session.vodMeta.videoId === String(videoId) ? session.vodMeta : null;
      if (meta?.title) {
        showVodInInfoBar(broadcastLogin, { title: meta.title, channelName: meta.channelName });
      } else {
        invoke("get_vod_progress", { videoId: String(videoId) })
          .then((e) => {
            if (e?.title && session.intendedChannel === `vod:${videoId}`) {
              showVodInInfoBar(broadcastLogin, { title: e.title, channelName: e.channel_name || "" });
            }
          })
          .catch(() => {});
      }
    } else {
      resyncChannelInfoBarVisibility();
    }
    // fire-and-forget: muted-segment markers are a nice-to-have, never something playback waits on. shows none if the user isn't logged in (Helix only returns muted_segments for a user token) or on any failure
    if (getSetting("mutedSegments")) invoke("get_vod_muted_segments", { videoId }) // Settings > Player
      .then((raw) => playbackControls.renderMutedSegments(JSON.parse(raw), vodTotalSeconds))
      .catch((err) => console.warn("Failed to load muted segments:", err));
    // chat heatmap on the seek bar (vod-heatmap.js). fire-and-forget like the muted segments
    if (getSetting("vodHeatmap")) startChatHeatmap(videoId, vodTotalSeconds); // Settings > Player
    // most-viewed clips of this VOD: seek-bar markers + the Top clips list (get_vod_top_clips in helix.rs)
    if (getSetting("vodTopClips")) invoke("get_vod_top_clips", { videoId: String(videoId) }) // Settings > Player
      .then((r) => playbackControls.setTopClips(r?.clips || [], videoId))
      .catch((err) => console.warn("Failed to load top clips:", err));
  } catch (err) {
    setTheaterMode(false);
    setStatus(`Error: ${err}`);
    videoPlaceholder.textContent = `Failed to start VOD: ${err}`;
    vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    session.pageVisible = true;
    session.intendedChannel = null;
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  }
}

// Kick counterpart of watchVod: plays a finished Kick recording ("kick:<uuid>") via hls.js on Kick's
// proxied master playlist, no streamlink, no Helix. mirrors watchVod line for line; the real
// differences: URL via kick_vod_playback, chat is a "no replay" notice (setKickVodMode), and start()
// runs with kickVod:true so the Twitch-only side fetches don't fire. resume shares watchVod's store
async function watchKickVod(videoId, vodTotalSeconds = 0, startPositionSecs) {
  hideRaidBanner();
  if (!videoId) return;

  // same resume rules as watchVod: only a plain card click consults saved progress; an explicit number (even 0) always wins
  if (startPositionSecs == null) {
    startPositionSecs = 0;
    try {
      const saved = await invoke("get_vod_progress", { videoId });
      if (saved && saved.position_secs < saved.total_secs - VOD_RESUME_END_THRESHOLD_SECS) {
        startPositionSecs = saved.position_secs;
      }
    } catch (err) {
      console.warn("Failed to check saved VOD progress:", err);
    }
  }

  if (session.playing) {
    maybeSaveVodProgress();
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  // starting playback always returns to the full-size player: if the mini player was floating (we
  // came from a page while something played), turn it off first so the new video doesn't open inside
  // it. must run before the pages' hide() so its floating inline styles are cleared first
  deactivateMiniPlayer();
  resetMiniPlayerDismissal();
  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  session.intendedChannel = `vod:${videoId}`;
  if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
  session.kickFailover = null; // fresh session, any previous Kick live/failover is over
  setStatus("Starting Kick VOD…");
  videoPlaceholder.textContent = "Resolving Kick VOD…";
  videoPlaceholder.style.display = "flex";

  if (getSetting("autoTheater")) setTheaterMode(true); // Settings > Player > Auto theater mode
  session.currentQuality = "best";

  try {
    // same overlap as watchVod: the chat swap and the URL resolution are independent, so run them concurrently
    const [, m3u8Url] = await Promise.all([
      chat.setKickVodMode(),
      invoke("kick_vod_playback", { videoId }),
    ]);
    // same stale-session guard as watchVod: a slower resolution here must not clobber a newer session the user started while it was in flight
    if (session.intendedChannel !== `vod:${videoId}`) return;
    session.playing = true;
    rememberSession({ kind: "kickVod", id: videoId, vodTotalSeconds });
    syncWatchBtn();
    setStatus("Playing Kick VOD");
    videoPlaceholder.style.display = "none";
    playbackControls.start(
      `vod:${videoId}`,
      m3u8Url,
      session.currentQuality,
      vodTotalSeconds,
      startPositionSecs,
      { kickVod: true }
    );
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  } catch (err) {
    setTheaterMode(false);
    setStatus(`Error: ${err}`);
    videoPlaceholder.textContent = `Failed to start Kick VOD: ${err}`;
    vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    session.pageVisible = true;
    session.intendedChannel = null;
    updateBackToStreamBtn();
    resyncChannelInfoBarVisibility();
  }
}

// Kick-mode direct watch: the toggle's counterpart to watchChannel(). skips every Twitch step
// (Helix, IRC, streamlink) and goes straight to the Kick lookup + the shared attachKickStream() the
// failover paths use, so it lands in the identical config without ever being a Twitch session. state and stale guards mirror watchChannel's offline->Kick branch
async function watchKickChannel(channel) {
  hideRaidBanner();
  channel = (channel || "").trim().toLowerCase();
  if (!channel) return;
  session.intendedChannel = channel;
  if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
  session.kickFailover = null;

  if (session.playing) {
    playbackControls.stop();
    session.playing = false;
    syncWatchBtn();
  }

  // starting playback always returns to the full-size player: if the mini player was floating (we
  // came from a page while something played), turn it off first so the new video doesn't open inside
  // it. must run before the pages' hide() so its floating inline styles are cleared first
  deactivateMiniPlayer();
  resetMiniPlayerDismissal();
  homeFeed.hide();
  browsePage.hide();
  vodsPage.hide();
  session.pageVisible = false;
  hideDropsBanner();
  hideChannelInfoBar(); // clear the previous channel's; attachKickStream repopulates from the Kick payload
  setStatus(`Looking up ${channel} on Kick...`);
  videoPlaceholder.textContent = "Resolving Kick stream...";
  videoPlaceholder.style.display = "flex";

  let info = null;
  try {
    info = await invoke("get_kick_stream", { slug: channel });
  } catch (err) {
    console.warn("[kick] direct watch lookup failed:", err);
    if (session.intendedChannel !== channel) return;
    setTheaterMode(false);
    setStatus(`Couldn't reach Kick for ${channel}`);
    videoPlaceholder.textContent = `Couldn't check ${channel} on Kick - try again`;
    updateBackToStreamBtn();
    return;
  }
  if (session.intendedChannel !== channel) return; // user moved on mid-lookup

  if (!info) {
    // live lookup said "not live", but the channel may still EXIST, and Kick chatrooms stay open offline. rather than a dead-end "offline" with no chat, connect chat and show the info bar, like kick.com's offline page. Ok(None) from get_kick_channel_chat_info means a genuine 404
    let chatInfo = null;
    try {
      chatInfo = await invoke("get_kick_channel_chat_info", { slug: channel });
    } catch (err) {
      console.warn("[kick] offline chat-info lookup failed:", err);
    }
    if (session.intendedChannel !== channel) return; // user moved on mid-lookup

    setTheaterMode(false);
    session.playing = false;
    syncWatchBtn();
    videoPlaceholder.style.display = "flex";

    if (chatInfo && chatInfo.chatroom_id) {
      setStatus(`#${channel} (Kick - offline)`);
      videoPlaceholder.textContent = `${channel} is offline - chat is live`;
      // chat lives independently of the video: connect it so an offline channel's chat is readable and (logged in) sendable
      await chat
        .connectKick(
          channel,
          chatInfo.chatroom_id,
          chatInfo.broadcaster_user_id,
          chatInfo.subscriber_badges,
        )
        .catch((err) => console.warn("[kick] failed to start offline Kick chat:", err));
      // populate the info bar from the offline identity we already have, so the offline channel still shows its avatar and name
      updateKickChannelInfoBar(channel, {
        display_name: chatInfo.display_name,
        avatar: chatInfo.avatar,
        verified: Boolean(chatInfo.verified),
        title: "",
        category: "",
        viewer_count: undefined,
        tags: [],
        is_mature: false,
      });
      resyncChannelInfoBarVisibility();
    } else {
      // genuine 404 (or no chatroom), the real "doesn't exist" case
      setStatus(`#${channel} (Kick)`);
      videoPlaceholder.textContent = `${channel} doesn't exist on Kick`;
      hideChannelInfoBar();
    }
    updateBackToStreamBtn(); // session.playing is false, the pill stays hidden
    return;
  }

  session.playing = true;
  rememberSession({ kind: "kickLive", id: channel });
  syncWatchBtn();
  if (getSetting("autoTheater")) setTheaterMode(true); // Settings > Player > Auto theater mode
  session.liveDvrInfo = null; // stale session state; attachKickStream re-arms Kick DVR via resolveKickDvr
  session.liveDvrM3u8Cache = null;
  videoPlaceholder.style.display = "none";
  await attachKickStream(
    channel,
    info,
    `Now playing ${channel} on Kick`,
  );
  updateBackToStreamBtn();
  resyncChannelInfoBarVisibility();
}

// the button triggers; platform.js owns the state; this block owns everything VISIBLE about a flip. data rerouting needs no code here, home/browse/sidebar call feedInvoke() (see platform.js)

const platformToggleBtn = document.getElementById("platform-toggle");

// Kick login button + state (used by applyPlatformUi below, so declared first). the full OAuth wiring is further down; these just need to exist before the first applyPlatformUi()
const kickLoginBtn = document.getElementById("kick-login-btn");
const kickUserMenuEl = document.getElementById("kick-user-menu");
const kickUserMenuSignout = document.getElementById("kick-user-menu-signout");
let kickOAuthConfigured = false; // resolved async at startup (below)
let kickLogin = null;

// Kick sign-out dropdown, mirroring TwitchAuth's user menu (auth.js): the username button opens a flyout with an explicit Sign out. same #user-menu CSS and position-from-rect approach
function positionKickUserMenu() {
  const rect = kickLoginBtn.getBoundingClientRect();
  kickUserMenuEl.style.left = "";
  kickUserMenuEl.style.right = `${window.innerWidth - rect.right}px`;
  kickUserMenuEl.style.top = `${rect.bottom + 4}px`;
  kickUserMenuEl.style.bottom = "";
}
function toggleKickUserMenu() {
  const opening = !kickUserMenuEl.classList.contains("open");
  if (opening) positionKickUserMenu();
  kickUserMenuEl.classList.toggle("open", opening);
}
function closeKickUserMenu() {
  kickUserMenuEl.classList.remove("open");
}
// close on any outside click, same as the Twitch menu
document.addEventListener("click", () => closeKickUserMenu());
kickUserMenuSignout.addEventListener("click", async () => {
  closeKickUserMenu();
  await invoke("kick_logout").catch(() => {});
  setKickLoggedInUi(null);
});

// everything about the chrome that reflects the platform: the toggle's label/border, the launcher placeholder, and the Followed section (on both platforms, Twitch's is Helix-backed and needs login, Kick's is the local follow list). called at startup and on every flip
function applyPlatformUi() {
  const kick = isKick();
  // flips every accent color in the stylesheet at once, the CSS variables at the top of styles.css key off body.kick-mode
  document.body.classList.toggle("kick-mode", kick);
  const platformLabel = platformToggleBtn.querySelector(".platform-label");
  if (platformLabel) platformLabel.textContent = kick ? "Kick" : "Twitch";
  else platformToggleBtn.textContent = kick ? "Kick" : "Twitch";
  platformToggleBtn.classList.toggle("platform-kick", kick);
  platformToggleBtn.classList.toggle("platform-twitch", !kick);
  channelInput.placeholder = kick ? "Kick channel name" : "Twitch channel name";
  // section titles per platform: Kick says "Following", Twitch "Followed Channels". the Twitch login prompt inside applies only to Twitch mode (Kick's local follows need no login)
  const followedTitle = document.getElementById("followed-section-title");
  if (followedTitle) followedTitle.textContent = kick ? "Following" : "Followed Channels";
  const followedPrompt = document.getElementById("followed-login-prompt");
  if (followedPrompt) {
    followedPrompt.style.display = kick || sidebar.loggedIn ? "none" : "";
  }
  // the live rail's label per platform: Twitch keeps "Live Channels"; Kick matches kick.com's "Recommended" (styles.css restyles the header and dots under body.kick-mode)
  const topLiveTitle = document.getElementById("top-live-section-title");
  if (topLiveTitle) topLiveTitle.textContent = kick ? "Recommended" : "Live Channels";
  // login buttons swap with the mode so only the relevant one shows. the Kick button additionally appears only if this build can start a Kick login OR the user has a restored session, see the next line
  loginBtn.style.display = kick ? "none" : "";
  // show the Kick button whenever this build can START a login OR the user is already logged in, else a build that lost its config (or hasn't finished the async check) would hide the logged-in pill along with the button, despite a usable restored session
  kickLoginBtn.style.display = kick && (kickOAuthConfigured || kickLogin) ? "" : "none";
}

platformToggleBtn.addEventListener("click", () => togglePlatform());

onPlatformChange(() => {
  applyPlatformUi();
  // feeds hold the other platform's data, drop and refetch (each hook refetches now only if its page shows, else marks itself stale for its next show())
  homeFeed.reloadForPlatformChange();
  browsePage.reloadForPlatformChange();
  sidebar.refreshTopLive();
  sidebar.refreshFollowed(); // platform-branched inside (Kick = local follows)
  // deliberately NOT touched: the currently-playing session. the toggle changes what Home/Browse/search point at going forward; yanking a stream someone's watching because they flipped a browse switch would be hostile
});

// Kick login is its own flow (kick_oauth.rs): a green button (Kick mode only), an OS-browser PKCE
// round-trip, a result event with the username. state here is minimal, the chat pane owns whether
// sending is enabled; this just tracks logged-in/out for the button and tells the pane

function setKickLoggedInUi(login) {
  kickLogin = login || null;
  const loggedIn = Boolean(kickLogin);
  kickLoginBtn.classList.toggle("logged-in", loggedIn);
  kickLoginBtn.textContent = loggedIn ? kickLogin : "Log in with Kick";
  kickLoginBtn.title = loggedIn ? "Account" : "Log in with Kick";
  // the chat pane decides sendability from this plus the broadcaster id
  chat.setKickLoggedIn(loggedIn, kickLogin);
}

kickLoginBtn.addEventListener("click", async (e) => {
  if (kickLogin) {
    // logged in -> open the sign-out dropdown (like the Twitch button). stopPropagation so the outside-click handler doesn't immediately close it
    e.stopPropagation();
    toggleKickUserMenu();
    return;
  }
  try {
    await invoke("start_kick_oauth_login");
    // the browser opens; completion arrives via the kick-oauth-result event below. nothing to await here
  } catch (err) {
    console.warn("[kick] login failed to start:", err);
  }
});

listen("kick-oauth-result", (event) => {
  const { ok, login, error } = event.payload || {};
  if (ok) {
    setKickLoggedInUi(login || "Kick user");
  } else {
    console.warn("[kick] login failed:", error);
    setKickLoggedInUi(null);
  }
});

// startup: find out whether Kick login is available in this build, then apply platform UI (which needs kickOAuthConfigured for the button), then restore any existing Kick session
(async () => {
  try {
    kickOAuthConfigured = Boolean(await invoke("kick_oauth_configured"));
  } catch {
    kickOAuthConfigured = false;
  }
  applyPlatformUi(); // re-run now that kickOAuthConfigured is known
  // tell the chat pane too, it decides whether Kick chat's read-only composer shows "log in to chat" (disabled) or hides with an explanation (login unavailable in this build)
  chat.setKickOAuthConfigured(kickOAuthConfigured);
  // always attempt to restore a saved session regardless of kickOAuthConfigured: that flag only gates a NEW login (needs a client secret); restoring an issued token just needs the file + a bearer call. gating this on it dropped otherwise-usable logins when the config check missed
  try {
    // named kickSession, not `session`, `session` is the imported app-state module, and shadowing it here would trap anyone later reaching for playback state
    const kickSession = await invoke("restore_kick_session");
    if (kickSession && kickSession.login) {
      setKickLoggedInUi(kickSession.login);
      applyPlatformUi(); // re-run again: kickLogin now affects the pill's visibility too
    }
  } catch {
    // not logged in / unrecoverable, stay logged out silently
  }
})();

applyPlatformUi();

// macOS native-HLS toggle: whether Twitch LIVE plays via native HLS/hls.js (get_live_m3u8_url +
// attachHlsDvr) instead of the fMP4 byte-relay + MSE. defaults ON for macOS (WebKit MSE is unreliable),
// OFF elsewhere (byte-relay works and splices ads better)
{
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform)
    || /Mac OS X/i.test(navigator.userAgent);
  session.useNativeHlsForLive = isMac;

}

function syncWatchBtn() {
  watchBtn.textContent = session.playing ? "Stop" : "Watch";
}

// Enter in the channel input = Watch. NOT routed through watchBtn.click(): while playing that button reads Stop, so Enter would have stopped playback. calling the watch functions directly also makes Enter the way to SWITCH channels mid-playback. the input blurs after so player shortcuts take over
channelInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const channel = channelInput.value.trim();
  if (!channel) return;
  channelInput.blur();
  if (isKick()) watchKickChannel(channel);
  else watchChannel(channel);
});

// Full stop of playback + relay teardown, shared by the Stop button and by hiding to tray (so a
// tray-minimized app is quiet and lightweight rather than streaming in the background).
function stopPlayback({ returnToPage = true, goHome = false } = {}) {
  if (!session.playing) return;
  hideRaidBanner();
  _heatmapHandle?.cancel(); // stop sampling a VOD we're leaving
  maybeSaveVodProgress();
  session.intendedChannel = null;
  forgetSession(); // explicit Stop must not be undone by a later reload
  if (session.kickFailover) invoke("stop_kick_chat").catch(() => {});
  session.kickFailover = null;
  session.liveDvrInfo = null;
  session.liveDvrM3u8Cache = null;
  chat.disconnect();
  playbackControls.stop();
  // playbackControls.stop() only tears down the FRONTEND. the relay's streamlink survives a client disconnect by design, so without this it keeps downloading until the next start_stream reaps it. every other stop() site is followed by a start that reaps the old process; this is the one path that stops without starting, so it must say so
  invoke("stop_stream").catch((err) =>
    console.warn("[main] failed to stop relay:", err),
  );
  session.playing = false;
  deactivateMiniPlayer();   // no stream to preview once stopped
  resetMiniPlayerDismissal();
  setTheaterMode(false);
  setStatus("Stopped");
  hideDropsBanner();
  hideChannelInfoBar();
  resetDropsDismissal();
  videoPlaceholder.style.display = "none";
  if (returnToPage) {
    if (goHome) {
      // tray-hide path: always land on Home so reopening shows a clean home page, not the last
      // browse/vods page or a leftover stream frame
      browsePage.hide();
      vodsPage.hide();
      homeFeed.show();
    } else if (session.lastActivePage === "browse") browsePage.show();
    else if (session.lastActivePage === "vods") vodsPage.show(session.vodsChannel, { kick: session.vodsChannelIsKick });
    else homeFeed.show();
    session.pageVisible = true;
  }
  updateBackToStreamBtn();
  syncWatchBtn();
}

watchBtn.addEventListener("click", async () => {
  if (session.playing) {
    stopPlayback();
  } else {
    const channel = channelInput.value.trim();
    if (isKick()) watchKickChannel(channel);
    else watchChannel(channel);
  }
});

// Close-to-tray: push the saved preference to the backend at startup (default on), and stop playback
// whenever the window is hidden to the tray so the app stays quiet and light while still receiving
// whispers and live/category notifications (those run in the still-alive webview).
{
  const closeToTray = localStorage.getItem("closeToTray") !== "0"; // default on
  invoke("set_close_to_tray", { enabled: closeToTray }).catch(() => {});
  listen("hidden-to-tray", () => {
    // Fully stop and return to Home so reopening from the tray shows a clean home page rather than a
    // disconnected chat + empty black stream frame.
    if (session.playing) stopPlayback({ returnToPage: true, goHome: true });
    // Strip the previous channel's chat so a restored window doesn't show stale messages.
    try { chat.clearChatMessages(); } catch { /* ignore */ }
  });
  // the toggle UI lives in the chat settings gear menu now (wired where that menu is built)
}

// WebView2 sleep/wake surface-desync recovery. symptom: after sleep the content is stuck at its old
// size in the top-left with black margins (WebView2 missed the resize on resume). acts ONLY on a
// genuine desync, it compares the webview's believed size against the OS window's real inner size, so a
// normal alt-tab is a no-op; only a real mismatch nudges the window a pixel and back to force a surface recompute
{
  let _recovering = false;
  const recoverIfDesynced = async () => {
    if (_recovering) return;
    _recovering = true;
    try {
      const factor = window.devicePixelRatio || 1;
      const webviewPhysW = Math.round(window.innerWidth * factor);
      const inner = await appWindow.innerSize(); // physical px from Tauri
      // allow a couple px of rounding slack; a real desync is tens-to-hundreds of px off (the whole black-margin gap)
      if (Math.abs(inner.width - webviewPhysW) > 4) {
        console.log(
          `[resize-recovery] desync detected (webview ${webviewPhysW}px vs window ${inner.width}px); nudging`,
        );
        // a maximized window can't be nudged by setSize (Windows un-maximizes it, and inner+1 just clamps back to the work area, so nothing recomputes). toggle maximize instead: the restore<->maximize resize forces the surface recompute AND keeps the window maximized
        if (await appWindow.isMaximized()) {
          await appWindow.unmaximize();
          await appWindow.maximize();
        } else {
          const { PhysicalSize } = await import("@tauri-apps/api/window");
          await appWindow.setSize(new PhysicalSize(inner.width + 1, inner.height));
          await appWindow.setSize(new PhysicalSize(inner.width, inner.height));
        }
      }
    } catch (err) {
      console.warn("[resize-recovery] check failed:", err);
    } finally {
      _recovering = false;
    }
  };
  // check on visibility/focus, when a post-sleep desync first shows. the mismatch guard makes a normal alt-tab a no-op
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recoverIfDesynced();
  });
  window.addEventListener("focus", recoverIfDesynced);
}

// (Removed: the resize listener, 500ms poll, and onMoved() that kept mpv's native window glued to
// #video-region. #video-element resizes via normal CSS now, with no second native surface.)

// (Removed: the onFocusChanged workaround for a native-mpv repaint bug where restoring from tray
// left the frame black. #video-element is normal webview content, repainted like everything else on
// show, with no native surface to nudge.)

