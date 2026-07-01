// chrome-core — the shared sidebar chrome for curator and warden.
//
// Framework-free: exposes a global `ChromeSidebar` factory (browser) and CommonJS exports (the
// factory + the pure helpers, for node:test). The component is a VIEW: it renders a window DTO into
// a mount container and reports user intent via callbacks. Divergence between the two apps lives in
// their thin controllers (callback → Tauri command, event → setter), never here.
//
// See CLAUDE.md for the interface contract (DTO, callbacks, methods, the fixed dot-slot order).

// ─────────────────────────── pure helpers (unit-tested) ───────────────────────────

/** First alphanumeric of a string, uppercased — the letter on a tab's tile. `•` fallback. */
function tileInitial(s) {
  const m = (s || "").match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "•";
}

/** Deterministic tile colour hashed from the title (stable per project). */
function tileColour(seed) {
  let h = 0;
  const str = seed || "";
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return "hsl(" + (h % 360) + ", 45%, 45%)";
}

/** Parse a #rgb / #rrggbb hex into [r,g,b]. */
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}

/** Blend a hex colour over an opaque base at `ratio`, returning an OPAQUE rgb(...) — the sidebar
 *  must never carry alpha (a transparent window would leak the wallpaper through the chrome). */
function tintOverBase(hex, ratio, base) {
  const b = base || SIDEBAR_BASE;
  const c = hexToRgb(hex);
  const ch = (i) => Math.round(b[i] * (1 - ratio) + c[i] * ratio);
  return "rgb(" + ch(0) + "," + ch(1) + "," + ch(2) + ")";
}

/** Clamp a desired sidebar width into [min, min(max, fraction*windowWidth)]. */
function clampWidth(w, { min, max, fraction, windowWidth }) {
  const upper = Math.min(max, windowWidth * fraction);
  return Math.max(min, Math.min(w, upper));
}

/** Resolve a cycle step among `ids` from `active` in direction `dir` (±1), with wraparound. An
 *  unknown active steps in from the end opposite the direction of travel. Null when `ids` is empty. */
function resolveOffset(ids, active, dir) {
  if (!ids.length) return null;
  const cur = ids.indexOf(active);
  const base = cur === -1 ? (dir > 0 ? -1 : 0) : cur;
  return ids[(base + dir + ids.length) % ids.length];
}

/** Opaque dark base the sidebar tint composites over (matches the CSS `.cc-root` fallback). */
const SIDEBAR_BASE = [21, 25, 30]; // #15191e
const NEUTRAL_COLOUR = "#6b7280";

// ─────────────────────────── the component ───────────────────────────

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (text != null) node.textContent = text;
  return node;
}

class Sidebar {
  constructor(container, callbacks, config) {
    this.root = container;
    this.cb = callbacks || {};
    this.cfg = Object.assign(
      { header: null, minWidth: 120, maxWidth: 400, maxFraction: 0.4, defaultWidth: 240 },
      config || {}
    );
    this.active = null;
    this.armedKill = null;
    this.windowColour = NEUTRAL_COLOUR;
    this.tabs = [];
    this._lastWidth = 0;
    this._buildShell();
    this._initResize();
    this._restoreWidth();
  }

  _buildShell() {
    this.root.classList.add("cc-root");
    this.root.innerHTML = "";
    this.banner = el("div", { id: "cc-banner" });
    if (this.cfg.header) this.banner.appendChild(this.cfg.header);
    this.nameEl = el("span", { class: "cc-name" });
    this.banner.appendChild(this.nameEl);
    this.errorBar = el("div", { id: "cc-error" });
    this.list = el("div", { id: "cc-tab-list" });
    this.resizeEl = el("div", { id: "cc-resize" });
    this.root.append(this.banner, this.errorBar, this.list, this.resizeEl);
  }

  // ── rendering ──

