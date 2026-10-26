import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_THREAD_DONE_STORE,
  MAX_THREAD_DONE_ENTRIES,
  doneRoots,
  mergeThreadDoneStores,
  parseThreadDonePayload,
  partitionByDone,
  toggleDone,
} from "./threadDone.ts";
import { partitionByPin } from "./threadPins.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const NO_UNREAD = new Map();

function store(roots = {}) {
  return { version: 1, roots };
}

test("toggleDone marks done, then reopens as a tombstone, normalizing the root", () => {
  const done = toggleDone(EMPTY_THREAD_DONE_STORE, A.toUpperCase(), 100);
  assert.deepEqual(done, store({ [A]: { done: true, updatedAt: 100 } }));
  assert.deepEqual(
    toggleDone(done, A, 200),
    store({ [A]: { done: false, updatedAt: 200 } }),
  );
  assert.deepEqual([...doneRoots(toggleDone(done, A, 200))], []);
});

test("toggleDone advances updatedAt even when the clock went backwards", () => {
  const done = toggleDone(EMPTY_THREAD_DONE_STORE, A, 500);
  const reopened = toggleDone(done, A, 100);
  assert.deepEqual(reopened.roots[A], { done: false, updatedAt: 501 });
});

test("the cap evicts tombstones before done marks, then the oldest marks", () => {
  let current = EMPTY_THREAD_DONE_STORE;
  for (let i = 0; i < MAX_THREAD_DONE_ENTRIES; i++) {
    current = toggleDone(current, i.toString(16).padStart(64, "0"), 1_000 + i);
  }
  // Reopen the newest mark: it becomes the only tombstone.
  const newest = (MAX_THREAD_DONE_ENTRIES - 1).toString(16).padStart(64, "0");
  current = toggleDone(current, newest, 5_000);
  current = toggleDone(current, C, 10_000);
  assert.equal(Object.keys(current.roots).length, MAX_THREAD_DONE_ENTRIES);
  assert.ok(!(newest in current.roots), "the tombstone is evicted first");
  assert.ok(current.roots[C].done);

  current = toggleDone(current, B, 11_000);
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
  const deviceOne = toggleDone(EMPTY_THREAD_DONE_STORE, A, 100);
  const deviceTwo = toggleDone(deviceOne, A, 200);
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
  const entries = [{ rootId: A }, { rootId: B.toUpperCase() }, { rootId: C }];
  const { active, done } = partitionByDone(entries, new Set([C, B]), NO_UNREAD);
  assert.deepEqual(
    done.map((entry) => entry.rootId),
    [B.toUpperCase(), C],
  );
  assert.deepEqual(
    active.map((entry) => entry.rootId),
    [A],
  );
});

test("a done thread with unread replies stays active", () => {
  const entries = [{ rootId: A }, { rootId: B }];
  const { active, done } = partitionByDone(
    entries,
    new Set([A, B]),
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

test("a done and pinned thread lands in done, and pinning applies to the rest", () => {
  const entries = [{ rootId: A }, { rootId: B }, { rootId: C }];
  const pinned = new Set([A, B]);
  const { active, done } = partitionByDone(entries, new Set([A]), NO_UNREAD);
  assert.deepEqual(
    done.map((entry) => entry.rootId),
    [A],
  );
  const grouped = partitionByPin(active, pinned);
  assert.deepEqual(
    grouped.pinned.map((entry) => entry.rootId),
    [B],
  );
  assert.deepEqual(
    grouped.unpinned.map((entry) => entry.rootId),
    [C],
  );
});

test("an empty done store passes every entry through as active", () => {
  const entries = [{ rootId: A }, { rootId: B }];
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
});
