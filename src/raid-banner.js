// Raid feedback over the video. When the channel you're watching raids out (eventsub-raid in main.js):
//   auto: "Raiding to X · N viewers" with a 5s countdown bar, then follows; Go now / Stay here
//   ask:  the same banner with Go / Stay, no countdown (clears itself after a minute)
//   off:  a notice that the raid happened, with an optional Go
// After arriving, "You followed the raid from …" shows briefly on the new stream. The chat line alone gave
// no real feedback: following switches channels, which clears chat the moment the line appears.

const COUNTDOWN_MS = 5000;
let bannerEl = null, timer = null, clearTimer = null;

function host() { return document.getElementById("video-region") || document.body; }

export function hideRaidBanner() {
  clearTimeout(timer); clearTimeout(clearTimer);
  timer = clearTimer = null;
  bannerEl?.remove();
  bannerEl = null;
}

// opts: { fromName, toName, viewers, mode: "auto" | "ask" | "off", go(), stillWatching() }
export function showRaidBanner(opts) {
  hideRaidBanner();
  const { fromName, toName, viewers, mode } = opts;
  const el = document.createElement("div");
  el.className = "raid-banner" + (mode === "auto" ? " counting" : "");
  el.setAttribute("role", "status");
  const who = viewers ? ` · ${Number(viewers).toLocaleString()} viewers` : "";
  const text = mode === "off" ? `${fromName} raided ${toName}${who}` : `Raiding to ${toName}${who}`;
  el.innerHTML =
    '<span class="raid-banner-icon">⚔</span>' +
    '<span class="raid-banner-text"><span class="raid-banner-title"></span><span class="raid-banner-sub"></span></span>' +
    '<span class="raid-banner-actions"></span>' +
    (mode === "auto" ? '<span class="raid-banner-bar"><span></span></span>' : "");
  el.querySelector(".raid-banner-title").textContent = text;
  el.querySelector(".raid-banner-sub").textContent =
    mode === "auto" ? "Following the raid in 5 seconds" : mode === "ask" ? "Follow the raid?" : "You're staying here (Follow raids is off)";
  const actions = el.querySelector(".raid-banner-actions");
  const btn = (label, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = `raid-banner-btn ${cls}`; b.textContent = label;
    b.addEventListener("click", fn);
    actions.appendChild(b);
  };
  const go = () => { hideRaidBanner(); opts.go(); };
  btn(mode === "auto" ? "Go now" : "Go", "primary", go);
  btn(mode === "off" ? "Dismiss" : "Stay here", "", hideRaidBanner);
  host().appendChild(el);
  bannerEl = el;

  if (mode === "auto") {
    const bar = el.querySelector(".raid-banner-bar span");
    requestAnimationFrame(() => { if (bar) { bar.style.transitionDuration = `${COUNTDOWN_MS}ms`; bar.style.transform = "scaleX(0)"; } });
    let left = Math.round(COUNTDOWN_MS / 1000);
    const sub = el.querySelector(".raid-banner-sub");
    const tick = () => {
      // you switched channels / stopped watching meanwhile: never pull you away from that
      if (!opts.stillWatching()) { hideRaidBanner(); return; }
      left -= 1;
      if (left <= 0) { go(); return; }
      sub.textContent = `Following the raid in ${left} second${left === 1 ? "" : "s"}`;
      timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
  } else {
    clearTimer = setTimeout(hideRaidBanner, mode === "ask" ? 60000 : 20000);
  }
}

// on the new stream, after following
export function showRaidArrived(fromName) {
  hideRaidBanner();
  const el = document.createElement("div");
  el.className = "raid-banner arrived";
  el.innerHTML = '<span class="raid-banner-icon">⚔</span><span class="raid-banner-text"><span class="raid-banner-title"></span></span>';
  el.querySelector(".raid-banner-title").textContent = `You followed the raid from ${fromName}`;
  host().appendChild(el);
  bannerEl = el;
  clearTimer = setTimeout(hideRaidBanner, 5000);
}
