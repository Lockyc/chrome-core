// chrome-core — the shared sidebar chrome for curator and warden.
//
// Framework-free: exposes a global `ChromeSidebar` factory (browser) and CommonJS exports (the
// factory + the pure helpers, for node:test). The component renders a window DTO into a mount
// container and reports user intent via callbacks — and it also owns app-agnostic capabilities
// shared by every consuming app (self-update: check/install/relaunch + the re-check cadence),
// feature-detecting the Tauri runtime so the isolated preview.html no-ops. Only app-*type*-specific
// divergence lives in the thin per-app controllers (callback → Tauri command, event → setter),
// never here. See CLAUDE.md's dividing-line decision.
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

/** Clamp a desired sidebar width into [min, min(max, fraction*windowWidth)]. `fraction` caps the
 *  sidebar at a share of the window, but is only meaningful when `windowWidth` (the sidebar view's
 *  own `window.innerWidth`) IS the host window's width — i.e. the sidebar is the window's full-size
 *  main webview. Both current consumers are hole-punch main webviews (curator + warden), so both
 *  pass a real `fraction`. A consumer whose sidebar were instead an isolated child webview —
 *  `innerWidth` being just the sidebar's own width — would see this cap collapse below `min` and pin
 *  every drag to the floor; it passes a falsy `fraction` to skip the cap here and enforce its
 *  share-of-window limit backend-side. */
function clampWidth(w, { min, max, fraction, windowWidth }) {
  const upper = fraction ? Math.min(max, windowWidth * fraction) : max;
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

/** Class list for a presence dot given session state + capabilities. Three states:
 *  `on` = a probe reported a live session → a kill affordance when `killable`;
 *  `ghost` = no live session, but the host reports a *recoverable* one (warden: a crashed amux
 *  session a plain launch would offer to restore) → decoration on the same start affordance;
 *  `off` = configured-but-absent.
 *  `on` and `ghost` are mutually exclusive. The *start* affordance (re-run the tab's command) is
 *  offered for BOTH non-`on` states, and only when `startable` AND the tab is `live` — a cold tab
 *  has no shell to type into, and is started by activating the row instead. `ghost` never gets a
 *  kill affordance: a recoverable drop is on a dead server, so there is nothing to kill. */
function presenceClass(state, killable, startable, live) {
  const on = state === "on";
  const ghost = state === "ghost";
  let cls = "cc-presence " + (on ? "on" : ghost ? "ghost" : "off");
  if (on && killable) cls += " kill";
  if (!on && startable && live) cls += " start";
  return cls;
}

/** Re-derive a dot's presence state ("on" | "ghost" | "off") from its painted class list — the
 *  inverse of `presenceClass`'s state→class mapping, used to repaint a dot (e.g. on a live-state
 *  change) without re-fetching the session state that produced it. Pure — takes a plain array of
 *  class names, not a live classList, so it's testable with no DOM (a caller with a DOMTokenList
 *  passes `Array.from(el.classList)`). Must check BOTH `on` and `ghost`: reading only `on` would
 *  collapse a ghost back to `off` on every repaint, silently losing the recoverable signal. */
function derivePresenceState(classNames) {
  return classNames.includes("on") ? "on" : classNames.includes("ghost") ? "ghost" : "off";
}

/** Opaque dark base the sidebar tint composites over (matches the CSS `.cc-root` fallback). */
const SIDEBAR_BASE = [21, 25, 30]; // #15191e
const NEUTRAL_COLOUR = "#6b7280";

/** Build a nested folder tree from flat rows carrying `treePath` segment arrays.
 *  Single-child folder chains are compressed (label joined with "/"). Pure — tested. */
function buildTree(rows) {
  const root = { label: "", folders: new Map(), rows: [] };
  for (const r of rows) {
    let node = root;
    for (const seg of r.treePath || []) {
      if (!node.folders.has(seg)) node.folders.set(seg, { label: seg, folders: new Map(), rows: [] });
      node = node.folders.get(seg);
    }
    node.rows.push(r);
  }
  const compress = (node) => {
    let folders = [...node.folders.values()].map(compress);
    // compress a chain: exactly one child folder, no rows here → merge labels
    let self = { label: node.label, folders, rows: node.rows };
    while (self.rows.length === 0 && self.folders.length === 1) {
      const only = self.folders[0];
      self = {
        label: self.label ? `${self.label}/${only.label}` : only.label,
        folders: only.folders,
        rows: only.rows,
      };
    }
    return self;
  };
  // Compress each top-level folder's internal single-child chains, but never
  // merge the anonymous root itself — otherwise a root with one top-level folder
  // would drop that folder's label and surface its projects unnested.
  const folders = [...root.folders.values()].map(compress);
  return { folders, rows: root.rows };
}

// ─────────────────────────── the component ───────────────────────────

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (text != null) node.textContent = text;
  return node;
}

