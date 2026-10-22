// Twitch OAuth, frontend half. the actual browser flow lives in Rust (oauth.rs); this
// triggers it, waits for the token event, validates, and stores the login

import { showAppToast } from "./app-toast.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export class TwitchAuth {
  constructor({ loginBtn, userMenuEl, userMenuSignout, statusCallback }) {
    this.loginBtn       = loginBtn;
    this.userMenuEl     = userMenuEl;
    this.userMenuSignout = userMenuSignout;
    this.statusCallback = statusCallback || (() => {});
    this.login = null;

    this.loginBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.login) {
        this._toggleUserMenu();
      } else {
        this.startLogin();
      }
    });

    this.userMenuSignout?.addEventListener("click", () => {
      this._closeUserMenu();
      this.logout();
    });

    document.addEventListener("click", () => this._closeUserMenu());

    this.setupListener();
    this.tryRestoreSession();
  }

  _positionUserMenu() {
    const rect = this.loginBtn.getBoundingClientRect();
    this.userMenuEl.style.left  = "";
    this.userMenuEl.style.right = `${window.innerWidth - rect.right}px`;
    this.userMenuEl.style.top   = `${rect.bottom + 4}px`;
    this.userMenuEl.style.bottom = "";
  }

  _toggleUserMenu() {
    const opening = !this.userMenuEl.classList.contains("open");
    if (opening) this._positionUserMenu();
    this.userMenuEl.classList.toggle("open", opening);
  }

  _closeUserMenu() {
    this.userMenuEl?.classList.remove("open");
  }

  async setupListener() {
    // the token never reaches the page: Rust validates and keeps it, and only says who logged in
    await listen("oauth-login", async (event) => {
      await this.handleLogin(event.payload || {});
    });
    await listen("oauth-login-failed", (event) => {
      console.error("Token validation failed:", event.payload);
      this._setLoginLabel("Log in with Twitch");
      this.loginBtn.disabled = false;
    });
  }

  async _resolveDisplayName(login, userId) {
    try {
      const users = JSON.parse(await invoke("get_users_info", { userIds: [userId] }));
      // the profile picture rides along: the account button shows it (_setAvatar)
      this._avatarUrl = users?.[0]?.profile_image_url || null;
      return users?.[0]?.display_name || login;
    } catch {
      this._avatarUrl = null;
      return login;
    }
  }

  // the account button is icon-only in the header: logged in, it shows your Twitch profile picture instead
  // of the person icon (which comes back if the picture can't load, and when you sign out)
  _setAvatar(url) {
    const btn = this.loginBtn;
    let img = btn.querySelector(".account-avatar");
    if (!url) { img?.remove(); btn.classList.remove("has-avatar"); return; }
    if (!img) {
      img = document.createElement("img");
      img.className = "account-avatar";
      img.alt = "";
      img.draggable = false;
      img.addEventListener("error", () => { img.remove(); btn.classList.remove("has-avatar"); });
      img.addEventListener("load", () => btn.classList.add("has-avatar"));
      btn.prepend(img);
    }
    if (img.getAttribute("src") !== url) img.src = url;
  }

  // write to the label span, not the button, so the person icon survives
  _setLoginLabel(text) {
    const label = this.loginBtn.querySelector(".login-label");
    if (label) label.textContent = text;
    else this.loginBtn.textContent = text;
    // the header shows this button as an icon only: the label lives on in the tooltip
    this.loginBtn.title = text;
    this.loginBtn.setAttribute("aria-label", text);
  }

  async tryRestoreSession() {
    try {
      this._setLoginLabel("Restoring session…");
      this.loginBtn.disabled = true;

      const result = await invoke("restore_session");
      if (result) {
        const { login, user_id, missing_scopes } = result;
        this.login = login;
        const displayName = await this._resolveDisplayName(login, user_id);
        this._setLoginLabel(displayName);
        this._setAvatar(this._avatarUrl);
        this.loginBtn.classList.add("logged-in");
        this.loginBtn.disabled = false;
        this.statusCallback(login, user_id, displayName);
        this._checkScopes(missing_scopes);
      } else {
        this._setLoginLabel("Log in with Twitch");
        this.loginBtn.disabled = false;
      }
    } catch (err) {
      console.error("Session restore failed:", err);
      this._setLoginLabel("Log in with Twitch");
      this.loginBtn.disabled = false;
    }
  }

  async startLogin() {
    try {
      this._setLoginLabel("Logging in…");
      this.loginBtn.disabled = true;
      await invoke("start_oauth_login");
      // the login now waits in the browser. the button stays usable: closing that tab and clicking again opens
      // the same login (oauth.rs). it used to stay disabled until Mosaic restarted when the tab was closed
      this.loginBtn.disabled = false;
    } catch (err) {
      console.error("Failed to start login:", err);
      showAppToast(`Couldn't start the Twitch login: ${typeof err === "string" ? err : err?.message || "try again"}`, { error: true });
      this._setLoginLabel("Log in with Twitch");
      this.loginBtn.disabled = false;
    }
  }

  async logout() {
    try {
      await invoke("logout"); // also clears the session's credentials in Rust
      // tear down the persistent whisper connection — no account to receive whispers for anymore
      await invoke("stop_account_eventsub").catch(() => {});
    } catch (err) {
      console.error("Logout failed:", err);
    }
    this.login = null;
    this._setLoginLabel("Log in with Twitch");
    this._setAvatar(null);
    this.loginBtn.classList.remove("logged-in");
    this.loginBtn.disabled = false;
    this.statusCallback(null, null, null);
  }

  async handleLogin({ login, user_id, missing_scopes }) {
    try {
      this.login = login;
      const displayName = await this._resolveDisplayName(login, user_id);
      this._setLoginLabel(displayName);
      this._setAvatar(this._avatarUrl);
      this.loginBtn.classList.add("logged-in");
      this.loginBtn.disabled = false;
      this.statusCallback(login, user_id, displayName);
      // a fresh login should have every scope; clear any stale banner from a previous old-token session
      this._checkScopes(missing_scopes);
    } catch (err) {
      console.error("Token validation failed:", err);
      this._setLoginLabel("Log in with Twitch");
      this.loginBtn.disabled = false;
    }
  }

  // Shows (or hides) a re-login banner based on which required scopes the current token is missing.
  // Older tokens created before a scope was added will be missing it, so the user is prompted to sign
  // out and back in to unlock the features that need it (e.g. whispers need user:read:whispers).
  _checkScopes(missingScopes) {
    const banner = document.getElementById("scope-relogin-banner");
    if (!banner) return;
    const missing = Array.isArray(missingScopes) ? missingScopes : [];
    if (!missing.length) {
      banner.style.display = "none";
      document.getElementById("app")?.classList.remove("scope-banner-visible");
      return;
    }

    // human-friendly summary of what's affected, without dumping raw scope strings
    const affected = [];
    if (missing.some((s) => s.includes("whispers"))) affected.push("whispers");
    if (missing.some((s) => s.startsWith("moderator:"))) affected.push("some mod tools");
    const what = affected.length ? affected.join(" and ") : "some features";

    const msgEl = banner.querySelector(".scope-relogin-text");
    if (msgEl) msgEl.textContent = `New permissions are needed for ${what}. Sign out and back in to enable them.`;
    banner.style.display = "";
    document.getElementById("app")?.classList.add("scope-banner-visible");

    const btn = banner.querySelector(".scope-relogin-btn");
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener("click", async () => { await this.logout(); this.startLogin(); });
    }
    const dismiss = banner.querySelector(".scope-relogin-dismiss");
    if (dismiss && !dismiss._wired) {
      dismiss._wired = true;
      dismiss.addEventListener("click", () => {
        banner.style.display = "none";
        document.getElementById("app")?.classList.remove("scope-banner-visible");
      });
    }
  }
}
