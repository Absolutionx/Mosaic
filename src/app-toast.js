// A short message at the bottom of the window, for things that would otherwise fail silently (a login that
// couldn't start, ...). One at a time, gone after a few seconds or on click; screen readers announce it.

let el = null;
let timer = null;

export function showAppToast(text, { error = false, ms = 5000 } = {}) {
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
  el.classList.toggle("error", !!error);
  el.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(hide, ms);
}

function hide() {
  clearTimeout(timer);
  el?.classList.remove("show");
}