// Self-update re-check cadence: a long-running window re-checks this often so a release surfaces
// without a restart (the single home for the interval, shared by every consuming app).
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

class Sidebar {
  constructor(container, callbacks, config) {
    this.root = container;
    this.cb = callbacks || {};
    this.cfg = Object.assign(
      { header: null, appName: null, minWidth: 120, maxWidth: 400, maxFraction: 0.4, defaultWidth: 240, autoUpdate: false },
      config || {}
    );
    this.active = null;
    this.armedKill = null;
    this.windowColour = NEUTRAL_COLOUR;
    this.tabs = [];
    this._lastWidth = 0;
    // Self-update state (see the "self-update" section): the pending Update from a successful check,
    // a per-session dismissal flag, and the recurring-check timer handle.
    this._pendingUpdate = null;
    this._updateDismissed = false;
    this._updateTimer = null;
    this._buildShell();
    this._initResize();
    this._restoreWidth();
    this._startUpdater();
  }

  _buildShell() {
    this.root.classList.add("cc-root");
    this.root.innerHTML = "";
    // The traffic-light strip. Only exists when the consumer names itself — a host without an
    // appName (preview.html) renders exactly as before, so the field is purely additive.
    this.titlebarEl = this.cfg.appName ? el("div", { id: "cc-titlebar" }) : null;
    if (this.titlebarEl) this.titlebarEl.textContent = this.cfg.appName;
    this.banner = el("div", { id: "cc-banner" });
    if (this.cfg.header) this.banner.appendChild(this.cfg.header);
    this.nameEl = el("span", { class: "cc-name" });
    this.banner.appendChild(this.nameEl);
    this.errorBar = el("div", { id: "cc-error" });
    // Error text + a dismiss (×) button, so any surfaced error (config, update-check, …) can be
    // cleared by the user rather than lingering until something else clears it.
    this._errorText = el("span", { id: "cc-error-text" });
    this._errorClose = el("button", { id: "cc-error-close", "aria-label": "Dismiss" });
    this._errorClose.textContent = "×";
    this._errorClose.addEventListener("click", () => this.clearError());
    this.errorBar.append(this._errorText, this._errorClose);
    // Update bar: shown by setUpdate() when the component's own updater finds a newer release
    // (self-update is a core-owned capability — see the "self-update" section). Clicking the button
    // downloads/installs/relaunches; the × dismisses for the session.
    this.updateBar = el("div", { id: "cc-update" });
    this._updateText = el("span", { id: "cc-update-text" });
    this._updateBtn = el("button", { id: "cc-update-btn" });
    this._updateBtn.textContent = "Update & Relaunch";
    this._updateBtn.addEventListener("click", () => {
      // Immediate feedback: the download/install/relaunch takes a beat, so reflect the working state.
      this._updateBtn.disabled = true;
      this._updateBtn.textContent = "Updating…";
      this._installUpdate();
    });
    // Dismiss (×): hide the update bar and suppress auto re-surfacing for the session (in-memory, so
    // it resets next launch; the menu check clears it and re-surfaces).
    this._updateClose = el("button", { id: "cc-update-close", "aria-label": "Dismiss" });
    this._updateClose.textContent = "×";
    this._updateClose.addEventListener("click", () => {
      this.clearUpdate();
      this._updateDismissed = true;
    });
    this.updateBar.append(this._updateText, this._updateBtn, this._updateClose);
    this.list = el("div", { id: "cc-tab-list" });
    this.resizeEl = el("div", { id: "cc-resize" });
    if (this.titlebarEl) this.root.append(this.titlebarEl);
    this.root.append(this.banner, this.errorBar, this.updateBar, this.list, this.resizeEl);
  }

  // ── rendering ──