  /** Full render from a window DTO. The one render path (init + hot-reload). */
  update(dto) {
    this._disarmKill();
    const prevActive = this.active;
    this.windowColour = dto.colour || NEUTRAL_COLOUR;
    this.tabs = dto.tabs || [];
    document.documentElement.setAttribute("data-density", dto.density || "comfortable");

    this.nameEl.textContent = dto.title || "";
    this.banner.style.background = this.windowColour;
    const tint = tintOverBase(this.windowColour, 0.12);
    this.root.style.background = tint;
    this.root.style.setProperty("--cc-active-bg", tintOverBase(this.windowColour, 0.28));

    this.list.innerHTML = "";
    let lastGroup;
    for (const t of this.tabs) {
      const g = t.group == null ? null : t.group;
      if (g !== lastGroup && g !== null) {
        const h = el("div", { class: "cc-group" }, g);
        h.style.background = tint; // sticky header matches the tinted sidebar
        this.list.appendChild(h);
      }
      lastGroup = g;
      this.list.appendChild(this._renderRow(t));
    }

    // Active selection has two ownership models. When the DTO carries `active`, the APP owns it
    // (curator: its Rust side is authoritative via get_tabs) — honour it and do NOT fire onSelect.
    // When `active` is absent, the COMPONENT owns it (warden): preserve the current selection, fall
    // back to the first tab if it vanished, and fire onSelect so the app activates the fallback.
    if (dto.active !== undefined) {
      this.active = dto.active;
      this._paint();
    } else {
      if (!this.tabs.find((t) => t.id === this.active)) {
        this.active = this.tabs.length ? this.tabs[0].id : null;
      }
      this._paint();
      if (this.active && this.active !== prevActive && this.cb.onSelect) {
        this.cb.onSelect(this.active, { wasActive: false });
      }
    }
  }

  _renderRow(t) {
    const row = el("div", { class: "cc-tab", "data-id": t.id });
    row.addEventListener("click", () => this.select(t.id));

    const icon = el("span", { class: "cc-icon" }, tileInitial(t.title));
    icon.style.background = tileColour(t.title);
    row.appendChild(icon);

    row.appendChild(el("span", { class: "cc-title" }, (t.title || "") + (t.warn ? "  ⚠" : "")));

    // Attention slot (amber; count pill when a number). Absent when null.
    if (t.attention != null) row.appendChild(this._makeAttention(t.attention));

    // Presence slot (cyan; warden probe). Absent when null. Clickable when killable + on.
    if (t.presence != null) row.appendChild(this._makePresence(t, t.presence));

    // Live/unload slot (green live ↔ hover-✕ / hollow cold). Always present.
    const dot = this._makeDot(t.live);
    dot.addEventListener("click", (e) => {
      if (!dot.classList.contains("live")) return; // cold: nothing to unload
      e.stopPropagation();
      if (this.cb.onUnload) this.cb.onUnload(t.id);
    });
    row.appendChild(dot);

    // Kill-confirm controls (only for killable rows; hidden until `.confirming`).
    if (t.killable) this._appendConfirmControls(row, t.id);
    return row;
  }

  _makeAttention(val) {
    const a = el("span", { class: "cc-attention" });
    if (typeof val === "number") {
      a.classList.add("cc-count");
      a.textContent = String(val);
    }
    return a;
  }

  _makePresence(t, state) {
    const s = el("span");
    this._paintPresence(s, t.id, state, !!t.killable);
    if (t.killable) {
      s.addEventListener("click", (e) => {
        if (!s.classList.contains("on")) return; // no session ⇒ nothing to kill
        e.stopPropagation();
        this._armKill(t.id, s.closest(".cc-tab"));
      });
    }
    return s;
  }

  _paintPresence(span, id, state, killable) {
    let cls = "cc-presence " + (state === "on" ? "on" : "off");
    if (state === "on" && killable) cls += " kill";
    span.className = cls;
    span.dataset.kill = killable ? "1" : "";
  }

  _makeDot(live) {
    const dot = el("span");
    this._paintDot(dot, live);
    return dot;
  }

  _paintDot(dot, live) {
    dot.className = "cc-dot " + (live ? "live" : "cold");
    dot.title = live ? "Unload" : "";
  }

