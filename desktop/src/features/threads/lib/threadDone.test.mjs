import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_THREAD_DONE_STORE,
  MAX_THREAD_DONE_ENTRIES,
  doneRoots,
  isThreadDone,
  mergeThreadDoneStores,
  parseThreadDonePayload,
  partitionByDone,
  setThreadDone,
} from "./threadDone.ts";
import { partitionByPin } from "./threadPins.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const NO_UNREAD = new Map();
/** Rows below last saw activity at 900 s; marks record that frontier. */
const FRONTIER = 900;

function store(roots = {}) {
  return { version: 1, roots };
}

/** A row whose last activity (seconds) is at the marks' frontier. */
function row(rootId, lastActivityAt = FRONTIER) {
  return { rootId, lastActivityAt };
}

function marked(...roots) {
  return new Map(
    roots.map((root) => [
      root,
      { done: true, updatedAt: 5_000_000, activityAt: FRONTIER },
    ]),
  );
}

test("setThreadDone marks done, then reopens as a tombstone, normalizing the root", () => {
  const done = setThreadDone(
    EMPTY_THREAD_DONE_STORE,
    A.toUpperCase(),
    true,
    100,
  );
  assert.deepEqual(done, store({ [A]: { done: true, updatedAt: 100 } }));
  const reopened = setThreadDone(done, A, false, 200);
  assert.deepEqual(reopened, store({ [A]: { done: false, updatedAt: 200 } }));
  assert.deepEqual([...doneRoots(reopened)], []);
  assert.deepEqual([...doneRoots(done)], [[A, { done: true, updatedAt: 100 }]]);
});

test("marking an already-done thread done again restamps it instead of flipping it", () => {
  const done = setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 100, 10);
  const again = setThreadDone(done, A, true, 300, 20);
  assert.deepEqual(again.roots[A], {
    done: true,
    updatedAt: 300,
    activityAt: 20,
  });
  assert.deepEqual(
    setThreadDone(again, A, false, 400, 30).roots[A],
    { done: false, updatedAt: 400 },
    "a reopen keeps no frontier",
  );
});

test("setThreadDone advances updatedAt even when the clock went backwards", () => {
  const done = setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 500);
  const reopened = setThreadDone(done, A, false, 100);
  assert.deepEqual(reopened.roots[A], { done: false, updatedAt: 501 });
});

test("the cap evicts tombstones before done marks, then the oldest marks", () => {
  let current = EMPTY_THREAD_DONE_STORE;
  for (let i = 0; i < MAX_THREAD_DONE_ENTRIES; i++) {
    current = setThreadDone(
      current,
      i.toString(16).padStart(64, "0"),
      true,
      1_000 + i,
    );
  }
  // Reopen the newest mark: it becomes the only tombstone.
  const newest = (MAX_THREAD_DONE_ENTRIES - 1).toString(16).padStart(64, "0");
  current = setThreadDone(current, newest, false, 5_000);
  current = setThreadDone(current, C, true, 10_000);
  assert.equal(Object.keys(current.roots).length, MAX_THREAD_DONE_ENTRIES);
  assert.ok(!(newest in current.roots), "the tombstone is evicted first");
  assert.ok(current.roots[C].done);

  current = setThreadDone(current, B, true, 11_000);
  assert.ok(
    !("0".repeat(64) in current.roots),
    "then the oldest done mark is evicted",
  );
});

test("merge takes the newer entry per root, from either side", () => {
  const local = store({
    [A]: { done: true, updatedAt: 10 },
    [B]: { done: true, updatedAt: 10 },
  });
  const remote = store({
    [A]: { done: false, updatedAt: 20 },
    [B]: { done: false, updatedAt: 5 },
    [C]: { done: true, updatedAt: 1 },
  });
  assert.deepEqual(
    mergeThreadDoneStores(local, remote),
    store({
      [A]: { done: false, updatedAt: 20 },
      [B]: { done: true, updatedAt: 10 },
      [C]: { done: true, updatedAt: 1 },
    }),
  );
});

test("a reopen on one device is not undone by another's stale done mark", () => {
  const deviceOne = setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 100);
  const deviceTwo = setThreadDone(deviceOne, A, false, 200);
  assert.deepEqual(
    [...doneRoots(mergeThreadDoneStores(deviceOne, deviceTwo))],
    [],
  );
  assert.deepEqual(
    [...doneRoots(mergeThreadDoneStores(deviceTwo, deviceOne))],
    [],
  );
});

test("an exact-timestamp conflict resolves to not done", () => {
  const merged = mergeThreadDoneStores(
    store({ [A]: { done: true, updatedAt: 7 } }),
    store({ [A]: { done: false, updatedAt: 7 } }),
  );
  assert.deepEqual(merged.roots[A], { done: false, updatedAt: 7 });
});

test("partitionByDone keeps activity order within each group", () => {
  const entries = [row(A), row(B.toUpperCase()), row(C)];
  const { active, done } = partitionByDone(entries, marked(C, B), NO_UNREAD);
  assert.deepEqual(
    done.map((entry) => entry.rootId),
    [B.toUpperCase(), C],
  );
  assert.deepEqual(
    active.map((entry) => entry.rootId),
    [A],
  );
});

