// Themed tooltips, app-wide. Native `title` tooltips are drawn by the OS (light, square, system font) and
// can't be styled, so this replaces them: on hover, an element's title is moved aside (which suppresses the
// native tooltip) and shown in a themed tooltip near the cursor instead; on leave, the title is put back, so
// the DOM stays exactly as the rest of the app expects (code that reads or sets .title keeps working).
// No per-element changes needed: every existing and future `title` is picked up automatically.

const SHOW_DELAY_MS = 500;   // like the native tooltip's delay
const WARM_WINDOW_MS = 400;  // moving straight onto another titled element shows its tooltip immediately
const CURSOR_GAP = 14;

let tipEl = null;
let target = null;           // element currently hovered whose title we took
let stashedTitle = "";
let showTimer = null;
let lastHiddenAt = 0;
let mouseX = 0, mouseY = 0;
let titleObserver = null;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "app-tooltip";
  tipEl.setAttribute("role", "tooltip");
  document.body.appendChild(tipEl);
  return tipEl;
}

// nearest ancestor (or self) with a non-empty title. SVG <title> children aren't attributes, so they're
// naturally ignored
function titledAncestor(node) {
  for (let el = node; el && el !== document.documentElement; el = el.parentElement) {
    if (el.nodeType === 1 && el.hasAttribute && el.hasAttribute("title") && el.getAttribute("title").trim()) return el;
  }
  return null;
}

function position() {
  if (!tipEl) return;
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let left = mouseX + 2;
  let top = mouseY + CURSOR_GAP + 6;
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  if (top + h > window.innerHeight - 8) top = Math.max(8, mouseY - h - CURSOR_GAP); // flip above the cursor
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function show() {
  if (!target || !stashedTitle) return;
  const el = ensureTipEl();
  el.textContent = stashedTitle;
  el.classList.add("visible");
  position();
}

function hideTip() {
  clearTimeout(showTimer);
  showTimer = null;
  if (tipEl && tipEl.classList.contains("visible")) {
    tipEl.classList.remove("visible");
    lastHiddenAt = Date.now();
  }
}

// give the title back to the element and stop watching it
function release() {
  hideTip();
  titleObserver?.disconnect();
  if (target && stashedTitle && !target.hasAttribute("title")) target.setAttribute("title", stashedTitle);
  target = null;
  stashedTitle = "";
}

function take(el) {
  target = el;
  stashedTitle = el.getAttribute("title");
  el.removeAttribute("title"); // no attribute while hovered = no native tooltip
  // app code sometimes updates a title while it's hovered (e.g. the "Catching up to live" readout): take the
  // new text for the themed tooltip and remove the attribute again so the native one never appears
  titleObserver ??= new MutationObserver(() => {
    if (!target || !target.hasAttribute("title")) return;
    const next = target.getAttribute("title");
    target.removeAttribute("title");
    stashedTitle = next;
    if (!next.trim()) { hideTip(); return; }
    if (tipEl?.classList.contains("visible")) { tipEl.textContent = next; position(); }
  });
  titleObserver.observe(el, { attributes: true, attributeFilter: ["title"] });
}

function onOver(e) {
  const el = titledAncestor(e.target);
  if (el === target) return;
  if (target && target.contains(e.target) && !el) return; // still inside the element we already took
  release();
  if (!el) return;
  take(el);
  const warm = Date.now() - lastHiddenAt < WARM_WINDOW_MS;
  showTimer = setTimeout(show, warm ? 0 : SHOW_DELAY_MS);
}

function onOut(e) {
  if (!target) return;
  // leaving to something still inside the same element isn't leaving
  if (e.relatedTarget && target.contains(e.relatedTarget)) return;
  release();
}

export function initTooltips() {
  if (initTooltips._done) return;
  initTooltips._done = true;
  document.addEventListener("mousemove", (e) => { mouseX = e.clientX; mouseY = e.clientY; }, { passive: true });
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mouseout", onOut, true);
  // anything that normally dismisses a tooltip. NOT "scroll": live chat auto-scrolls several times a second,
  // so hiding on any scroll cancelled every pending tooltip before it could appear (tooltips never showed
  // in the app). the user scrolling is covered by "wheel", and content moving out from under a still
  // cursor fires mouseout (Chromium re-dispatches boundary events after a scroll), which releases it
  for (const ev of ["mousedown", "wheel", "keydown", "dragstart"]) document.addEventListener(ev, hideTip, true);
  window.addEventListener("blur", release);
  // the hovered element can vanish (a menu closes, a list re-renders): don't leave a tooltip floating
  new MutationObserver(() => {
    if (target && !target.isConnected) { target = null; stashedTitle = ""; hideTip(); titleObserver?.disconnect(); }
  }).observe(document.body, { childList: true, subtree: true });
}
