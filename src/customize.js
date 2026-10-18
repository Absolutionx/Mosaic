// Customize (Settings > Appearance > Customize parts): click any part of Mosaic and restyle it.
// Pick mode outlines and names whatever is under the mouse ("Chat messages", "Sidebar"); clicking opens a
// small editor for that part (background, text, border, accent, roundness, hide, whichever make sense).
// Parts come from the named list in themes.js (CUSTOM_PARTS), never raw page markup, so they keep working
// across updates; clicking something unlisted picks the nearest named part around it. Changes save to the
// customParts setting and apply through settings.js applyAppearance, live as you edit.

import { getSetting, setSetting } from "./settings.js";
import { CUSTOM_PARTS, partById, RADIUS_OPTIONS, SIZE_OPTIONS, isHex, specificity } from "./themes.js";
import { pushEscape } from "./escape-stack.js";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const ICON = (d, size = 14) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

let onDone = null; // where to go when you finish (back to Settings > Appearance)
export function configureCustomize(o) { onDone = o?.onDone || onDone; }

// ---- saved changes ----
export const customParts = () => {
  const c = getSetting("customParts");
  return c && typeof c === "object" ? c : {};
};
function setPart(id, patch) {
  const all = { ...customParts() };
  const next = { ...(all[id] || {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === false || next[k] === "") delete next[k];
  if (Object.keys(next).length) all[id] = next; else delete all[id];
  setSetting("customParts", all);
}
export function resetPart(id) {
  const all = { ...customParts() };
  delete all[id];
  setSetting("customParts", all);
}
// customized parts, in list order, for Settings' "Your changes"
export const changedParts = () => CUSTOM_PARTS.filter((p) => customParts()[p.id]);

// each part's selector split into branches with their specificity, worked out once
const BRANCHES = CUSTOM_PARTS.map((p) => ({ part: p, branches: p.sel.split(",").map((b) => ({ sel: b.trim(), spec: specificity(b) })) }));

// the named part an element belongs to: the element itself or its nearest ancestor that is one. When
// several parts match the same element (a tag that is also the Drops tag), the most specific one wins,
// the same rule the stylesheet follows
function partFor(target) {
  for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
    if (n.closest?.(".cz-ui")) return null; // our own overlay
    let best = null, bestSpec = -1;
    for (const { part, branches } of BRANCHES) {
      for (const b of branches) {
        let hit = false;
        try { hit = n.matches(b.sel); } catch { /* bad selector */ }
        if (hit && b.spec > bestSpec) { best = part; bestSpec = b.spec; }
      }
    }
    if (best) return { part: best, node: n };
  }
  return null;
}

// ---- pick mode ----
let picking = null; // { box, label, bar, popEscape, current }
export function startPicking() {
  closeEditor();
  if (picking) return;
  const box = el("div", "cz-ui cz-box");
  const label = el("div", "cz-ui cz-label");
  const bar = el("div", "cz-ui cz-bar");
  bar.append(el("span", "cz-bar-text", "Click any part of Mosaic to customize it"));
  const stop = el("button", "cz-bar-btn", "Done");
  stop.type = "button";
  stop.addEventListener("click", (e) => { e.stopPropagation(); stopPicking(); onDone?.(); });
  bar.appendChild(stop);
  document.body.append(box, label, bar);
  picking = { box, label, bar, current: null, popEscape: pushEscape(() => { stopPicking(); onDone?.(); }) };
  document.addEventListener("mousemove", onMove, true);
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup"]) document.addEventListener(t, onBlock, true);
  document.body.classList.add("cz-picking");
}
export function stopPicking() {
  if (!picking) return;
  document.removeEventListener("mousemove", onMove, true);
  for (const t of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup"]) document.removeEventListener(t, onBlock, true);
  picking.box.remove(); picking.label.remove(); picking.bar.remove();
  picking.popEscape?.();
  picking = null;
  document.body.classList.remove("cz-picking");
}

function outline(box, label, node, text) {
  const r = node.getBoundingClientRect();
  Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px`, display: "block" });
  label.textContent = text;
  label.style.display = "block";
  const below = r.top < 28;
  label.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - label.offsetWidth - 4))}px`;
  label.style.top = `${below ? r.bottom + 4 : r.top - label.offsetHeight - 4}px`;
}

// at most once a frame: 200 parts to test up the element's ancestors
let moveFrame = 0, moveTarget = null;
function onMove(e) {
  moveTarget = e.target;
  if (!moveFrame) moveFrame = requestAnimationFrame(() => { moveFrame = 0; trackHover(moveTarget); });
}
function trackHover(target) {
  if (!picking || !target || target.closest?.(".cz-ui")) return;
  const hit = partFor(target);
  picking.current = hit;
  if (!hit) {
    picking.box.style.display = "none";
    picking.label.style.display = "none";
    return;
  }
  outline(picking.box, picking.label, hit.node, `${hit.part.name} · ${hit.part.group}`);
}

function onBlock(e) {
  if (!picking || e.target.closest?.(".cz-ui")) return; // our own bar's Done button works normally
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  if (e.type !== "click") return;
  const hit = partFor(e.target);
  if (!hit) {
    flashBar("That spot isn't customizable yet. Try a nearby area.");
    return;
  }
  stopPicking();
  openEditor(hit.part.id, hit.node);
}

function flashBar(text) {
  const t = picking?.bar.querySelector(".cz-bar-text");
  if (!t) return;
  t.textContent = text;
  clearTimeout(flashBar.timer);
  flashBar.timer = setTimeout(() => { if (t.isConnected) t.textContent = "Click any part of Mosaic to customize it"; }, 2200);
}

// ---- the editor ----
let editor = null; // { root, partId, popEscape, box, node }
export function closeEditor() {
  if (!editor) return;
  editor.root.remove();
  editor.box?.remove();
  editor.popEscape?.();
  editor = null;
}

const LABELS = { bg: "Background", text: "Text", border: "Border", accent: "Accent", glow: "Glow" };
const HINTS = {
  bg: "Fill behind it.",
  text: "Its text, and the text of everything inside it.",
  border: "Its outline and dividers.",
  accent: "Buttons, highlights and the seek bar inside it.",
  glow: "The color of its glow and highlight effects.",
};

// node: the element that was picked (to keep it outlined while you edit); null opens it in the middle
export function openEditor(partId, node = null) {
  closeEditor();
  const part = partById(partId);
  if (!part) return;
  const root = el("div", "cz-ui cz-editor");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `Customize ${part.name}`);
  const head = el("div", "cz-head");
  const title = el("div", "cz-title");
  title.append(el("div", "cz-name", part.name), el("div", "cz-group", part.group));
  const close = el("button", "cz-icon-btn");
  close.type = "button";
  close.title = "Close";
  close.innerHTML = ICON('<path d="M18 6 6 18M6 6l12 12"/>');
  close.addEventListener("click", () => { closeEditor(); onDone?.(); });
  head.append(title, close);
  const body = el("div", "cz-body");
  root.append(head, body);

  const cur = () => customParts()[part.id] || {};
  const current = (key) => {
    const v = cur()[key];
    if (isHex(v)) return v;
    // nothing set: start the picker from what it looks like now
    const target = node || document.querySelector(part.sel);
    if (!target) return "#808080";
    const cs = getComputedStyle(target);
    if (key === "bg") {
      // a see-through part shows what's behind it: the first parent with a real background
      for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
        const h = toHex(getComputedStyle(n).backgroundColor);
        if (h) return h;
      }
      return "#808080";
    }
    const raw = key === "text" ? cs.color : key === "border" ? cs.borderTopColor
      : (key === "glow" && cs.getPropertyValue("--hype-color").trim()) || cs.getPropertyValue("--m-accent").trim();
    return toHex(raw) || "#808080";
  };

  for (const key of ["glow", "bg", "text", "border", "accent"]) {
    if (!part.ctl.includes(key)) continue;
    const row = el("div", "cz-row");
    const txt = el("div", "cz-row-text");
    txt.append(el("div", "cz-row-title", LABELS[key]), el("div", "cz-row-hint", HINTS[key]));
    const ctl = el("div", "cz-row-ctl");
    const hex = el("span", "cz-hex");
    const input = el("input", "cz-color");
    input.type = "color";
    const reset = el("button", "cz-icon-btn cz-reset");
    reset.type = "button";
    reset.title = "Back to normal";
    reset.innerHTML = ICON('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', 13);
    const sync = () => {
      const set = isHex(cur()[key]);
      if (document.activeElement !== input) input.value = current(key);
      hex.textContent = set ? cur()[key].toUpperCase() : "Default";
      row.classList.toggle("set", set);
    };
    let t = null;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { setPart(part.id, { [key]: input.value.toLowerCase() }); sync(); }, 30); });
    input.addEventListener("change", () => { clearTimeout(t); setPart(part.id, { [key]: input.value.toLowerCase() }); sync(); });
    reset.addEventListener("click", () => { setPart(part.id, { [key]: null }); sync(); });
    ctl.append(hex, input, reset);
    row.append(txt, ctl);
    body.appendChild(row);
    sync();
  }

  if (part.ctl.includes("size")) body.appendChild(segRow("Size", "size", SIZE_OPTIONS));
  if (part.ctl.includes("radius")) {
    const row = el("div", "cz-row cz-row-stack");
    const txt = el("div", "cz-row-text");
    txt.append(el("div", "cz-row-title", "Corners"));
    const seg = el("div", "cz-seg");
    const sync = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", String(cur().radius ?? null) === b.dataset.v));
    for (const o of RADIUS_OPTIONS) {
      const b = el("button", "cz-seg-btn", o.label);
      b.type = "button";
      b.dataset.v = String(o.value);
      b.addEventListener("click", () => { setPart(part.id, { radius: o.value }); sync(); });
      seg.appendChild(b);
    }
    row.append(txt, seg);
    body.appendChild(row);
    sync();
  }

  function segRow(title, key, options) {
    const row = el("div", "cz-row cz-row-stack");
    const txt = el("div", "cz-row-text");
    txt.append(el("div", "cz-row-title", title));
    const seg = el("div", "cz-seg");
    const sync = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", String(cur()[key] ?? null) === b.dataset.v));
    for (const o of options) {
      const b = el("button", "cz-seg-btn", o.label);
      b.type = "button";
      b.dataset.v = String(o.value);
      b.addEventListener("click", () => { setPart(part.id, { [key]: o.value }); sync(); });
      seg.appendChild(b);
    }
    row.append(txt, seg);
    sync();
    return row;
  }

  if (part.ctl.includes("hide")) {
    const row = el("div", "cz-row");
    const txt = el("div", "cz-row-text");
    txt.append(el("div", "cz-row-title", "Hide it"), el("div", "cz-row-hint", "Take it off the screen. Turn this off here or in Settings › Appearance to bring it back."));
    const sw = el("button", "settings-switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.appendChild(el("span", "settings-switch-knob"));
    const sync = () => { sw.classList.toggle("on", !!cur().hidden); sw.setAttribute("aria-checked", String(!!cur().hidden)); };
    sw.addEventListener("click", () => { setPart(part.id, { hidden: !cur().hidden }); sync(); });
    row.append(txt, sw);
    body.appendChild(row);
    sync();
  }

  const foot = el("div", "cz-foot");
  const resetAll = el("button", "cz-btn subtle", "Reset part");
  resetAll.type = "button";
  resetAll.addEventListener("click", () => { resetPart(part.id); openEditor(part.id, node); });
  const again = el("button", "cz-btn", "Pick another");
  again.type = "button";
  again.addEventListener("click", () => { closeEditor(); startPicking(); });
  const done = el("button", "cz-btn primary", "Done");
  done.type = "button";
  done.addEventListener("click", () => { closeEditor(); onDone?.(); });
  foot.append(resetAll, el("span", "cz-spacer"), again, done);
  root.appendChild(foot);

  document.body.appendChild(root);
  // keep the part outlined while its editor is open (if it's on screen)
  let box = null;
  if (node && node.isConnected) {
    box = el("div", "cz-ui cz-box cz-box-steady");
    document.body.appendChild(box);
    const r = node.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px`, display: "block" });
  }
  placeEditor(root, node);
  editor = { root, partId: part.id, box, popEscape: pushEscape(() => { closeEditor(); onDone?.(); }) };
  makeDraggable(root, head);
}

// beside the picked part when there's room, otherwise in the middle of the window
function placeEditor(root, node) {
  const w = root.offsetWidth, h = root.offsetHeight, pad = 12;
  let left = (window.innerWidth - w) / 2, top = (window.innerHeight - h) / 2;
  if (node && node.isConnected) {
    const r = node.getBoundingClientRect();
    if (r.right + pad + w < window.innerWidth) left = r.right + pad;
    else if (r.left - pad - w > 0) left = r.left - pad - w;
    top = Math.min(Math.max(pad, r.top), window.innerHeight - h - pad);
  }
  root.style.left = `${Math.max(pad, left)}px`;
  root.style.top = `${Math.max(pad, top)}px`;
}

function makeDraggable(root, handle) {
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    const sx = e.clientX, sy = e.clientY, ox = root.offsetLeft, oy = root.offsetTop;
    const move = (m) => {
      root.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, ox + m.clientX - sx))}px`;
      root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, oy + m.clientY - sy))}px`;
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });
}

// "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" / "#abc" -> "#rrggbb" (null for transparent or unreadable)
function toHex(v) {
  if (!v) return null;
  v = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("").toLowerCase();
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return null;
  const [r, g, b, a = "1"] = m[1].split(/[,\s/]+/).filter(Boolean);
  if (Number(a) === 0) return null;
  return "#" + [r, g, b].map((x) => Math.round(Number(x)).toString(16).padStart(2, "0")).join("");
}