test("activity past the frontier reopens the thread, read or not", () => {
  const entries = [row(A, FRONTIER + 1), row(B), row(C, FRONTIER - 1)];
  const { active, done } = partitionByDone(entries, marked(A, B, C), NO_UNREAD);
  assert.deepEqual(
    active.map((entry) => entry.rootId),
    [A],
  );
  assert.deepEqual(
    done.map((entry) => entry.rootId),
    [B, C],
  );
});

test("a reply in the same second as the mark reopens the thread", () => {
  // Marked at 1000.500 s with the thread last active at 999 s; the reply is
  // stamped 1000 s, before the mark by wall clock.
  const marks = doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 1_000_500, 999),
  );
  assert.equal(isThreadDone(row(A, 999), marks, NO_UNREAD), true);
  assert.equal(isThreadDone(row(A, 1_000), marks, NO_UNREAD), false);
});

test("a reply from a sender whose clock runs behind still reopens the thread", () => {
  // Marked at 2000 s; the sender's clock is 60 s slow, so the reply is stamped
  // 1940 s. It is still past the 1900 s frontier.
  const marks = doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 2_000_000, 1_900),
  );
  assert.equal(isThreadDone(row(A, 1_940), marks, NO_UNREAD), false);
});

test("a mark made while the latest reply's clock ran ahead still files it away", () => {
  // The latest reply is stamped 30 s in the future of the marking device.
  const marks = doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 1_000_000, 1_030),
  );
  assert.equal(isThreadDone(row(A, 1_030), marks, NO_UNREAD), true);
});

test("a mark from before the frontier field compares activity with when it was made", () => {
  const legacy = new Map([[A, { done: true, updatedAt: 1_000_000 }]]);
  assert.equal(isThreadDone(row(A, 1_000), legacy, NO_UNREAD), true);
  assert.equal(isThreadDone(row(A, 1_001), legacy, NO_UNREAD), false);
});

test("marking a reopened thread done again files it away", () => {
  const marks = doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 1_000, FRONTIER),
  );
  const entry = row(A, FRONTIER + 50);
  assert.equal(isThreadDone(entry, marks, NO_UNREAD), false);
  const remarked = doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 2_000, FRONTIER + 50),
  );
  assert.equal(isThreadDone(entry, remarked, NO_UNREAD), true);
});

test("a done thread with unread replies stays active, even at the frontier", () => {
  const entries = [row(A), row(B)];
  const { active, done } = partitionByDone(
    entries,
    marked(A, B),
    new Map([
      [A, 2],
      [B, 0],
    ]),
  );
  assert.deepEqual(
    active.map((entry) => entry.rootId),
    [A],
  );
  assert.deepEqual(
    done.map((entry) => entry.rootId),
    [B],
  );
});

test("a pinned thread stays pinned even when done; only unpinned done threads land in done", () => {
  const entries = [row(A), row(B), row(C)];
  const grouped = partitionByPin(entries, new Set([A, B]));
  assert.deepEqual(
    grouped.pinned.map((entry) => entry.rootId),
    [A, B],
  );
  const { active, done } = partitionByDone(
    grouped.unpinned,
    marked(A, C),
    NO_UNREAD,
  );
  assert.deepEqual(active, []);
  assert.deepEqual(
    done.map((entry) => entry.rootId),
    [C],
  );
});

test("an unpinned done thread lands in done beside active ones", () => {
  const entries = [row(A), row(B), row(C)];
  const grouped = partitionByPin(entries, new Set([A]));
  const { active, done } = partitionByDone(
    grouped.unpinned,
    marked(B),
    NO_UNREAD,
  );
  assert.deepEqual(
    active.map((entry) => entry.rootId),
    [C],
  );
  assert.deepEqual(
    done.map((entry) => entry.rootId),
    [B],
  );
});

test("an empty done store passes every entry through as active", () => {
  const entries = [row(A), row(B)];
  const { active, done } = partitionByDone(
    entries,
    doneRoots(EMPTY_THREAD_DONE_STORE),
    NO_UNREAD,
  );
  assert.deepEqual(active, entries);
  assert.deepEqual(done, []);
});

test("parseThreadDonePayload rejects malformed payloads and bad entries", () => {
  assert.equal(parseThreadDonePayload(null), null);
  assert.equal(parseThreadDonePayload([A]), null);
  assert.equal(parseThreadDonePayload({ version: 2, roots: {} }), null);
  assert.equal(parseThreadDonePayload({ version: 1, roots: [] }), null);
  // A pins blob must never parse as done state.
  assert.deepEqual(
    parseThreadDonePayload({
      version: 1,
      roots: { [A]: { pinned: true, updatedAt: 5 } },
    }),
    store(),
  );
  assert.deepEqual(
    parseThreadDonePayload({
      version: 1,
      roots: {
        [A]: { done: true, updatedAt: 5 },
        short: { done: true, updatedAt: 5 },
        [A.toUpperCase()]: { done: true, updatedAt: 5 },
        [B]: { done: "yes", updatedAt: 5 },
        [C]: { done: true, updatedAt: -1 },
      },
    }),
    store({ [A]: { done: true, updatedAt: 5 } }),
  );
  assert.deepEqual(
    parseThreadDonePayload({
      version: 1,
      roots: {
        [A]: { done: true, updatedAt: 5, activityAt: 4 },
        [B]: { done: true, updatedAt: 5, activityAt: "4" },
      },
    }),
    store({ [A]: { done: true, updatedAt: 5, activityAt: 4 } }),
  );
});