  /** Toggle the Tauri window-drag attribute on a non-interactive chrome node (see `update`). */
  _setDrag(node, on) {
    if (on) node.setAttribute("data-tauri-drag-region", "");
    else node.removeAttribute("data-tauri-drag-region");
  }

  /** Full render from a window DTO. The one render path (init + hot-reload). */
  update(dto) {
    this._disarmKill();
    const prevActive = this.active;
    this.windowColour = dto.colour || NEUTRAL_COLOUR;
    this.tabs = dto.tabs || [];
    document.documentElement.setAttribute("data-density", dto.density || "comfortable");

    this.nameEl.textContent = dto.title || "";
    this.banner.style.background = this.windowColour;
    if (this.titlebarEl) this.titlebarEl.style.background = this.windowColour;
    const tint = tintOverBase(this.windowColour, 0.12);
    this.root.style.background = tint;
    this.root.style.setProperty("--cc-active-bg", tintOverBase(this.windowColour, 0.28));

    // Window-move drag surface. Unless `windowDrag` is explicitly false, the NON-interactive chrome
    // (banner, name, the list container's empty area, group headers) carries `data-tauri-drag-region`
    // so a drag on it moves the host window (macOS: double-click zooms) — Tauri drags only when the
    // mousedown TARGET itself has the attribute, so interactive descendants (rows, dots, buttons, the
    // resize handle) stay attribute-free and clickable. Defaults ON when the field is absent (standard
    // macOS sidebar behaviour); a consumer opts out with `windowDrag: false`. warden drives it from
    // its `sidebar_drag` config. Applied every render so a hot-reload toggle takes effect; group
    // headers get it in the loop below.
    const drag = dto.windowDrag !== false;
    if (this.titlebarEl) this._setDrag(this.titlebarEl, drag);
    this._setDrag(this.banner, drag);
    this._setDrag(this.nameEl, drag);
    this._setDrag(this.list, drag);

    this.list.innerHTML = "";
    let lastGroup;
    let i = 0;
    while (i < this.tabs.length) {
      const t = this.tabs[i];
      const g = t.group == null ? null : t.group;
      // A run of consecutive tabs sharing a group whose rows are `tree: true` is a project-tree
      // (root) section — rendered as a collapsible folder tree instead of flat rows.
      if (g !== null && t.tree) {
        const start = i;
        while (i < this.tabs.length && (this.tabs[i].group == null ? null : this.tabs[i].group) === g) i++;
        this._renderTreeSection(g, this.tabs.slice(start, i), tint, drag);
        lastGroup = g;
        continue;
      }
      if (g !== lastGroup && g !== null) {
        const h = el("div", { class: "cc-group" }, g);
        h.style.background = tint; // sticky header matches the tinted sidebar
        this._setDrag(h, drag);
        this.list.appendChild(h);
      }
      lastGroup = g;
      this.list.appendChild(this._renderRow(t));
      i++;
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

  // ── project-tree sections (a group whose rows are `tree: true`) ──

  /** Render a tree-head (group label + rescan control) followed by the nested folder body for one
   *  contiguous run of `tree: true` rows sharing `group`. Empty runs never reach here (they simply
   *  wouldn't exist as tabs), but `buildTree` on zero rows is handled defensively. */
  _renderTreeSection(group, rows, tint, drag) {
    const head = el("div", { class: "cc-group cc-tree-head" });
    head.style.background = tint;
    this._setDrag(head, drag);
    head.appendChild(el("span", { class: "cc-tree-label" }, group));
    const rescan = el("button", { class: "cc-rescan", type: "button", title: "Rescan" }, "⟳");
    rescan.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.cb.onRescan) this.cb.onRescan(group);
    });
    head.appendChild(rescan);
    this.list.appendChild(head);

    const body = el("div", { class: "cc-tree-body" });
    this.list.appendChild(body);

