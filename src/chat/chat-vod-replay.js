// the VOD chat replay engine, mixed into TwitchChat. pulled out of chat.js's setVodMode:
// the paging/dedupe/forward-search fetch loop, seek detection (and the notifyVodSeek hook
// playback-controls.js calls), and the tick loop that flushes queued messages at their
// timestamps. a self-contained state machine, all state closure-local

import { invoke } from "@tauri-apps/api/core";
import { reconstructVodMessage } from "./emote-parsing.js";

export const chatVodReplayMixin = {
  // disconnect live chat and start VOD replay, synced to playback via getPosition() (seconds).
  // fetch a page of GQL comments ahead of the position, schedule each at its
  // content_offset_seconds, pre-fetch the next page. a jump > 5s resets and re-fetches
  async setVodMode(videoId, getPosition, broadcastLogin = "", initialPositionSecs = 0) {
    return this._serializeLifecycle(() =>
      this._doSetVodMode(videoId, getPosition, broadcastLogin, initialPositionSecs),
    );
  },

  async _doSetVodMode(videoId, getPosition, broadcastLogin = "", initialPositionSecs = 0) {
    await this._doDisconnect();
    // connect() clears the previous channel's channel-level emotes on a live switch, but this
    // path only goes through disconnect() (which doesn't). globals stay and are re-fetched below
    this._clearChannelEmotes();
    this.container.innerHTML = "";
    this.channel = null;
    this.setStatus("replay");
    this.systemLine("Loading chat replay…");

    // VOD chat is read-only replay, hide the input row rather than leave an enabled box that looks usable
    this._isVodMode = true;
    this._setInputRowVisible(false);

    // stop any previous replay loop
    if (this._vodReplayStop) this._vodReplayStop();

    let stopped = false;
    this._vodReplayStop = () => { stopped = true; };

    // live connect() is the only other place globals load, so a VOD opened without a prior live
    // connection would have none. fire-and-forget and idempotent
    this.loadSevenTvGlobalEmotes();
    this.loadBttvGlobalEmotes();
    this.loadFfzGlobalEmotes();
    this.loadTwitchGlobalEmotes();

    // 7TV's /users/twitch/:id needs the NUMERIC user id, which VOD mode has no ROOMSTATE to
    // source, so resolve via Helix first. fire-and-forget: not logged in just means no channel emotes
    if (broadcastLogin) {
      console.log(`[7tv] Loading channel emotes for VOD replay, broadcastLogin="${broadcastLogin}"`);
      invoke("get_user_id_for_login", { login: broadcastLogin })
        .then((userId) => {
          console.log(`[7tv] Resolved "${broadcastLogin}" -> userId=${userId}, loading channel emotes`);
          this.loadSevenTvChannelEmotes(userId);
          // same fix as the live handler: BTTV + FFZ channel emotes were never loaded for VOD replay either, so FFZ ones (LOLW/KEKW) showed as bare text
          this.loadBttvChannelEmotes(userId);
          this.loadFfzChannelEmotes(userId);
        })
        .catch((err) => console.warn("Failed to resolve broadcaster id for 7TV channel emotes:", err));
    } else {
      // if this fires, broadcastLogin itself is falsy and the channel-emote fetch never starts. logged to tell that apart from a silent run
      console.warn("[7tv] Skipping VOD channel-emote load entirely - broadcastLogin is falsy:", broadcastLogin);
    }

    // disconnect() above clears badgeMap and no other path refills it for VODs, so comment badges wouldn't render
    this.loadGlobalBadges();
    if (broadcastLogin) {
      // channel badges need the broadcaster's user id, not login. fire-and-forget, badges backfill via _backfillBadges()
      invoke("get_user_by_login", { login: broadcastLogin })
        .then(raw => {
          const user = JSON.parse(raw);
          if (user?.id) this.loadChannelBadges(user.id);
        })
        .catch(() => {}); // missing channel badges are non-critical
    }

    const LOOKAHEAD_S = 30;   // fetch comments up to 30s ahead of position
    const CHECK_MS   = 500;   // how often to check for messages to show
    const _t0 = performance.now();
    const _ts = () => ((performance.now() - _t0) / 1000).toFixed(2) + "s";

    // {offset, user, color, body, emotesTag} fetched but not yet shown
    let queue = [];
    let fetchCursor = "";
    let fetchedUpTo = -1;   // highest content_offset_seconds fetched so far
    // every comment id (or composite fallback, see dedupeKey) already queued this session.
    // Twitch's offset query returns the page CONTAINING the timestamp, so retries overlap;
    // without dedupe every stall recovery re-rendered up to a page. cleared on resetAndFetch
    let seenComments = new Set();
    // forward-search distance for retries after a cursor chain dead-ends. Twitch's chains often
    // report hasNextPage:false before the VOD ends, and re-querying at the frontier returns the
    // page we have, so each empty retry pushes the next offset further (+5s, capped) until unseen
    // comments turn up. reset to 0 when a retry returns something new
    let stuckOffsetNudge = 0;
    let lastPosition = -1;  // for jump detection (seeks)
    let fetching = false;
    // bumped by resetAndFetch() on every seek. fetchPage() captures it on entry and re-checks
    // after the await; if it changed (a seek fired mid-fetch), the results are stale and discarded
    let fetchGeneration = 0;
    // seek-detection stays off until getPosition() is seen near expectedPosition. a fixed timer
    // can't work: resuming deep into a VOD can leave getPosition() reporting stale/zero for 10s+
    // while HLS.js loads and seeks (15s seen in testing)
    let awaitingPositionSync = true;
    let expectedPosition = initialPositionSecs;
    let _syncWaitStartedAt = performance.now();

    // true once a fetch confirmed (hasNextPage:false) the CURRENT cursor chain is done, NOT that
    // the VOD is. Twitch's pagination can end before the VOD does, and a fresh offset fetch
    // further along finds more. kept distinct so the pre-fetch can retry with a fresh offset
    let cursorExhausted = false;
    // adaptive backoff for exhausted-cursor retries: 1s, doubling per empty result (cap 30s),
    // back to 1s when one returns comments. handles both a VOD whose cursor dead-ends after every
    // page (1s keeps chat smooth) and one genuinely out of comments (backoff stops hammering)
    let exhaustedRetryDelay = 1000;   // ms, current backoff interval
    let lastExhaustedRetryAt = -Infinity; // performance.now() timestamp
    // logs every 4th tick (~2s)
    let _tickN = 0;

    console.log(`[vod-chat] ${_ts()} start video=${videoId}`);

    const resetAndFetch = async (fromSeconds) => {
      console.log(`[vod-chat] ${_ts()} RESET to ${fromSeconds.toFixed(1)}s  fetching=${fetching} gen=${fetchGeneration}->${fetchGeneration+1}  queue=${queue.length}  fetchedUpTo=${fetchedUpTo}`);
      queue = [];
      fetchCursor = "";
      fetchedUpTo = -1;
      // fresh Set rather than .clear() so a still-in-flight stale fetch can't race writes into the new position's dedupe state
      seenComments = new Set();
      stuckOffsetNudge = 0;
      lastPosition = fromSeconds;
      cursorExhausted = false;
      exhaustedRetryDelay = 1000;
      lastExhaustedRetryAt = -Infinity;
      fetchGeneration++;
      // position hasn't caught up to fromSeconds, don't trust seek-detection until it has. needed
      // on EVERY reset: without re-arming, the next tick could read the stale pre-seek position and
      // misread it as a fresh seek, cascading resets
      awaitingPositionSync = true;
      expectedPosition = fromSeconds;
      _syncWaitStartedAt = performance.now();
      this.container.innerHTML = "";
      this.systemLine("Chat replay restarting from new position…");
      await fetchPage(fromSeconds);
      // anchor the exhausted-retry throttle to now so the first retry waits a full interval
      if (lastExhaustedRetryAt === -Infinity) lastExhaustedRetryAt = performance.now();
    };

    // public hook for main.js: playbackControls.onSeek calls this on any real VOD seek, giving
    // chat an explicit signal instead of inferring from position polling (too loose misreads quiet
    // chat as a seek, too tight misses a 5s arrow press). tick()'s polling stays as a backstop
    this.notifyVodSeek = (newPositionSeconds) => {
      if (!this._isVodMode || stopped) return;
      console.log(`[vod-chat] ${_ts()} notifyVodSeek(${newPositionSeconds.toFixed(1)})  fetching=${fetching}`);
      resetAndFetch(newPositionSeconds);
    };

    const fetchPage = async (fromSeconds) => {
      if (fetching || stopped) {
        console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) SKIPPED  fetching=${fetching} stopped=${stopped}`);
        return;
      }
      fetching = true;
      const myGeneration = fetchGeneration;
      const fetchStart = performance.now();
      // captured to tell "cursor advanced" from Twitch returning the same page with hasNext=true in a loop
      const pageCursorBefore = fetchCursor;
      console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) START  cursor=${fetchCursor ? "set" : "empty"}  gen=${myGeneration}`);
      try {
        const raw = await invoke("get_vod_chat", {
          videoId,
          offsetSeconds: fromSeconds,
          cursor: fetchCursor,
        });
        const elapsed = ((performance.now() - fetchStart) / 1000).toFixed(2);
        // a seek fired mid-request, fetchGeneration changed, so discard rather than queue pre-seek comments
        if (stopped || fetchGeneration !== myGeneration) {
          console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) STALE after ${elapsed}s  gen was ${myGeneration} now ${fetchGeneration} - discarding`);
          return;
        }
        // GQL response: array wrapper -> [0].data.video.comments.edges
        const gql = JSON.parse(raw);
        const comments = gql?.[0]?.data?.video?.comments;
        const edges = comments?.edges || [];
        // comments that actually entered the queue this fetch (dupes don't count). this, not
        // fetchedUpTo movement, is "progress": an overlap page can add a few new comments without
        // moving the frontier
        let newCount = 0;
        for (const edge of edges) {
          const node = edge.node;
          const offset = node?.contentOffsetSeconds ?? 0;
          const user = node?.commenter?.displayName || "unknown";
          const userId = node?.commenter?.id ?? null;
          const color = node?.message?.userColor || "#9147ff";

          // one-time diagnostic: this is a persisted query (get_vod_chat), so its field selection is
          // fixed server-side. commenter.id is a reasonable guess; if it's ever missing, log the real shape once
          if (userId == null && !this._loggedMissingCommenterId) {
            this._loggedMissingCommenterId = true;
            console.warn("[vod-chat] commenter.id missing - user cards won't work in VOD replay. Raw commenter object:", JSON.stringify(node?.commenter));
          }

          // body + emotes tag reconstructed from the GQL fragments, see reconstructVodMessage in emote-parsing.js
          const { body, emotesTag } = reconstructVodMessage(node?.message?.fragments);

          // convert GQL userBadges ([{setID,version}]) to the IRC "setId/version,..." string so renderBadges() looks them up like live chat
          const rawBadges = node?.message?.userBadges || [];
          const badgesTag = rawBadges.length > 0
            ? rawBadges.map(b => `${b.setID}/${b.version}`).join(",")
            : null;

          // prefer the node's own id for dedupe, fall back to a composite unique enough in practice.
          // same one-time-diagnostic pattern as commenter.id, node.id is inferred, not guaranteed
          const dedupeKey = node?.id ?? `${offset}|${user}|${body}`;
          if (node?.id == null && !this._loggedMissingCommentNodeId) {
            this._loggedMissingCommentNodeId = true;
            console.warn("[vod-chat] comment node.id missing - deduping by offset|user|body composite instead. Raw node keys:", JSON.stringify(Object.keys(node || {})));
          }
          if (body && !seenComments.has(dedupeKey)) {
            seenComments.add(dedupeKey);
            queue.push({ offset, user, userId, color, body, emotesTag, badgesTag });
            newCount++;
          }
          if (offset > fetchedUpTo) fetchedUpTo = offset;
        }
        // bound dedupe memory on long sessions: past 20k entries drop the oldest half (Sets iterate
        // in insertion order). anything that old is far behind playback and the frontier, so it can't
        // recur outside a seek (which replaces the Set)
        if (seenComments.size > 20_000) {
          let toDrop = seenComments.size / 2;
          for (const key of seenComments) {
            if (toDrop-- <= 0) break;
            seenComments.delete(key);
          }
        }
        // next-page cursor is the last edge's cursor; hasNextPage says whether to keep fetching
        const hasNext = comments?.pageInfo?.hasNextPage ?? false;
        fetchCursor = hasNext && edges.length > 0
          ? edges[edges.length - 1].cursor
          : "";
        // hasNextPage:false means THIS chain is exhausted, not that the VOD has no more comments
        // ahead. tracked separately from fetchCursor, which is also legitimately empty right after a
        // fresh offset fetch
        cursorExhausted = !hasNext;
        if (newCount > 0) {
          // genuinely new comments queued, so clear stall tracking and keep retries snappy
          exhaustedRetryDelay = 1000;
          stuckOffsetNudge = 0;
        } else if (hasNext && fetchCursor && fetchCursor !== pageCursorBefore) {
          // zero new comments but the cursor advanced: re-walking already-fetched ground toward the
          // frontier, the normal aftermath of an offset fetch landing at or before fetchedUpTo, NOT a
          // stall. do nothing; the cursor pre-fetch reaches unseen comments in a page or two
        } else {
          // chain dead-ended (hasNext=false, or the cursor keeps returning the same page): searching
          // again gives the same answer, so nudge the offset forward now. retries stay at 1s inside the
          // lookahead window, only slowing once the whole window comes back empty
          fetchCursor = "";
          cursorExhausted = true;
          stuckOffsetNudge = Math.min(stuckOffsetNudge + 5, 60);
          const posNow = getPosition();
          const nextRetryOffset = Math.max(fetchedUpTo, posNow) + stuckOffsetNudge;
          if (nextRetryOffset > posNow + LOOKAHEAD_S) {
            exhaustedRetryDelay = Math.min(exhaustedRetryDelay * 2, 30_000);
          } else {
            exhaustedRetryDelay = 1000;
          }
          console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) NO WAY FORWARD on this chain (got=${edges.length}, all seen, hasNext=${hasNext}) - next search offset +${stuckOffsetNudge}s, delay=${(exhaustedRetryDelay/1000).toFixed(1)}s`);
        }
        const offsets = edges.length > 0
          ? `${edges[0].node?.contentOffsetSeconds}..${edges[edges.length-1].node?.contentOffsetSeconds}`
          : "none";
        console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) DONE in ${elapsed}s  got=${edges.length} new=${newCount} offsets=${offsets}  hasNext=${hasNext}  fetchedUpTo=${fetchedUpTo}  queue=${queue.length}`);
      } catch (err) {
        console.log(`[vod-chat] ${_ts()} fetchPage(${fromSeconds.toFixed(1)}) ERROR: ${err}`);
        if (!stopped) this.systemLine(`Chat replay error: ${err}`);
      } finally {
        fetching = false;
      }
    };

    // initial fetch from initialPositionSecs (where playback is actually starting/resuming/seeking
    // to), NOT 0. a hardcoded 0 was the cause of "chat won't load" after a live-DVR seek deep into
    // a long stream: nothing else tells this loop where the seek landed, so it paged the whole chain first
    console.log(`[vod-chat] ${_ts()} initial fetchPage(${initialPositionSecs})`);
    await fetchPage(initialPositionSecs);
    if (stopped) return;
    // same wall-clock anchor as resetAndFetch
    if (lastExhaustedRetryAt === -Infinity) lastExhaustedRetryAt = performance.now();
    // arms the sync-wait for startup, like every reset
    awaitingPositionSync = true;
    expectedPosition = initialPositionSecs;
    _syncWaitStartedAt = performance.now();
    this.container.innerHTML = "";
    this.setStatus("replay");
    console.log(`[vod-chat] ${_ts()} replay loop started  fetchedUpTo=${fetchedUpTo}  queue=${queue.length}`);

    // how close pos must get to expectedPosition to count as caught up
    const POSITION_SYNC_TOLERANCE_S = 3;
    // safety cap in case position never converges (a bug elsewhere, a VOD that fails to load),
    // else seek-detection would stay disabled forever. 45s covers even a very slow VOD/manifest load
    const POSITION_SYNC_TIMEOUT_MS = 45_000;

    const tick = async () => {
      if (stopped) return;

      const pos = getPosition();
      _tickN++;
      // compact state summary every ~2s
      if (_tickN % 4 === 0) {
        console.log(`[vod-chat] ${_ts()} tick#${_tickN}  pos=${pos.toFixed(1)}  fetchedUpTo=${fetchedUpTo}  queue=${queue.length}  fetching=${fetching}  cursor=${fetchCursor ? "set" : "empty"}  exhausted=${cursorExhausted}`);
      }

      // captured up front so seek-detection is skipped for the whole tick where sync first confirms,
      // using that pos as next tick's baseline
      const wasAwaitingSync = awaitingPositionSync;
      if (awaitingPositionSync) {
        const closeEnough = Math.abs(pos - expectedPosition) < POSITION_SYNC_TOLERANCE_S;
        const timedOut = performance.now() - _syncWaitStartedAt > POSITION_SYNC_TIMEOUT_MS;
        if (closeEnough || timedOut) {
          console.log(`[vod-chat] ${_ts()} position synced  pos=${pos.toFixed(1)}  expected=${expectedPosition.toFixed(1)}  timedOut=${timedOut}`);
          awaitingPositionSync = false;
        }
      }

      // backward seek: position jumped back more than 5s
      if (!wasAwaitingSync && lastPosition >= 0 && pos < lastPosition - 5) {
        console.log(`[vod-chat] ${_ts()} BACKWARD SEEK detected  pos=${pos.toFixed(1)} < lastPos=${lastPosition.toFixed(1)}-5`);
        await resetAndFetch(pos);
      }
      // forward seek: position jumped further than one tick could produce. compared against
      // lastPosition, not fetchedUpTo (which plateaus on quiet stretches and looked like a seek).
      // the 5s pad clears polling jitter
      else if (!wasAwaitingSync && lastPosition >= 0 && pos > lastPosition + (CHECK_MS / 1000) + 5) {
        console.log(`[vod-chat] ${_ts()} FORWARD SEEK (poll) detected  pos=${pos.toFixed(1)} > lastPos=${lastPosition.toFixed(1)}+threshold`);
        await resetAndFetch(pos);
      }
      lastPosition = pos;

      // pre-fetch when the queue runs low vs lookahead. two cases: (1) normal, fetchCursor is set,
      // keep paging; (2) cursor exhausted but runway remains before LOOKAHEAD_S, retry with a FRESH
      // offset since chains can end before the VOD does. throttled to ~once per LOOKAHEAD_S
      if (!fetching && fetchedUpTo < pos + LOOKAHEAD_S) {
        if (fetchCursor !== "") {
          console.log(`[vod-chat] ${_ts()} PRE-FETCH (cursor)  pos=${pos.toFixed(1)}  fetchedUpTo=${fetchedUpTo}`);
          fetchPage(pos);
        } else if (fetchedUpTo === -1 && !cursorExhausted) {
          // recovery for a dropped initial fetch: rapid seeks can make resetAndFetch()'s fetchPage()
          // no-op (its `if (fetching) return` guard), leaving the loop at fetchCursor="" with nothing
          // retrying. retry until a real fetch confirms empty
          console.log(`[vod-chat] ${_ts()} PRE-FETCH (recover stalled reset)  pos=${pos.toFixed(1)}`);
          fetchPage(pos);
        } else if (cursorExhausted && performance.now() - lastExhaustedRetryAt >= exhaustedRetryDelay) {
          // the frontier (fetchedUpTo) or playback position, whichever is further: not pos alone
          // (wasted refetch when behind the frontier), not fetchedUpTo alone (playback can overtake it
          // on quiet stretches). plus the forward-search nudge
          const retryOffset = Math.max(fetchedUpTo, pos) + stuckOffsetNudge;
          console.log(`[vod-chat] ${_ts()} PRE-FETCH (exhausted retry)  pos=${pos.toFixed(1)}  fetchedUpTo=${fetchedUpTo}  retryOffset=${retryOffset}  secSinceLastRetry=${((performance.now()-lastExhaustedRetryAt)/1000).toFixed(1)}  delay=${(exhaustedRetryDelay/1000).toFixed(1)}s`);
          lastExhaustedRetryAt = performance.now();
          fetchPage(retryOffset);
        }
      }

      // each render is guarded: shift() already removed the message, so a renderer exception costs
      // that one message (logged), not the whole queue head forever
      let rendered = 0;
      while (queue.length > 0 && queue[0].offset <= pos) {
        const msg = queue.shift();
        try {
          this.renderMessage(msg.user, msg.color, msg.body,
            /*badgesTag=*/msg.badgesTag ?? null, /*bits=*/0, /*customRewardId=*/null,
            /*replyParentUser=*/null, /*replyParentBody=*/null,
            /*msgId=*/null, /*userId=*/msg.userId ?? null, /*isAction=*/false,
            msg.emotesTag, /*isFirstMsg=*/false);
        } catch (err) {
          console.error(`[vod-chat] renderMessage threw for a message from "${msg.user}" at ${msg.offset}s - skipping it:`, err, JSON.stringify(msg.body));
        }
        rendered++;
        if (rendered > 50) break; // cap burst after a seek
      }
      if (rendered > 0) {
        console.log(`[vod-chat] ${_ts()} flushed ${rendered} msgs  pos=${pos.toFixed(1)}  queue=${queue.length} remaining`);
      }
    };

    // the loop is a recursive setTimeout chain, and re-scheduling MUST be unconditional (hence the
    // wrapper + finally, not a tail setTimeout): tick is async, so any escaped exception rejected
    // the promise BEFORE the old reschedule ran, silently killing replay for the session. confirmed
    // as VOD chat crashing completely. now it costs one logged tick
    const tickLoop = async () => {
      try {
        await tick();
      } catch (err) {
        console.error(`[vod-chat] ${_ts()} tick threw (loop continues):`, err);
      } finally {
        if (!stopped) setTimeout(tickLoop, CHECK_MS);
      }
    };
    setTimeout(tickLoop, CHECK_MS);
  },
};
