import { invoke } from "@tauri-apps/api/core";
import { showAppToast } from "./app-toast.js";

const appEl = document.getElementById("app");
const depsBanner = document.getElementById("deps-banner");
const depsBannerMissingList = document.getElementById("deps-banner-missing-list");
const depsBannerInstallBtn = document.getElementById("deps-banner-install-btn");
const depsBannerDismiss = document.getElementById("deps-banner-dismiss");

// fails open: any error just means no banner, never a blocked startup
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
  // winget gives no progress, and an installer can stop to ask Windows for permission: say so up front
  showAppToast("Installing with winget. This can take a few minutes, and Windows may ask for permission.", { ms: 10000 });
  try {
    const message = await invoke("install_stream_deps");
    console.log("[deps] install result:", message);
    // re-check rather than trust the success message, the PATH refresh inside
    // install_stream_deps is what actually has to have taken effect
    await checkStreamDeps();
  } catch (err) {
    console.error("Failed to install streamlink/ffmpeg:", err);
    depsBannerInstallBtn.disabled = false;
    depsBannerInstallBtn.textContent = "Retry";
    depsBannerMissingList.parentElement.title = String(err);
    // the reason used to be only in that tooltip, so a failed install just showed "Retry"
    showAppToast(`Couldn't install: ${err}`, { error: true, ms: 20000 });
  }
});

depsBannerDismiss.addEventListener("click", hideDepsBanner);
