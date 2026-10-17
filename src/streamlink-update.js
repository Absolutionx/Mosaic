// "Streamlink update" header button (beside Mosaic's own Update button) and the card it opens. Streamlink is what blocks Twitch ads (stream_relay.rs): when
// Twitch changes how ads are marked, the fix arrives as a streamlink release, so an outdated streamlink is
// how ads would come back. Checked each time Mosaic starts and then daily while it stays open (deps_check.rs
// check_streamlink_update; a result isn't kept across restarts, since streamlink can be updated, removed or
// swapped for another copy in between, which once hid a needed update for a day). A copy made by the official
// Windows installer gets a one-click Update, like Mosaic's own: the new installer is downloaded, checked
// against its published checksum and run silently (a system-wide copy asks Windows for permission). Any other
// copy, and other platforms, get a link to streamlink's install page. Dismissing hides it until a newer version.
// When Mosaic itself has an update too (update-banner.js), a one-click streamlink update rides along with it: this
// button hides and Mosaic's own button reads "Update both" and installs the two together.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { showAppToast } from "./app-toast.js";
import { pushEscape } from "./escape-stack.js";

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_AFTER_MS = 30 * 1000; // after startup has settled
const DISMISS_KEY = "mosaic.streamlinkUpdateDismissed"; // the version dismissed ("Not now")
const INSTALL_PAGE = "https://streamlink.github.io/install.html";
const AFTER_RESTART_KEY = "mosaic.streamlinkUpdateResult"; // how a bundled update went, shown after Mosaic restarts

let btn = null;
let card = null, popEscape = null;
let current = null;   // the last check's status
let updating = false;
let lastCheckAt = 0;  // this run only
let appUpdatePending = false; // Mosaic's own Update button is showing (update-banner.js)

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
// the Windows builds carry a packaging revision ("8.6.2-1"); streamlink's own number reads better
const v = (x) => String(x).replace(/-\d+$/, "");

// a newer streamlink the user hasn't dismissed
const wanted = (status) => !!(status?.update_available && status.available) && read(DISMISS_KEY) !== status.available;

function render(status) {
  current = status;
  if (updating || !btn) return;
  // a one-click update goes with Mosaic's own when that's showing; a manual one keeps its own button
  const show = wanted(status) && !(appUpdatePending && status.can_update);
  btn.style.display = show ? "" : "none";
  btn.textContent = "Streamlink update";
  btn.title = show ? `Streamlink ${v(status.available)} is available` : "";
  if (!show) closeCard();
  window.dispatchEvent(new CustomEvent("mosaic:streamlink-status"));
}

// update-banner.js: Mosaic's Update button appeared (or went away)
export function setAppUpdatePending(on) {
  appUpdatePending = !!on;
  if (current) render(current);
}

// update-banner.js: the streamlink update its button can take along, if any
export function bundledStreamlinkUpdate() {
  return !updating && wanted(current) && current.can_update ? current : null;
}

// update-banner.js, with "Update both": stops a live stream that runs through streamlink, installs, and resolves
// { ok, msg }. Mosaic restarts right after, so the result is kept and shown as a toast once it's back up. no
// "done" event here: the stream comes back with the restart (update-banner.js sends it if Mosaic's install fails)
export async function updateStreamlinkForBundle() {
  updating = true;
  window.dispatchEvent(new CustomEvent("mosaic:streamlink-update", { detail: { phase: "start" } }));
  let result;
  try {
    result = { ok: true, msg: String((await invoke("update_streamlink")) || "Streamlink updated.") };
  } catch (err) {
    result = { ok: false, msg: `Couldn't update streamlink: ${err}` };
  }
  write(AFTER_RESTART_KEY, result);
  updating = false;
  return result;
}

// update-banner.js, when Mosaic's own install failed after a bundled streamlink update: show its result now
export function bundledStreamlinkFinished() {
  const r = read(AFTER_RESTART_KEY);
  try { localStorage.removeItem(AFTER_RESTART_KEY); } catch { /* storage unavailable */ }
  if (r?.msg) showAppToast(r.msg, r.ok ? {} : { error: true, ms: 9000 });
  checkStreamlinkUpdate({ force: true });
}

