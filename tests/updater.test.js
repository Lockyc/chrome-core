// The self-updater and the component's other timers, under node:test's mocked clock. sidebar.js
// reads the global setTimeout/setInterval at call time, so enabling the mock before mounting is
// enough. The Tauri updater and process plugins are fakes whose promises the test settles by hand,
// which is how it orders a late check against an install in flight.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  Sidebar,
  UPDATE_CHECK_INTERVAL_MS,
  KEY_ARM_TIMEOUT_MS,
  RESCAN_STATUS_MS,
  UP_TO_DATE_NOTICE_MS,
} = require("../assets/sidebar.js");
const { installDom, fire } = require("./dom.js");

/** A promise plus the hands that settle it. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** Let every settled promise's continuations run (setImmediate is not mocked). */
const flush = () => new Promise((r) => setImmediate(r));

/** Mount with a fake Tauri runtime: `check()` answers from `checks` in order, one deferred each. */
function mountUpdater(t, { process = true, autoUpdate = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const root = installDom();
  const checks = [];
  const relaunched = [];
  window.__TAURI__ = {
    updater: {
      check: () => {
        const d = deferred();
        checks.push(d);
        return d.promise;
      },
    },
    process: process ? { relaunch: async () => relaunched.push(true) } : undefined,
  };
  const sb = new Sidebar(root, {}, { autoUpdate });
  t.after(() => sb.destroy());
  return { sb, checks, relaunched };
}

const errorShown = (sb) => sb.errorBar.style.display === "flex";
const updateShown = (sb) => sb.updateBar.style.display === "flex";

test("updater: a real error inside the up-to-date notice's window outlives its auto-clear", async (t) => {
  const { sb, checks } = mountUpdater(t);
  checks[0].resolve(null); // the launch check: silent
  await flush();
  sb.checkForUpdateNow();
  checks[1].resolve(null);
  await flush();
  assert.equal(sb._errorText.textContent, "You're up to date.");
  sb.setError("Couldn't save");
  t.mock.timers.tick(UP_TO_DATE_NOTICE_MS);
  assert.ok(errorShown(sb), "the error is still on screen");
  assert.equal(sb._errorText.textContent, "Couldn't save");
});

test("updater: the up-to-date notice clears itself", async (t) => {
  const { sb, checks } = mountUpdater(t);
  sb.checkForUpdateNow();
  checks[1].resolve(null);
  await flush();
  assert.ok(errorShown(sb));
  t.mock.timers.tick(UP_TO_DATE_NOTICE_MS);
  assert.ok(!errorShown(sb));
});

test("updater: a periodic check landing mid-install leaves the button and the Update alone", async (t) => {
  const { sb, checks } = mountUpdater(t);
  const install = deferred();
  const first = { version: "1.2.0", downloadAndInstall: () => install.promise };
  checks[0].resolve(first);
  await flush();
  assert.ok(updateShown(sb));
  fire(sb._updateBtn, "click");
  assert.equal(sb._updateBtn.disabled, true);
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(checks.length, 2, "the interval re-checks");
  checks[1].resolve({ version: "1.3.0", downloadAndInstall: async () => {} });
  await flush();
  assert.equal(sb._updateBtn.disabled, true, "still installing");
  assert.equal(sb._updateBtn.textContent, "Updating…");
  assert.equal(sb._pendingUpdate, first, "the Update being installed is not swapped");
  assert.equal(sb._updateText.textContent, "Update available: v1.2.0");
});

test("updater: the interval re-checks at UPDATE_CHECK_INTERVAL_MS and destroy() stops it", async (t) => {
  const { sb, checks } = mountUpdater(t);
  assert.equal(checks.length, 1, "one check at launch");
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS - 1);
  assert.equal(checks.length, 1);
  t.mock.timers.tick(1);
  assert.equal(checks.length, 2);
  sb.destroy();
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(checks.length, 2);
});

test("updater: a dismissed update stays down on the periodic check, and the menu check lifts the dismissal", async (t) => {
  const { sb, checks } = mountUpdater(t);
  const u = { version: "2.0.0", downloadAndInstall: async () => {} };
  checks[0].resolve(u);
  await flush();
  fire(sb._updateClose, "click");
  assert.ok(!updateShown(sb));
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
  checks[1].resolve(u);
  await flush();
  assert.ok(!updateShown(sb), "dismissed for the session");
  sb.checkForUpdateNow();
  checks[2].resolve(u);
  await flush();
  assert.ok(updateShown(sb), "the menu path re-engages");
  sb.clearUpdate(); // the bar goes without a dismissal
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
  checks[3].resolve(u);
  await flush();
  assert.ok(updateShown(sb), "the periodic check offers it again");
});

