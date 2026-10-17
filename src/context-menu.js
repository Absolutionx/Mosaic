// The embedded browser's own right-click menu (spelling suggestions in the chat box, Cut / Copy / Paste, and
// everything else it shows when Settings > App > Browser right-click menu is on), drawn in the app's style.
// app_extras.rs intercepts WebView2's native menu, sends its items here as "skinned-context-menu", and runs
// whichever command id we answer with (context_menu_choose; -1 = closed without picking), so a picked spelling
// suggestion replaces the word exactly as the native menu would. Windows only; elsewhere no event ever arrives
// and the webview's own menu shows as before.
//
// Spelling suggestions: WebView2 hands over its suggestion items (named "spellcheck") with empty labels, since
// Chromium fills them in from Windows' spell checker after the menu event has fired. So the menu asks Windows'
// spell checker directly (spell_suggest), shows its suggestions in their place, and replaces the right-clicked
// word itself when one is picked (insertText, so Ctrl+Z still undoes it).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let lastPoint = { x: 0, y: 0, at: 0 };
let open = null; // { id, root, menu, cleanup }

// where the native menu was asked for: the DOM contextmenu event always fires first (it's what opens the
// native menu, unless something cancels it)
document.addEventListener("contextmenu", (e) => {
  lastPoint = { x: e.clientX, y: e.clientY, at: performance.now() };
}, true);

// "&Paste" -> "Paste" (Win32 access-key markers; "&&" is a literal &)
function cleanLabel(s) {
  return String(s || "").replace(/&&/g, "\u0000").replace(/&/g, "").replace(/\u0000/g, "&");
}

function close(command = -1) {
  if (!open) return;
  const { id, root, cleanup } = open;
  open = null;
  cleanup();
  root.remove();
  invoke("context_menu_choose", { id, command }).catch(() => {});
}

