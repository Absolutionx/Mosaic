// One-time Twitch device-login so pinned messages work. The main web login's token is rejected by the
// pinned-message GQL op (integrity gating), so this authorizes the app's Android client id on the same
// account via Twitch's device-code flow. See twitch_device_auth.rs.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

let overlay = null;

function close() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

// onConnected() is called after a successful authorization so the caller can kick off a pin fetch
export async function openPinAuthModal(onConnected) {
  if (overlay) close();

  overlay = document.createElement("div");
  overlay.className = "chat-filter-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const modal = document.createElement("div");
  modal.className = "chat-filter-modal pin-auth-modal";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const esc = (e) => {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", esc);
    }
  };
  document.addEventListener("keydown", esc);

  let connected = false;
  try {
    connected = await invoke("twitch_device_connected");
  } catch {}

  if (connected) {
    renderConnected(modal, onConnected);
  } else {
    renderIntro(modal, onConnected);
  }
}

function header(modal, title) {
  const h = document.createElement("div");
  h.className = "chat-filter-header";
  h.innerHTML = `<span>${title}</span>`;
  const x = document.createElement("button");
  x.className = "chat-filter-close";
  x.textContent = "\u2715";
  x.addEventListener("click", close);
  h.appendChild(x);
  modal.appendChild(h);
}

function renderConnected(modal, onConnected) {
  modal.replaceChildren();
  header(modal, "Pinned Messages");
  const p = document.createElement("div");
  p.className = "chat-filter-intro";
  p.textContent = "Connected. Pinned messages will show at the top of chat.";
  modal.appendChild(p);

  const row = document.createElement("div");
  row.className = "pin-auth-actions";
  const disconnect = document.createElement("button");
  disconnect.className = "pin-auth-btn ghost";
  disconnect.textContent = "Disconnect";
  disconnect.addEventListener("click", async () => {
    try {
      await invoke("twitch_device_logout");
    } catch {}
    renderIntro(modal, onConnected);
  });
  row.appendChild(disconnect);
  modal.appendChild(row);
}

function renderIntro(modal, onConnected) {
  modal.replaceChildren();
  header(modal, "Enable Pinned Messages");
  const p = document.createElement("div");
  p.className = "chat-filter-intro";
  p.textContent =
    "Twitch doesn't let a normal login read pinned messages, so this needs a one-time extra authorization on your same Twitch account. You'll get a code to enter at twitch.tv/activate.";
  modal.appendChild(p);

  const row = document.createElement("div");
  row.className = "pin-auth-actions";
  const connect = document.createElement("button");
  connect.className = "pin-auth-btn primary";
  connect.textContent = "Connect";
  connect.addEventListener("click", () => startFlow(modal, onConnected));
  row.appendChild(connect);
  modal.appendChild(row);
}

async function startFlow(modal, onConnected) {
  modal.replaceChildren();
  header(modal, "Enable Pinned Messages");
  const status = document.createElement("div");
  status.className = "chat-filter-intro";
  status.textContent = "Starting\u2026";
  modal.appendChild(status);

  let info;
  try {
    info = await invoke("twitch_device_start");
  } catch (err) {
    status.textContent = `Couldn't start: ${err}`;
    return;
  }

  // show the code + activation link
  modal.replaceChildren();
  header(modal, "Enable Pinned Messages");
  const steps = document.createElement("div");
  steps.className = "pin-auth-steps";
  steps.innerHTML = `
    <div class="chat-filter-intro">1. Open the activation page and sign in if asked.</div>
    <div class="pin-auth-code" id="pin-auth-code"></div>
    <div class="chat-filter-intro">2. Enter the code above to authorize, then come back here.</div>
    <div class="pin-auth-actions">
      <button class="pin-auth-btn primary" id="pin-auth-open">Open twitch.tv/activate</button>
    </div>
    <div class="pin-auth-waiting" id="pin-auth-waiting"><span class="track-id-spinner"></span>Waiting for authorization\u2026</div>`;
  modal.appendChild(steps);
  steps.querySelector("#pin-auth-code").textContent = info.user_code;
  steps.querySelector("#pin-auth-open").addEventListener("click", () => {
    openUrl(info.verification_uri).catch(() => {});
  });

  // poll (long-running) until authorized or expired
  try {
    const ok = await invoke("twitch_device_poll", {
      deviceCode: info.device_code,
      interval: info.interval,
      expiresIn: info.expires_in,
    });
    if (ok) {
      if (typeof onConnected === "function") onConnected();
      renderSuccess(modal);
    }
  } catch (err) {
    // the modal may have been closed; only update if still open
    const w = document.getElementById("pin-auth-waiting");
    if (w) w.innerHTML = `<span class="pin-auth-error">${String(err)}</span>`;
  }
}

function renderSuccess(modal) {
  if (!overlay) return;
  modal.replaceChildren();
  header(modal, "Pinned Messages");
  const p = document.createElement("div");
  p.className = "chat-filter-intro";
  p.textContent = "Connected! Pinned messages will now appear at the top of chat.";
  modal.appendChild(p);
  const row = document.createElement("div");
  row.className = "pin-auth-actions";
  const done = document.createElement("button");
  done.className = "pin-auth-btn primary";
  done.textContent = "Done";
  done.addEventListener("click", close);
  row.appendChild(done);
  modal.appendChild(row);
}
