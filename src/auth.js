// Twitch OAuth, frontend half. the actual browser flow lives in Rust (oauth.rs); this
// triggers it, waits for the token event, validates, and stores the login

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
    await listen("oauth-token", async (event) => {
      const { access_token } = event.payload;
      await this.handleToken(access_token);
    });
  }

  async _resolveDisplayName(login, userId) {
    try {
      const users = JSON.parse(await invoke("get_users_info", { userIds: [userId] }));
      return users?.[0]?.display_name || login;
    } catch {
      return login;
    }
  }

  // write to the label span, not the button, so the person icon survives
  _setLoginLabel(text) {
    const label = this.loginBtn.querySelector(".login-label");
    if (label) label.textContent = text;
    else this.loginBtn.textContent = text;
  }

  async tryRestoreSession() {
    try {
      this._setLoginLabel("Restoring session…");
      this.loginBtn.disabled = true;

      const result = await invoke("restore_session");
      if (result) {
        const { access_token, login, user_id, missing_scopes } = result;
        await invoke("set_oauth_credentials", { accessToken: access_token, login, userId: user_id });
        this.login = login;
        const displayName = await this._resolveDisplayName(login, user_id);
        this._setLoginLabel(displayName);
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
    } catch (err) {
      console.error("Failed to start login:", err);
      this._setLoginLabel("Log in with Twitch");
      this.loginBtn.disabled = false;
    }
  }

  async logout() {
    try {
      await invoke("logout");
      await invoke("set_oauth_credentials", { accessToken: "", login: "", userId: "" });
      // tear down the persistent whisper connection — no account to receive whispers for anymore
      await invoke("stop_account_eventsub").catch(() => {});
    } catch (err) {
      console.error("Logout failed:", err);
    }
    this.login = null;
    this._setLoginLabel("Log in with Twitch");
    this.loginBtn.classList.remove("logged-in");
    this.loginBtn.disabled = false;
    this.statusCallback(null, null, null);
  }

  async handleToken(accessToken) {
    try {
      const { login, user_id, missing_scopes } = await invoke("validate_oauth_token", { accessToken });
      await invoke("set_oauth_credentials", { accessToken, login, userId: user_id });
      this.login = login;
      const displayName = await this._resolveDisplayName(login, user_id);
      this._setLoginLabel(displayName);
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