// check now (force), or when this run's last check is more than a day old. any failure just means no button
export async function checkStreamlinkUpdate({ force = false } = {}) {
  if (!force && lastCheckAt && Date.now() - lastCheckAt < CHECK_EVERY_MS) return current;
  lastCheckAt = Date.now();
  try {
    const status = await invoke("check_streamlink_update");
    render(status);
    return status;
  } catch (err) {
    console.warn("[streamlink-update] check failed:", err);
    return null;
  }
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function openCard() {
  if (!current?.available) return;
  closeCard();
  card = el("div", "sl-update-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Streamlink update");
  const title = el("div", "sl-update-card-title", "Streamlink update");
  title.append(el("span", "sl-update-card-versions", current.installed ? `${v(current.installed)} → ${v(current.available)}` : v(current.available)));
  const text = el("p", "sl-update-card-text",
    "Streamlink is what blocks Twitch ads, so keeping it current keeps them away. " +
    (current.can_update
      ? "Mosaic downloads the official installer, checks it and installs it" +
        (current.scope === "machine" ? " (Windows will ask for permission)." : ".") +
        " A stream that's playing restarts when it's done."
      : "This copy wasn't installed with the official installer, so update it the way you installed it."));
  const actions = el("div", "sl-update-card-actions");
  const later = el("button", "sl-update-card-btn quiet", "Not now");
  later.type = "button";
  later.addEventListener("click", () => { write(DISMISS_KEY, current.available); closeCard(); render(current); });
  const go = el("button", "sl-update-card-btn primary", current.can_update ? "Update" : "How to update");
  go.type = "button";
  go.addEventListener("click", () => { closeCard(); if (current.can_update) runUpdate(); else openUrl(INSTALL_PAGE).catch(() => {}); });
  actions.append(later, go);
  card.append(title, text, actions);
  document.body.appendChild(card);
  // under the button, kept on screen
  const r = btn.getBoundingClientRect();
  card.style.top = `${Math.round(r.bottom + 8)}px`;
  card.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - card.offsetWidth - 8, r.right - card.offsetWidth)))}px`;
  go.focus();
  popEscape = pushEscape(closeCard);
  setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
}

function onOutside(e) { if (card && !card.contains(e.target) && e.target !== btn) closeCard(); }

function closeCard() {
  card?.remove();
  card = null;
  popEscape?.();
  popEscape = null;
  document.removeEventListener("mousedown", onOutside, true);
}

async function runUpdate() {
  if (updating || !current?.can_update) return;
  updating = true;
  btn.classList.add("updating");
  btn.disabled = true;
  btn.textContent = "Updating streamlink…";
  // main.js pauses a live stream that runs through streamlink, and restarts it after
  window.dispatchEvent(new CustomEvent("mosaic:streamlink-update", { detail: { phase: "start" } }));
  try {
    const msg = await invoke("update_streamlink");
    showAppToast(String(msg || "Streamlink updated."));
  } catch (err) {
    showAppToast(`Couldn't update streamlink: ${err}`, { error: true, ms: 9000 });
  } finally {
    window.dispatchEvent(new CustomEvent("mosaic:streamlink-update", { detail: { phase: "done" } }));
    updating = false;
    btn.classList.remove("updating");
    btn.disabled = false;
    checkStreamlinkUpdate({ force: true }); // hides the button once current
  }
}

export function initStreamlinkUpdate() {
  btn = document.getElementById("sl-update-btn");
  if (!btn) return;
  // how a streamlink update bundled with Mosaic's own went (it finished just before the restart)
  const after = read(AFTER_RESTART_KEY);
  if (after?.msg) {
    try { localStorage.removeItem(AFTER_RESTART_KEY); } catch { /* storage unavailable */ }
    setTimeout(() => showAppToast(after.msg, after.ok ? {} : { error: true, ms: 9000 }), 1500);
  }
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (card) closeCard(); else openCard(); });
  setTimeout(() => { checkStreamlinkUpdate({ force: true }); }, FIRST_CHECK_AFTER_MS);
  setInterval(() => { checkStreamlinkUpdate(); }, 6 * 60 * 60 * 1000); // the daily check, if the app stays open
}
