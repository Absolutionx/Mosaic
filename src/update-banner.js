// "Update available" surfaced as a compact header button (#update-btn), matching the app's other
// buttons, plus one-click in-app update. Windows only (the updater plugin is registered only there;
// macOS re-downloads the .dmg). Checks latest.json at startup, then keeps checking while the app is
// open — on an interval and whenever the window regains focus — so an update you push shows up
// without the user needing to restart. Tauri can't hot-swap running code, so "live" here means the
// Update button appears live; installing still downloads + relaunches (one click, handled below).

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "@tauri-apps/plugin-os";

let _updating = false;      // an install is in progress — stop re-checking
let _shown = false;         // the Update button is already visible — nothing to re-do
let _pollTimer = null;      // interval handle
let _started = false;       // guard so we only wire interval/focus listeners once

// How often to re-check while the app stays open. 15 minutes is frequent enough that a push reaches
// active users promptly without hammering the release endpoint.
const POLL_MS = 15 * 60 * 1000;

// fails open: any error just means no button, never a blocked startup
export async function checkForUpdate() {
  // Windows-only, the updater plugin isn't registered elsewhere
  if (platform() !== "windows") return;

  // Start the recurring checks once (interval + focus), on top of this first immediate check.
  if (!_started) {
    _started = true;
    _pollTimer = setInterval(() => { _runCheck(); }, POLL_MS);
    // A user flipping back to the app is a natural moment to re-check, and catches updates pushed
    // while the machine was asleep or the window was in the background between interval ticks.
    window.addEventListener("focus", () => { _runCheck(); });
  }

  await _runCheck({ startup: true });
}

// The actual check. Safe to call repeatedly: it no-ops once the button is shown or an install is
// running, and swallows all errors (offline, no endpoint, not configured). `startup` marks the first
// boot check — a button appearing then is expected, so it skips the attention pulse that a
// mid-session (live-detected) update gets.
async function _runCheck({ startup = false } = {}) {
  if (_updating || _shown) return;
  try {
    const update = await check();
    if (!update?.available) return;

    const btn = document.getElementById("update-btn");
    if (!btn) return;
    btn.textContent = "Update";
    btn.title = `Version ${update.version} is ready — click to install`;
    btn.style.display = "";
    btn.onclick = () => runUpdate(update, btn);
    // Draw the eye only when it pops in while the app is already in use.
    if (!startup) {
      btn.classList.add("just-appeared");
      // clear after the longest of the two animations (dot pulse: 1.6s × 3 ≈ 4.8s) so the class
      // doesn't linger; a timeout is more reliable here than animationend, which won't fire for the
      // ::before pseudo-element consistently across engines.
      setTimeout(() => btn.classList.remove("just-appeared"), 5000);
    }

    // Found it — stop polling; the button is now the user's path forward.
    _shown = true;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  } catch (err) {
    // no endpoint yet, offline, not configured, wrong platform — all fine, try again next tick
    console.log("[updater] no update / check skipped:", err?.message || err);
  }
}

async function runUpdate(update, btn) {
  if (_updating) return;
  _updating = true;
  btn.disabled = true;
  btn.classList.add("updating");

  let downloaded = 0;
  let contentLength = 0;
  try {
    // on Windows (NSIS passive) the installer runs and the app relaunches below
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength || 0;
          btn.textContent = "Downloading…";
          break;
        case "Progress":
          downloaded += event.data.chunkLength || 0;
          if (contentLength > 0) {
            const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
            btn.textContent = `Downloading… ${pct}%`;
          }
          break;
        case "Finished":
          btn.textContent = "Installing…";
          break;
      }
    });

    btn.textContent = "Restarting…";
    await relaunch();
  } catch (err) {
    console.error("[updater] install failed:", err);
    _updating = false;
    btn.disabled = false;
    btn.classList.remove("updating");
    btn.textContent = "Retry update";
  }
}
