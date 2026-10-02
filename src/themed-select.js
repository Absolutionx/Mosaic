// A themed dropdown to use instead of a native <select>, whose open list is drawn by the OS (Windows' grey
// highlight, light borders) and can't be styled to match the app. Keyboard works like a select: Up/Down
// move, Enter/Space pick, Escape closes (focus back on the button), Tab moves on.

import { pushEscape } from "./escape-stack.js";

const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>';

// options: [{ value, label }]; onChange(value). returns the button (put it where the <select> was)
export function themedSelect({ options, value, onChange, className = "", label = "" }) {
  let current = value;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `tsel-btn ${className}`.trim();
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  if (label) btn.setAttribute("aria-label", label);
  const text = document.createElement("span");
  text.className = "tsel-label";
  btn.appendChild(text);
  const sync = () => { text.textContent = (options.find((o) => o.value === current) || options[0] || {}).label || ""; };
  sync();

  let menu = null, popEscape = null, hi = -1;
  const close = (refocus = false) => {
    if (!menu) return;
    menu.remove();
    menu = null;
    btn.setAttribute("aria-expanded", "false");
    btn.classList.remove("open");
    popEscape?.(); popEscape = null;
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("resize", onAway);
    window.removeEventListener("scroll", onAway, true);
    if (refocus) btn.focus();
  };
  const onOutside = (e) => { if (menu && !menu.contains(e.target) && !btn.contains(e.target)) close(); };
  // scrolling the menu's own list keeps it open; any other scroll (the page, or the window itself, whose
  // event target isn't a Node) or a resize closes it
  const onAway = (e) => {
    if (e && e.type === "scroll" && menu && e.target instanceof Node && menu.contains(e.target)) return;
    close();
  };
  const pick = (v) => {
    const changed = v !== current;
    current = v;
    sync();
    close(true);
    if (changed) onChange?.(v);
  };
  const highlight = (i) => {
    if (!menu) return;
    const items = [...menu.querySelectorAll(".tsel-item")];
    hi = (i + items.length) % items.length;
    items.forEach((it, k) => it.classList.toggle("hi", k === hi));
  };
  const open = () => {
    if (menu) return;
    menu = document.createElement("div");
    menu.className = "tsel-menu";
    menu.setAttribute("role", "listbox");
    options.forEach((o, i) => {
      const it = document.createElement("div");
      it.className = "tsel-item" + (o.value === current ? " selected" : "");
      it.setAttribute("role", "option");
      it.setAttribute("aria-selected", String(o.value === current));
      const check = document.createElement("span");
      check.className = "tsel-check";
      if (o.value === current) check.innerHTML = CHECK;
      const t = document.createElement("span");
      t.textContent = o.label;
      it.append(check, t);
      it.addEventListener("mouseenter", () => highlight(i));
      it.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on the button
      it.addEventListener("click", () => pick(o.value));
      menu.appendChild(it);
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.minWidth = `${r.width}px`;
    const h = menu.offsetHeight;
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - Math.max(r.width, menu.offsetWidth)))}px`;
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("open");
    highlight(Math.max(0, options.findIndex((o) => o.value === current)));
    popEscape = pushEscape(() => close(true));
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside, true);
      window.addEventListener("resize", onAway);
      window.addEventListener("scroll", onAway, true);
    }, 0);
  };
  btn.addEventListener("click", () => (menu ? close() : open()));
  btn.addEventListener("keydown", (e) => {
    if (!menu) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); open(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(hi + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(hi - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (hi >= 0) pick(options[hi].value); }
    else if (e.key === "Tab") close();
  });
  btn.setValue = (v) => { current = v; sync(); };
  return btn;
}
