// Logging in to Twitch with a code, for Android (oauth.rs "logging in with a code"). The browser login used on
// desktop can't finish on a phone: Android freezes Mosaic while the browser is in front, so the redirect to
// localhost never gets an answer. Here Mosaic shows a short code; you approve it at twitch.tv/activate (the
// button opens that page with the code filled in) and come back, and Mosaic finishes the login itself.
// Looks like the Twitch connection dialog (pin-auth.js).

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

let overlay = null;
let timer = null;
let onVisible = null;

function close() {
  clearTimeout(timer);
  timer = null;
  if (onVisible) document.removeEventListener("visibilitychange", onVisible);
  onVisible = null;
  if (overlay) {
    overlay.remove();
    overlay = null;
    invoke("cancel_device_login").catch(() => {});
  }
}

function header(modal) {
  const h = document.createElement("div");
  h.className = "chat-filter-header";
  const t = document.createElement("span");
  t.textContent = "Log in with Twitch";
  const x = document.createElement("button");
  x.className = "chat-filter-close";
  x.textContent = "✕";
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", close);
  h.append(t, x);
  modal.appendChild(h);
}

function note(modal, text, cls = "chat-filter-intro") {
  const p = document.createElement("div");
  p.className = cls;
  p.textContent = text;
  modal.appendChild(p);
  return p;
}

// onLogin(info) gets { login, user_id, missing_scopes }, as the "oauth-login" event does on desktop
export async function openDeviceLogin(onLogin) {
  close();
  overlay = document.createElement("div");
  overlay.className = "chat-filter-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const modal = document.createElement("div");
  modal.className = "chat-filter-modal pin-auth-modal";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const esc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);

  header(modal);
  const status = note(modal, "Getting a code from Twitch…");

  let info;
  try {
    info = await invoke("start_device_login");
  } catch (err) {
    status.textContent = `Couldn't start the login: ${err}`;
    return;
  }
  if (!overlay) return; // closed meanwhile

  modal.replaceChildren();
  header(modal);
  note(modal, "1. Open Twitch and sign in if it asks.");
  const code = document.createElement("div");
  code.className = "pin-auth-code";
  code.textContent = info.user_code;
  modal.appendChild(code);
  note(modal, "2. Check that Twitch shows this code, approve, then come back to Mosaic.");
  const row = document.createElement("div");
  row.className = "pin-auth-actions";
  const open = document.createElement("button");
  open.className = "pin-auth-btn primary";
  open.textContent = "Open Twitch";
  open.addEventListener("click", () => openUrl(info.verification_uri).catch(() => {}));
  const copy = document.createElement("button");
  copy.className = "pin-auth-btn ghost";
  copy.textContent = "Copy code";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(info.user_code); copy.textContent = "Copied"; } catch { /* ignore */ }
  });
  row.append(open, copy);
  modal.appendChild(row);
  const waiting = document.createElement("div");
  waiting.className = "pin-auth-waiting";
  waiting.innerHTML = '<span class="track-id-spinner"></span>';
  waiting.append("Waiting for you to approve on Twitch…");
  modal.appendChild(waiting);

  const deadline = Date.now() + info.expires_in * 1000;
  let busy = false;
  const check = async () => {
    clearTimeout(timer);
    if (!overlay || busy) return;
    if (Date.now() > deadline) { fail("The code expired. Close this and log in again for a new one."); return; }
    busy = true;
    let result = null;
    try {
      result = await invoke("poll_device_login");
    } catch (err) {
      busy = false;
      fail(String(err));
      return;
    }
    busy = false;
    if (!overlay) return;
    if (result) {
      close();
      onLogin(result);
      return;
    }
    timer = setTimeout(check, info.interval * 1000);
  };
  const fail = (text) => {
    const msg = document.createElement("span");
    msg.className = "pin-auth-error";
    msg.textContent = text; // an error message, never markup
    waiting.replaceChildren(msg);
  };
  // coming back from the browser: check right away instead of waiting for the next tick
  onVisible = () => { if (document.visibilityState === "visible") check(); };
  document.addEventListener("visibilitychange", onVisible);
  timer = setTimeout(check, info.interval * 1000);
}
