// "Update available" banner + one-click in-app update. Windows only (the updater plugin is
// registered only there; macOS re-downloads the .dmg). Checks latest.json on startup.
// Self-contained; main.js calls checkForUpdate().

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { platform } from "@tauri-apps/plugin-os";

const appEl = document.getElementById("app");

let _bannerEl = null;
let _updating = false;

function buildBanner(version, onUpdate) {
  const bar = document.createElement("div");
  bar.className = "update-banner";
  bar.innerHTML = `
    <div class="update-banner-text">
      <strong>Update available</strong>
      <span class="update-banner-version">Version ${version} is ready to install.</span>
    </div>
    <div class="update-banner-progress" style="display:none">
      <div class="update-banner-progress-bar"></div>
      <span class="update-banner-progress-label">Starting…</span>
    </div>
    <button class="update-banner-btn">Update now</button>
    <button class="update-banner-dismiss" title="Later">&times;</button>
  `;
  bar.querySelector(".update-banner-btn").addEventListener("click", onUpdate);
  bar.querySelector(".update-banner-dismiss").addEventListener("click", () => {
    if (!_updating) hideUpdateBanner();
  });
  return bar;
}

function hideUpdateBanner() {
  if (_bannerEl) {
    _bannerEl.remove();
    _bannerEl = null;
  }
}

/**
 * Checks for an update and shows the banner if one exists. Fails OPEN: any error just means
 * no banner, never a blocked startup.
 */
export async function checkForUpdate() {
  try {
    // Windows-only: the updater plugin isn't registered elsewhere.
    if (platform() !== "windows") return;

    const update = await check();
    if (!update?.available) return;

    const onUpdate = async () => {
      if (_updating) return;
      _updating = true;
      const btn = _bannerEl.querySelector(".update-banner-btn");
      const dismiss = _bannerEl.querySelector(".update-banner-dismiss");
      const progress = _bannerEl.querySelector(".update-banner-progress");
      const progressBar = _bannerEl.querySelector(".update-banner-progress-bar");
      const progressLabel = _bannerEl.querySelector(".update-banner-progress-label");
      btn.disabled = true;
      btn.style.display = "none";
      dismiss.style.display = "none";
      progress.style.display = "flex";

      let downloaded = 0;
      let contentLength = 0;
      try {
        // Streams progress, then installs. On Windows (NSIS passive) the installer runs and the
        // app relaunches below.
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              contentLength = event.data.contentLength || 0;
              progressLabel.textContent = "Downloading…";
              break;
            case "Progress":
              downloaded += event.data.chunkLength || 0;
              if (contentLength > 0) {
                const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
                progressBar.style.width = `${pct}%`;
                progressLabel.textContent = `Downloading… ${pct}%`;
              }
              break;
            case "Finished":
              progressBar.style.width = "100%";
              progressLabel.textContent = "Installing…";
              break;
          }
        });

        progressLabel.textContent = "Restarting…";
        await relaunch();
      } catch (err) {
        console.error("[updater] install failed:", err);
        _updating = false;
        progress.style.display = "none";
        btn.style.display = "";
        btn.disabled = false;
        dismiss.style.display = "";
        btn.textContent = "Retry update";
      }
    };

    hideUpdateBanner();
    _bannerEl = buildBanner(update.version, onUpdate);
    // If the deps banner is also showing (fixed to the top), stack below it.
    const depsVisible = document.getElementById("deps-banner")?.offsetParent !== null;
    if (depsVisible) _bannerEl.classList.add("below-deps");
    appEl.appendChild(_bannerEl);
  } catch (err) {
    // No endpoint yet, offline, not configured, wrong platform - all fine.
    console.log("[updater] no update / check skipped:", err?.message || err);
  }
}
