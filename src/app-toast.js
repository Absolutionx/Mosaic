// A short message at the bottom of the window, for things that would otherwise fail silently (a login that
// couldn't start, ...). One at a time, gone after a few seconds or on click; screen readers announce it.

let el = null;
let timer = null;

const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// success: a check mark and a brighter edge, for good news worth noticing (a watch streak saved)
export function showAppToast(text, { error = false, success = false, ms = 5000 } = {}) {
  if (!text) return;
  if (!el) {
    el = document.createElement("div");
    el.className = "app-toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.addEventListener("click", hide);
    document.body.appendChild(el);
  }
  el.textContent = String(text);
  if (success && !error) el.insertAdjacentHTML("afterbegin", `<span class="app-toast-icon">${CHECK}</span>`);
  el.classList.toggle("error", !!error);
  el.classList.toggle("success", !!success && !error);
  el.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(hide, ms);
}

function hide() {
  clearTimeout(timer);
  el?.classList.remove("show");
}