    const tree = buildTree(rows);
    const repaint = () => {
      body.innerHTML = "";
      if (!tree.folders.length && !tree.rows.length) {
        body.appendChild(el("div", { class: "cc-tree-empty" }, "No projects found"));
        return;
      }
      this._paintTreeNode(body, tree, group, [], 0, repaint);
    };
    repaint();
  }

  /** Recursively paint one tree node's rows + child folders into `container`. `pathSegs` is the
   *  folder-label chain down to (not including) this node, used to build each folder's persisted
   *  collapse-state key. `repaint` re-runs the whole section's paint from scratch on toggle — trees
   *  are small (config-scale), so a full repaint is simpler and cheap versus DOM-patching visibility. */
  _paintTreeNode(container, node, group, pathSegs, depth, repaint) {
    for (const t of node.rows) {
      const row = this._renderRow(t);
      row.classList.add("cc-tree-row");
      row.style.setProperty("--cc-depth", String(depth));
      container.appendChild(row);
    }
    for (const folder of node.folders) {
      const segs = [...pathSegs, folder.label];
      const key = "cc-tree:" + (this.cfg.storageKey || "") + ":" + group + "/" + segs.join("/");
      const collapsed = this._treeCollapsed(key, depth);
      const row = el("div", { class: "cc-folder" });
      if (collapsed) row.setAttribute("data-collapsed", "");
      row.style.setProperty("--cc-depth", String(depth));
      row.appendChild(el("span", { class: "cc-chevron" }));
      row.appendChild(el("span", { class: "cc-folder-label" }, folder.label));
      row.addEventListener("click", () => {
        localStorage.setItem(key, collapsed ? "0" : "1");
        repaint();
      });
      container.appendChild(row);
      if (!collapsed) this._paintTreeNode(container, folder, group, segs, depth + 1, repaint);
    }
  }

  /** Persisted collapse state for a folder key. Default policy (no stored value yet): top level
   *  (depth 0) expanded, deeper folders (depth ≥ 1) collapsed. */
  _treeCollapsed(key, depth) {
    const v = localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
    return depth >= 1;
  }

  _renderRow(t) {
    const row = el("div", { class: "cc-tab", "data-id": t.id });
    if (t.detached) row.classList.add("detached");
    // Row click keeps its normal onSelect wiring even when detached — the app interprets
    // onSelect-on-a-detached-tab as "raise the popped-out window" (see CLAUDE.md). No new
    // callback: this IS the raise affordance.
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
    // A detached tab is ALWAYS live — it's running in its own popped-out window — so its dot
    // shows live regardless of `t.live` (which reports only a LOCAL surface). It is NOT an
    // unload affordance there, though: you don't unload a tab that lives in another window, you
    // raise that window — so the click stays unwired and falls through to the row's onSelect
    // (which the app maps to "raise the popped-out window").
    const dot = this._makeDot(t.detached || t.live);
    if (!t.detached) {
      dot.addEventListener("click", (e) => {
        if (!dot.classList.contains("live")) return; // cold: nothing to unload
        e.stopPropagation();
        if (this.cb.onUnload) this.cb.onUnload(t.id);
      });
    }
    row.appendChild(dot);

    // Pop-out affordance: opt-in per app (capability-by-callback-presence, like onKillClose).
    // Fires immediately on click (the tree-head rescan model), not the armed-kill state machine.
    // `!t.detached` guards against offering to pop out a tab already in its own window.
    if (this.cb.onPopOut && !t.detached) {
      const pop = el("span", { class: "cc-popout", title: "Pop out into its own window" }, "⤢");
      pop.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onPopOut(t.id);
      });
      row.appendChild(pop);
    }
    // Detached: a static (non-interactive) popped-out indicator in place of the pop-out control.
    // The row's own click → onSelect wiring above is unchanged — the app maps a click on a
    // detached row to "raise the popped-out window" (no new callback needed).
    if (t.detached) {
      const mark = el("span", { class: "cc-popout detached-mark" }, "⤢");
      mark.title = "Popped out — click the row to raise its window";
      row.appendChild(mark);
    }

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
    this._paintPresence(s, t.id, state, !!t.killable, !!t.startable, !!t.live);
    // The dot is a session toggle: click a present session to kill (2-step confirm), or click an
    // absent-but-startable one to restart (single click — non-destructive). Both are gated by the
    // painted classes (`.kill` / `.start`), so a click that matches neither is inert.
    if (t.killable || t.startable) {
      s.addEventListener("click", (e) => {
        if (s.classList.contains("kill")) {
          e.stopPropagation();
          this._armKill(t.id, s.closest(".cc-tab"));
        } else if (s.classList.contains("start")) {
          e.stopPropagation();
          if (this.cb.onStart) this.cb.onStart(t.id);
        }
      });
    }
    return s;
  }

  _paintPresence(span, id, state, killable, startable, live) {
    span.className = presenceClass(state, killable, startable, live);
    span.dataset.kill = killable ? "1" : "";
    span.dataset.start = startable ? "1" : "";
    span.title = span.classList.contains("kill")
      ? "Kill session"
      : span.classList.contains("ghost")
        ? span.classList.contains("start")
          ? "Crashed session — start to restore it"
          : "Crashed session — restorable"
        : span.classList.contains("start")
          ? "Start session"
          : "";
  }

  /** Re-evaluate a row's presence dot after a live-state change — the `start` affordance is gated on
   *  the tab being live, so unloading/loading must repaint it (kill/start classes read from dataset). */
  _refreshPresenceLive(row, live) {
    const s = row.querySelector(".cc-presence");
    if (!s) return;
    const state = derivePresenceState(Array.from(s.classList));
    this._paintPresence(s, row.dataset.id, state, s.dataset.kill === "1", s.dataset.start === "1", live);
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

  /** One armed-row confirm action (⏻ or ☠). They differ only in glyph + which callback fires, so
   *  the click contract lives here once: swallow the row click, ignore a re-click mid-animation,
   *  fire against the row that is actually armed, then press + pulse (~180ms) and disarm. */
  _makeConfirmControl(row, { cls, title, glyph, fire }) {
    const ctl = el("span", { class: cls, title }, glyph);
    ctl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.classList.contains("killing")) return;
      const armed = this.armedKill;
      if (!armed) {
        this._disarmKill();
        return;
      }
      fire(armed);
      row.classList.add("killing");
      ctl.classList.add("cc-pressed");
      const finish = () => {
        row.removeEventListener("animationend", finish);
        row.classList.remove("killing");
        ctl.classList.remove("cc-pressed");
        if (this.armedKill === armed) this._disarmKill();
      };
      row.addEventListener("animationend", finish);
      setTimeout(finish, 250); // fallback if animationend doesn't fire
    });
    return ctl;
  }

  _appendConfirmControls(row, id) {
    // Kill-both (☠) — terminate the session AND close the terminal. Opt-in: rendered only when the
    // app supplied `onKillClose` (curator supplies none, so its rows never grow one). It is a second
    // terminal action off the SAME armed row — no new arming path, no second state machine.
    if (this.cb.onKillClose) {
      row.append(
        this._makeConfirmControl(row, {
          cls: "cc-confirm-kill-close",
          title: "terminate session + close terminal",
          glyph: "☠",
          fire: (armed) => this.cb.onKillClose(armed),
        }),
      );
    }
    row.append(
      this._makeConfirmControl(row, {
        cls: "cc-confirm-kill",
        title: "terminate session",
        glyph: "⏻",
        fire: (armed) => {
          if (this.cb.onKill) this.cb.onKill(armed);
        },
      }),
    );
    const cancel = el("span", { class: "cc-confirm-cancel", title: "cancel" }, "↩︎");
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      this._disarmKill();
    });
    row.append(cancel);
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
        this._refreshPresenceLive(row, true); // active ⇒ live ⇒ its presence dot can offer start
      }
    }
  }

  // ── selection ──

  /** Select a tab by id: move the highlight optimistically and fire onSelect (the app activates).
   *  `wasActive` lets curator snap an already-active tab home. Used by clicks, keyboard nav, and the
   *  notification focus path. */
  select(id) {
    this._disarmKill();
    // A detached tab lives in its OWN window — selecting it means "raise that window" (the app's
    // onSelect), never "make it the shown tab in this window". So fire onSelect but do NOT move the
    // highlight: stealing the selection indicator here would leave it pointing at a tab that isn't
    // the terminal actually displayed in this window (the "clicking a popped-out tab steals the
    // sidebar focus indicator" bug). The highlight stays on whatever this window is really showing.
    const t = this.tabs.find((x) => x.id === id);
    if (t && t.detached) {
      if (this.cb.onSelect) this.cb.onSelect(id, { wasActive: false });
      return;
    }
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
    const row = this._rowById(id);
    if (!row) return;
    const dot = row.querySelector(".cc-dot");
    if (dot) this._paintDot(dot, live);
    this._refreshPresenceLive(row, live); // live gates the presence `start` affordance
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
    const startable = s ? s.dataset.start === "1" : false;
    const live = !!row.querySelector(".cc-dot.live");
    if (!s) {
      const t = this.tabs.find((x) => x.id === id) || {};
      s = this._makePresence(t, state);
      row.insertBefore(s, row.querySelector(".cc-dot"));
    } else {
      this._paintPresence(s, id, state, killable, startable, live);
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
    this._errorText.textContent = msg;
    this.errorBar.style.display = "flex";
  }
  clearError() {
    this.errorBar.style.display = "none";
  }

  // ── update bar (view) ──

  // Show the "update available" bar. `info.version` labels it. Public so a consumer *could* drive it
  // directly, but normally the component's own updater (below) calls it.
  setUpdate(info) {
    const v = info && info.version ? String(info.version) : "";
    this._updateText.textContent = v ? `Update available: v${v}` : "Update available";
    // Reset the button to the ready state (a re-shown bar after a failed attempt gets a fresh click).
    this._updateBtn.disabled = false;
    this._updateBtn.textContent = "Update & Relaunch";
    this.updateBar.style.display = "flex";
  }
  clearUpdate() {
    this.updateBar.style.display = "none";
  }

  // ── self-update (app-agnostic capability) ──
  //
  // A self-updater is the same for any app regardless of what it hosts, so it lives here once and
  // every consuming app inherits it (see CLAUDE.md's dividing-line decision). It feature-detects the
  // shared Tauri runtime: both real apps expose `window.__TAURI__.updater`/`.process`, while the
  // isolated preview.html has no Tauri, so every path below no-ops there. Per-app *identity* (release
  // endpoint, signing pubkey, the Rust plugin registration) stays in the app's own config; the only
  // knob passed in is `autoUpdate` (mount config), the app's config gate.

  _updater() {
    return typeof window !== "undefined" && window.__TAURI__ ? window.__TAURI__.updater : null;
  }
  _process() {
    return typeof window !== "undefined" && window.__TAURI__ ? window.__TAURI__.process : null;
  }

  // Arm at mount (gated on autoUpdate + a present Tauri runtime): one immediate silent check, then a
  // recurring one so a long-running window surfaces a release without a restart. Toggling autoUpdate
  // in config takes effect next launch (armed once here) — restart-only by design.
  _startUpdater() {
    if (!this.cfg.autoUpdate || !this._updater()) return;
    this.checkForUpdate(false);
    this._updateTimer = setInterval(() => this.checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS);
  }

  // Check for a newer release. `announce` = surface "up to date" / errors (the menu path); the launch
  // + periodic paths pass false so they stay silent on miss/offline and never nag. A found update
  // shows unless dismissed this session — except the menu path, which re-surfaces it (clearing the
  // dismissal, since the user is re-engaging).
  async checkForUpdate(announce) {
    const updater = this._updater();
    if (!updater) return;
    try {
      const update = await updater.check();
      if (update) {
        this._pendingUpdate = update;
        if (announce) this._updateDismissed = false;
        if (announce || !this._updateDismissed) this.setUpdate({ version: update.version, notes: update.body });
      } else if (announce) {
        this.setError("You're up to date.");
        setTimeout(() => this.clearError(), 4000);
      }
    } catch (e) {
      if (announce) this.setError("Couldn't check for updates: " + e);
    }
  }

  // The menu "Check for Updates…" path: check now and announce the result. The app forwards its own
  // menu event here — the event *name* is app-specific (warden:check-update / check-update), the
  // logic isn't.
  checkForUpdateNow() {
    this.checkForUpdate(true);
  }

  // Download + install the pending update, then relaunch into it. Fired by the update bar's button.
  async _installUpdate() {
    const proc = this._process();
    if (!this._pendingUpdate || !proc) return;
    try {
      await this._pendingUpdate.downloadAndInstall();
      await proc.relaunch();
    } catch (e) {
      this.clearUpdate();
      this.setError("Update failed: " + e);
    }
  }

  // Stop the recurring check — the interval is the only long-lived resource the component holds. A
  // consumer that unmounts the sidebar should call this; both current apps let the webview teardown
  // collect it, but destroy() keeps that explicit and lets tests tear down cleanly.
  destroy() {
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
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
  module.exports = { ChromeSidebar, tileInitial, tileColour, hexToRgb, tintOverBase, clampWidth, resolveOffset, presenceClass, derivePresenceState, buildTree };
}
if (typeof window !== "undefined") {
  window.ChromeSidebar = ChromeSidebar;
}
