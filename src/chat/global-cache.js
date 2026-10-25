// The global emote and badge sets (7TV, BTTV, FFZ, Twitch's own, Twitch's badges) are the same for every chat,
// but each chat loaded them itself: the main chat and MultiView's both exist from startup, and the main chat
// loaded them again when your login arrived, so every launch fetched each set three times (checked 10-25-26).
// Fetched once here and shared; each chat still adds them to its own lists. A failed fetch isn't kept, so the
// next chat to ask tries again; a good one is reused for half an hour.

const TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // key -> { at, promise }

export function sharedGlobal(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = Promise.resolve().then(load);
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

// a fetch whose JSON is shared: rejects on a non-OK answer (with the status), like a network error
export function sharedJson(key, url) {
  return sharedGlobal(key, async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}
