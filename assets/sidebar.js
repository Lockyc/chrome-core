// chrome-core sidebar component — built in Task 3.
// Framework-free: exposes a global `ChromeSidebar` factory for the browser, and CommonJS exports
// (the factory + pure helpers) for node:test.
const ChromeSidebar = {
  mount() {
    throw new Error("ChromeSidebar.mount not implemented yet");
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ChromeSidebar };
}
if (typeof window !== "undefined") {
  window.ChromeSidebar = ChromeSidebar;
}
