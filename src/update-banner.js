// "Update available" surfaced as a compact header button (#update-btn), matching the app's other
// buttons, plus one-click in-app update. Windows only (the updater plugin is registered only there;
// macOS re-downloads the .dmg). Checks latest.json on startup.

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "@tauri-apps/plugin-os";

let _updating = false;

// fails open: any error just means no button, never a blocked startup
export async function checkForUpdate() {
  try {
    // Windows-only, the updater plugin isn't registered elsewhere
    if (platform() !== "windows") return;

    const update = await check();
    if (!update?.available) return;

    const btn = document.getElementById("update-btn");
    if (!btn) return;
    btn.textContent = "Update";
    btn.title = `Version ${update.version} is ready — click to install`;
    btn.style.display = "";
    btn.onclick = () => runUpdate(update, btn);
  } catch (err) {
    // no endpoint yet, offline, not configured, wrong platform — all fine
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