function place(el, x, y, flipFrom) {
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = x, top = y;
  if (left + w > window.innerWidth - 8) left = flipFrom != null ? flipFrom - w : window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

// the word the menu was opened on, in a text box: the selection (Chromium selects a right-clicked misspelling),
// else the word around the caret
const WORD_CHAR = /[\p{L}\p{M}\p{N}'\u2019]/u;
function wordAt(el) {
  if (!el || !/^(TEXTAREA|INPUT)$/.test(el.tagName) || typeof el.selectionStart !== "number") return null;
  const v = el.value;
  let start = el.selectionStart, end = el.selectionEnd;
  if (start === end) {
    while (start > 0 && WORD_CHAR.test(v[start - 1])) start--;
    while (end < v.length && WORD_CHAR.test(v[end])) end++;
  }
  const word = v.slice(start, end).replace(/^['\u2019]+|['\u2019]+$/g, "");
  if (!word || /\s/.test(word)) return null;
  const lead = v.slice(start, end).indexOf(word);
  return { el, start: start + lead, end: start + lead + word.length, word };
}

function replaceWord(target, text) {
  const { el, start, end, word } = target;
  if (!el.isConnected || el.value.slice(start, end) !== word) return;
  el.focus();
  el.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) {
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// items worth drawing: no label-less entries (suggestions not filled in yet), no separators at the ends or doubled
function visible(items) {
  const shown = items.filter((it) => it.kind === "separator" || cleanLabel(it.label).trim());
  return shown.filter((it, i, a) => it.kind !== "separator"
    || (i > 0 && i < a.length - 1 && a[i - 1].kind !== "separator"));
}

function buildMenu(items, root, level) {
  const menu = document.createElement("div");
  menu.className = "chat-context-menu skinned-context-menu";
  menu.setAttribute("role", "menu");
  const list = visible(items);
  if (list.some((it) => (it.kind === "checkbox" || it.kind === "radio") && it.checked)) menu.classList.add("has-checks");
  for (const it of list) {
    if (it.kind === "separator") {
      const d = document.createElement("div");
      d.className = "chat-context-menu-divider";
      menu.appendChild(d);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-context-menu-item";
    btn.setAttribute("role", "menuitem");
    btn.disabled = !it.enabled;
    // spelling suggestions get the accent so they read as the answer rather than as commands
    if (it.name === "spellcheck") btn.classList.add("skinned-context-menu-suggestion");
    const check = document.createElement("span");
    check.className = "skinned-context-menu-check";
    check.textContent = (it.kind === "checkbox" || it.kind === "radio") && it.checked ? "✓" : "";
    const label = document.createElement("span");
    label.className = "skinned-context-menu-label";
    label.textContent = cleanLabel(it.label);
    const right = document.createElement("span");
    right.className = "skinned-context-menu-shortcut";
    right.textContent = it.kind === "submenu" ? "›" : (it.shortcut || "");
    btn.append(check, label, right);
    if (it.kind === "submenu") {
      btn.setAttribute("aria-haspopup", "menu");
      const show = () => {
        if (menu._sub?.isConnected && menu._subFor === btn) return;
        menu._sub?.remove();
        if (!it.children?.length) return;
        const sub = buildMenu(it.children, root, level + 1);
        sub.classList.add("skinned-context-menu-sub");
        root.appendChild(sub);
        const r = btn.getBoundingClientRect();
        place(sub, r.right + 2, r.top - 5, r.left - 2);
        menu._sub = sub;
        menu._subFor = btn;
      };
      btn.addEventListener("mouseenter", show);
      btn.addEventListener("click", show);
    } else {
      btn.addEventListener("mouseenter", () => { menu._sub?.remove(); menu._sub = null; });
      btn.addEventListener("click", () => {
        if (!it.enabled) return;
        if (it.replaceWith != null) { const t = open?.word; close(); if (t) replaceWord(t, it.replaceWith); return; }
        close(it.command);
      });
    }
    menu.appendChild(btn);
  }
  return menu;
}

// (re)draw the top-level menu with its top-left corner at x, y
function render(items, x, y) {
  if (!open) return;
  open.root.replaceChildren();
  const menu = buildMenu(items, open.root, 0);
  open.root.appendChild(menu);
  open.menu = menu;
  place(menu, x, y);
}

listen("skinned-context-menu", (event) => {
  const { id, items } = event.payload || {};
  close(); // a menu still open closes first
  if (!Array.isArray(items) || !items.length) {
    invoke("context_menu_choose", { id, command: -1 }).catch(() => {});
    return;
  }
  const active = document.activeElement;
  const root = document.createElement("div");
  root.className = "skinned-context-menu-root";
  document.body.appendChild(root);
  open = { id, root, menu: null, cleanup: () => {} };

  const fresh = performance.now() - lastPoint.at < 2000;
  const r = active?.getBoundingClientRect?.();
  const x = fresh ? lastPoint.x : (r ? r.left + 12 : window.innerWidth / 2);
  const y = fresh ? lastPoint.y : (r ? r.top : window.innerHeight / 2);
  render(items, x, y);

  // spelling suggestions: draw the menu now without them, then add Windows' suggestions for the word
  const slots = items.filter((it) => it.name === "spellcheck").length;
  const word = slots ? wordAt(active) : null;
  if (word) {
    open.word = word;
    const lang = navigator.language || "en-US";
    invoke("spell_suggest", { word: word.word, lang, max: Math.max(slots, 3) }).then((words) => {
      if (open?.id !== id) return;
      const list = Array.isArray(words) ? words : [];
      const firstSlot = items.findIndex((it) => it.name === "spellcheck");
      const spelled = list.length
        ? list.map((w) => ({ kind: "command", name: "spellcheck", label: w, shortcut: "", command: -1, enabled: true, checked: false, children: [], replaceWith: w }))
        : [{ kind: "command", name: "spellcheck-none", label: "No suggestions", shortcut: "", command: -1, enabled: false, checked: false, children: [] }];
      const rest = items.filter((it) => it.name !== "spellcheck");
      rest.splice(firstSlot, 0, ...spelled);
      render(rest, x, y);
    }).catch(() => {});
  }

  // keep the text box focused and its selection intact while the menu is clicked (the native commands act on it)
  root.addEventListener("mousedown", (e) => e.preventDefault());
  const onDown = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      // the top-level menu only (submenus are mouse-driven)
      const buttons = [...(open?.menu?.querySelectorAll(":scope > .chat-context-menu-item:not(:disabled)") || [])];
      const n = buttons.length;
      if (!n) return;
      const down = e.key === "ArrowDown";
      const cur = buttons.findIndex((b) => b.classList.contains("is-kbd"));
      buttons.forEach((b) => b.classList.remove("is-kbd"));
      buttons[cur < 0 ? (down ? 0 : n - 1) : (cur + (down ? 1 : -1) + n) % n].classList.add("is-kbd");
      return;
    }
    if (e.key === "Enter") {
      const k = root.querySelector(".is-kbd");
      if (k) { e.preventDefault(); e.stopPropagation(); k.click(); }
      return;
    }
    // typing anything else closes the menu and lets the key through, like the native one
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") close();
  };
  const onBlur = () => close();
  const onScroll = (e) => { if (!root.contains(e.target)) close(); };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onBlur);
  document.addEventListener("wheel", onScroll, true);
  open.cleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onBlur);
    document.removeEventListener("wheel", onScroll, true);
  };
}).catch(() => {});
