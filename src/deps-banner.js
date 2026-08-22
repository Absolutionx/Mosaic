// "streamlink/ffmpeg missing" startup banner (see deps_check.rs): offers a winget
// install. main.js just calls checkStreamDeps().

import { invoke } from "@tauri-apps/api/core";

const appEl = document.getElementById("app");
const depsBanner = document.getElementById("deps-banner");
const depsBannerMissingList = document.getElementById("deps-banner-missing-list");
const depsBannerInstallBtn = document.getElementById("deps-banner-install-btn");
const depsBannerDismiss = document.getElementById("deps-banner-dismiss");

/** Shows the banner if streamlink or ffmpeg is missing. Fails OPEN (just doesn't show)
 * rather than blocking startup. */
export async function checkStreamDeps() {
  try {
    const status = await invoke("check_stream_deps");
    if (status.streamlink && status.ffmpeg) {
      hideDepsBanner();
      return;
    }
    const missing = [];
    if (!status.streamlink) missing.push("streamlink");
    if (!status.ffmpeg) missing.push("ffmpeg");
    showDepsBanner(missing);
  } catch (err) {
    console.error("Failed to check for streamlink/ffmpeg:", err);
  }
}

function showDepsBanner(missing) {
  depsBannerMissingList.textContent = missing.join(" and ");
  depsBannerInstallBtn.disabled = false;
  depsBannerInstallBtn.textContent = "Install";
  depsBanner.style.display = "flex";
  appEl.classList.add("deps-banner-visible");
}

function hideDepsBanner() {
  depsBanner.style.display = "none";
  appEl.classList.remove("deps-banner-visible");
}

depsBannerInstallBtn.addEventListener("click", async () => {
  depsBannerInstallBtn.disabled = true;
  depsBannerInstallBtn.textContent = "Installing…";
  try {
    const message = await invoke("install_stream_deps");
    console.log("[deps] install result:", message);
    // Re-check rather than trust the success message - the PATH refresh inside
    // install_stream_deps is what actually has to have taken effect.
    await checkStreamDeps();
  } catch (err) {
    console.error("Failed to install streamlink/ffmpeg:", err);
    depsBannerInstallBtn.disabled = false;
    depsBannerInstallBtn.textContent = "Retry";
    depsBannerMissingList.parentElement.title = String(err);
  }
});

depsBannerDismiss.addEventListener("click", hideDepsBanner);