  _appendConfirmControls(row, id) {
    const kill = el("span", { class: "cc-confirm-kill", title: "terminate session" }, "⏻");
    kill.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.classList.contains("killing")) return;
      const armed = this.armedKill;
      if (!armed) {
        this._disarmKill();
        return;
      }
      if (this.cb.onKill) this.cb.onKill(armed);
      row.classList.add("killing");
      const finish = () => {
        row.removeEventListener("animationend", finish);
        row.classList.remove("killing");
        if (this.armedKill === armed) this._disarmKill();
      };
      row.addEventListener("animationend", finish);
      setTimeout(finish, 250); // fallback if animationend doesn't fire
    });
    const cancel = el("span", { class: "cc-confirm-cancel", title: "cancel" }, "↩︎");
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      this._disarmKill();
    });
    row.append(kill, cancel);
  }

  _rowById(id) {
    return this.list.querySelector('.cc-tab[data-id="' + (window.CSS ? CSS.escape(id) : id) + '"]');
  }

  _paint() {
    for (const row of this.list.querySelectorAll(".cc-tab")) {
      const isActive = row.dataset.id === this.active;
      row.classList.toggle("active", isActive);
      row.style.background = isActive ? tintOverBase(this.windowColour, 0.28) : "";
      // The active tab always has a live surface (selecting it activates/creates it), so upgrade its
      // dot to live even if the last DTO snapshot caught it cold. Without this the loaded dot never
      // fills after a lazy select, and the unload ✕ (gated on .live) can never fire.
      if (isActive) {
        const dot = row.querySelector(".cc-dot");
        if (dot) this._paintDot(dot, true);
      }
    }
  }

  // ── selection ──

  /** Select a tab by id: move the highlight optimistically and fire onSelect (the app activates).
   *  `wasActive` lets curator snap an already-active tab home. Used by clicks, keyboard nav, and the
   *  notification focus path. */
  select(id) {
    this._disarmKill();
    const wasActive = this.active === id;
    this.active = id;
    this._paint();
    if (this.cb.onSelect) this.cb.onSelect(id, { wasActive });
  }

  /** Move the highlight to `id` WITHOUT firing onSelect — for reflecting app-side state the app
   *  already actioned (e.g. the neighbour it activated after an unload). */
  setActive(id) {
    this._disarmKill(); // a non-DOM path (⌘W) can land here with a background row still armed
    this.active = id;
    this._paint();
  }

  /** Cycle prev/next → onSelect. `liveOnly` restricts to rows whose live dot is filled (warden skips
   *  cold tabs; curator passes liveOnly:false). */
  selectByOffset(dir, opts) {
    const liveOnly = opts && opts.liveOnly;
    const rows = [...this.list.querySelectorAll(".cc-tab")].filter(
      (r) => !liveOnly || r.querySelector(".cc-dot.live")
    );
    const ids = rows.map((r) => r.dataset.id);
    if (ids.length < 2) return; // cycling needs ≥2 (eligible) tabs; 1 tab is a no-op, not a self-select
    const next = resolveOffset(ids, this.active, dir < 0 ? -1 : 1);
    if (next != null) this.select(next);
  }

  /** Jump to the 1-based position `n` → onSelect. No-op past the last tab. */
  selectByIndex(n) {
    const ids = [...this.list.querySelectorAll(".cc-tab")].map((r) => r.dataset.id);
    if (n >= 1 && n <= ids.length) this.select(ids[n - 1]);
  }

  // ── targeted setters (patch a hot signal without a full re-render) ──

  setLive(id, live) {
    const dot = this._rowById(id)?.querySelector(".cc-dot");
    if (dot) this._paintDot(dot, live);
  }

  setAttention(id, val) {
    const row = this._rowById(id);
    if (!row) return;
    let a = row.querySelector(".cc-attention");
    if (val == null) {
      if (a) a.remove();
      return;
    }
    if (!a) {
      a = this._makeAttention(val);
      // keep order [attention][presence][live]: insert before presence if present, else the dot
      row.insertBefore(a, row.querySelector(".cc-presence") || row.querySelector(".cc-dot"));
    } else {
      const fresh = this._makeAttention(val);
      a.className = fresh.className;
      a.textContent = fresh.textContent;
    }
  }

  setPresence(id, state) {
    const row = this._rowById(id);
    if (!row) return;
    let s = row.querySelector(".cc-presence");
    if (state == null) {
      if (s) s.remove();
      if (this.armedKill === id) this._disarmKill();
      return;
    }
    const killable = s ? s.dataset.kill === "1" : false;
    if (!s) {
      const t = this.tabs.find((x) => x.id === id) || {};
      s = this._makePresence(t, state);
      row.insertBefore(s, row.querySelector(".cc-dot"));
    } else {
      this._paintPresence(s, id, state, killable);
    }
    if (state !== "on" && this.armedKill === id) this._disarmKill(); // session gone → nothing to kill
  }

  // ── kill-confirm state machine ──

  _armKill(id, rowEl) {
    if (!rowEl || this.armedKill === id) return;
    this._disarmKill();
    this.armedKill = id;
    rowEl.classList.add("confirming");
    this._onArmKey = (e) => {
      if (e.key === "Escape") this._disarmKill();
    };
    this._onArmOutside = (e) => {
      if (!this.armedKill) return;
      const row = this._rowById(this.armedKill);
      if (row && row.contains(e.target)) return; // inside the armed row → its ⏻/↩ handle it
      this._disarmKill();
    };
    document.addEventListener("keydown", this._onArmKey);
    document.addEventListener("click", this._onArmOutside, true);
  }

  _disarmKill() {
    const prev = this.armedKill;
    this.armedKill = null;
    if (this._onArmKey) document.removeEventListener("keydown", this._onArmKey);
    if (this._onArmOutside) document.removeEventListener("click", this._onArmOutside, true);
    this._onArmKey = this._onArmOutside = null;
    if (prev) {
      const row = this._rowById(prev);
      if (row) row.classList.remove("confirming");
    }
  }

  // ── error bar ──

  setError(msg) {
    this.errorBar.textContent = msg;
    this.errorBar.style.display = "block";
  }
  clearError() {
    this.errorBar.style.display = "none";
  }

  // ── resize ──

  _clamp(w) {
    return clampWidth(w, {
      min: this.cfg.minWidth,
      max: this.cfg.maxWidth,
      fraction: this.cfg.maxFraction,
      windowWidth: window.innerWidth,
    });
  }
  _emitResize(w) {
    const cw = this._clamp(w);
    this._lastWidth = cw;
    if (this.cb.onResize) this.cb.onResize(cw);
  }
  _persistWidth(w) {
    if (this.cfg.storageKey && w > 0) localStorage.setItem(this.cfg.storageKey, String(Math.round(w)));
  }
  _restoreWidth() {
    if (!this.cfg.storageKey) return;
    const s = parseInt(localStorage.getItem(this.cfg.storageKey), 10);
    if (Number.isFinite(s)) this._emitResize(s);
  }
  _initResize() {
    const handle = this.resizeEl;
    let startX = 0, startW = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      // Released over a native surface (warden) never reaches us → unstick when no button is held.
      if (e.buttons === 0) { end(); return; }
      this._emitResize(startW + (e.clientX - startX));
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", end);
      document.body.style.cursor = "";
      this._persistWidth(this._lastWidth);
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startW = this.root.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", end);
      window.addEventListener("blur", end);
    });
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._emitResize(this.cfg.defaultWidth);
      this._persistWidth(this.cfg.defaultWidth);
    });
  }
}

const ChromeSidebar = {
  /** Mount the sidebar into `container`; returns the instance (see CLAUDE.md for the method set). */
  mount(container, callbacks, config) {
    return new Sidebar(container, callbacks, config);
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ChromeSidebar, tileInitial, tileColour, hexToRgb, tintOverBase, clampWidth, resolveOffset };
}
if (typeof window !== "undefined") {
  window.ChromeSidebar = ChromeSidebar;
}
