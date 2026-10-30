// A minimal fake DOM — just enough of the API `Sidebar` uses to mount, render and dispatch events
// under node:test with zero deps. Not a test file (node --test only runs `*.test.js` here).
// `serialize` prints a deterministic markup string for snapshot comparison.

class FakeClassList {
  constructor(node) {
    this.node = node;
  }
  _get() {
    return (this.node.getAttribute("class") || "").split(/\s+/).filter(Boolean);
  }
  _set(list) {
    this.node.setAttribute("class", list.join(" "));
  }
  add(...cs) {
    const l = this._get();
    for (const c of cs) if (!l.includes(c)) l.push(c);
    this._set(l);
  }
  remove(...cs) {
    this._set(this._get().filter((c) => !cs.includes(c)));
  }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : !!force;
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
  contains(c) {
    return this._get().includes(c);
  }
  [Symbol.iterator]() {
    return this._get()[Symbol.iterator]();
  }
}

const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this._text = "";
    this._html = "";
    this.offsetParent = null;
    this.scrollTop = 0;
    this.disabled = false;
    this.classList = new FakeClassList(this);
    const styleProps = {};
    this.style = { setProperty: (k, v) => (styleProps[k] = v), _props: styleProps };
    this.dataset = new Proxy(
      {},
      {
        get: (_, k) => this.getAttribute("data-" + kebab(String(k))) ?? undefined,
        set: (_, k, v) => (this.setAttribute("data-" + kebab(String(k)), String(v)), true),
      },
    );
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get className() {
    return this.getAttribute("class") || "";
  }
  set className(v) {
    this.setAttribute("class", v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.children = [];
    this._html = "";
    this._text = v == null ? "" : String(v);
  }
  set innerHTML(v) {
    this.children = [];
    this._text = "";
    this._html = String(v);
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  toggleAttribute(k, force) {
    const on = force === undefined ? !this.hasAttribute(k) : !!force;
    if (on) this.setAttribute(k, "");
    else this.removeAttribute(k);
    return on;
  }
  appendChild(n) {
    if (n.parentNode) n.remove();
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  append(...ns) {
    for (const n of ns) this.appendChild(n);
  }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.remove();
    n.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, n);
    return n;
  }
  remove() {
    if (!this.parentNode) return;
    const sib = this.parentNode.children;
    sib.splice(sib.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(n) {
    for (let c = n; c; c = c.parentNode) if (c === this) return true;
    return false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  _descendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    const m = matcher(sel);
    return this._descendants().filter(m);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest(sel) {
    const m = matcher(sel);
    for (let n = this; n; n = n.parentNode) if (n instanceof FakeNode && m(n)) return n;
    return null;
  }
  getBoundingClientRect() {
    return { width: 0, height: 0 };
  }
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
}

/** Compound selectors only (no combinators): `tag`, `.class`, `[attr]`, `[attr="v"]`,
 *  `:not([attr])` — every form `sidebar.js` queries with. */
function matcher(sel) {
  const re = /(:not\(\[([\w-]+)\]\))|(\.[\w-]+)|(\[([\w-]+)(?:="([^"]*)")?\])|(^[a-z]+)/g;
  const tests = [];
  let m;
  while ((m = re.exec(sel))) {
    if (m[1]) {
      const a = m[2];
      tests.push((n) => !n.hasAttribute(a));
    } else if (m[3]) {
      const c = m[3].slice(1);
      tests.push((n) => n.classList.contains(c));
    } else if (m[4]) {
      const [a, v] = [m[5], m[6]];
      tests.push((n) => n.hasAttribute(a) && (v === undefined || n.getAttribute(a) === v));
    } else if (m[7]) {
      const t = m[7].toUpperCase();
      tests.push((n) => n.tagName === t);
    }
  }
  return (n) => tests.every((t) => t(n));
}

/** Dispatch `type` at `node`, bubbling to the root unless a listener stops it. Returns the event. */
function fire(node, type, props = {}) {
  let stopped = false;
  const ev = {
    type,
    target: node,
    defaultPrevented: false,
    timeStamp: 0,
    stopPropagation() {
      stopped = true;
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...props,
  };
  for (let n = node; n && !stopped; n = n.parentNode) {
    for (const fn of [...(n.listeners[type] || [])]) fn.call(n, ev);
  }
  return ev;
}

/** Deterministic markup: sorted attributes, then inline style, own text/html, children. */
function serialize(n) {
  const attrs = [...n.attrs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => ` ${k}="${v}"`).join("");
  const st = Object.entries(n.style)
    .filter(([k]) => k !== "setProperty" && k !== "_props")
    .concat(Object.entries(n.style._props))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  const tag = n.tagName.toLowerCase();
  return `<${tag}${attrs}${st ? ` style="${st}"` : ""}>${n._text}${n._html}${n.children.map(serialize).join("")}</${tag}>`;
}

/** Install the fake globals `Sidebar` reads (`document`, `window`) and return a fresh mount node.
 *  `localStorage` is deliberately left undefined: any touch of it throws, so a test proves a path
 *  persists nothing. */
function installDom() {
  globalThis.document = {
    createElement: (tag) => new FakeNode(tag),
    documentElement: new FakeNode("html"),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = { innerWidth: 1200 };
  delete globalThis.localStorage; // an earlier test's `installStorage` must not leak into this one
  return new FakeNode("div");
}

/** Install a Map-backed `localStorage` for a test that exercises persisted state; returns it. Call
 *  after `installDom()`. */
function installStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
  return globalThis.localStorage;
}

module.exports = { installDom, installStorage, fire, serialize, FakeNode };