test("updater: without the process plugin nothing arms, and Update clears the bar with the reason", async (t) => {
  const { sb, checks } = mountUpdater(t, { process: false });
  assert.equal(checks.length, 0, "no launch check");
  assert.equal(sb._updateTimer, null, "no interval");
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(checks.length, 0);
  sb.setUpdate({ version: "1.0.0" }); // a consumer driving the view directly
  fire(sb._updateBtn, "click");
  await flush();
  assert.ok(!updateShown(sb), "not stuck at Updating…");
  assert.ok(errorShown(sb));
  assert.equal(sb._errorText.textContent, "Update failed: the process plugin is not available");
});

test("updater: a failed install re-enables a fresh attempt and says why", async (t) => {
  const { sb, checks } = mountUpdater(t);
  const install = deferred();
  checks[0].resolve({ version: "1.2.0", downloadAndInstall: () => install.promise });
  await flush();
  fire(sb._updateBtn, "click");
  install.reject(new Error("signature mismatch"));
  await flush();
  assert.equal(sb._installing, false);
  assert.ok(!updateShown(sb));
  assert.match(sb._errorText.textContent, /^Update failed: .*signature mismatch/);
  // The next periodic check may offer it again.
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
  checks[1].resolve({ version: "1.2.1", downloadAndInstall: async () => {} });
  await flush();
  assert.ok(updateShown(sb));
  assert.equal(sb._updateBtn.disabled, false);
});

// ── the other timers ──

function mountTabs(t, cb = {}, dto = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const root = installDom();
  const sb = new Sidebar(root, cb, {});
  sb.update({ title: "w", active: "a", tabs: [{ id: "a", title: "A", live: true }, { id: "k", title: "K", killable: true }], ...dto });
  t.after(() => sb.destroy());
  return sb;
}

test("requestEnd: a keyboard-armed row lapses after KEY_ARM_TIMEOUT_MS", (t) => {
  const sb = mountTabs(t);
  sb.requestEnd("k", "destroy");
  assert.equal(sb.controls.armed, "k");
  t.mock.timers.tick(KEY_ARM_TIMEOUT_MS - 1);
  assert.equal(sb.controls.armed, "k");
  t.mock.timers.tick(1);
  assert.equal(sb.controls.armed, null);
});

test("requestEnd: a re-arm restarts the lapse rather than inheriting the old timer", (t) => {
  const sb = mountTabs(t);
  // ⏻ can't run on `k` (not suspendable), so each suspend request re-arms its row.
  sb.requestEnd("k", "suspend");
  t.mock.timers.tick(KEY_ARM_TIMEOUT_MS - 1);
  sb.requestEnd("k", "suspend");
  t.mock.timers.tick(KEY_ARM_TIMEOUT_MS - 1);
  assert.equal(sb.controls.armed, "k", "the first arm's timer must not cut the second short");
  t.mock.timers.tick(1);
  assert.equal(sb.controls.armed, null);
});

test("requestEnd: a disarm cancels the lapse, so it can't disarm a later arm early", (t) => {
  const sb = mountTabs(t);
  sb.requestEnd("k", "destroy");
  t.mock.timers.tick(KEY_ARM_TIMEOUT_MS - 1);
  sb.controls.disarm();
  sb.controls.arm("k", sb.list.querySelector('.cc-tab[data-id="k"]')); // a click-arm: no lapse
  t.mock.timers.tick(KEY_ARM_TIMEOUT_MS);
  assert.equal(sb.controls.armed, "k");
});

test("rescan: the outcome shows until RESCAN_STATUS_MS after the rescan settles", async (t) => {
  const done = deferred();
  const tree = [{ id: "d1", title: "one", group: "Dev", tree: true, treePath: [] }];
  const sb = mountTabs(t, { onRescan: () => done.promise }, { active: "d1", tabs: tree });
  const head = () => ({
    btn: sb.list.querySelector(".cc-rescan"),
    status: sb.list.querySelector(".cc-rescan-status"),
  });
  fire(head().btn, "click");
  assert.equal(head().btn.disabled, true, "spinning while the host scans");
  t.mock.timers.tick(RESCAN_STATUS_MS * 2);
  assert.equal(head().btn.disabled, true, "no timer runs before the scan settles");
  // The host's fresh snapshot lands before the promise settles.
  sb.update({ title: "w", active: "d1", tabs: [...tree, { id: "d2", title: "two", group: "Dev", tree: true, treePath: [] }] });
  done.resolve();
  await flush();
  assert.equal(head().btn.disabled, false);
  assert.equal(head().status.textContent, "+1");
  t.mock.timers.tick(RESCAN_STATUS_MS - 1);
  assert.equal(head().status.textContent, "+1");
  t.mock.timers.tick(1);
  assert.equal(head().status.textContent, "");
});
