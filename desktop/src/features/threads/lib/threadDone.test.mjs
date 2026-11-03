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
import {
  advanceFrontier,
  MAX_FRONTIER_IDS,
  mergeObservedActivity,
  normalizeFrontierIds,
} from "./observedThreadActivity.ts";
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
function row(rootId, lastActivityAt = FRONTIER, lastActivityIds = ["seen"]) {
  return { rootId, lastActivityAt, lastActivityIds };
}

function marked(...roots) {
  return new Map(
    roots.map((root) => [
      root,
      {
        done: true,
        updatedAt: 5_000_000,
        activityAt: FRONTIER,
        activityIds: ["seen"],
      },
    ]),
  );
}

/** One fresh mark on A at a given frontier. */
function markA(at, ids = ["seen"]) {
  return doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 1_000_000, { at, ids }),
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
  const done = setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 100, {
    at: 10,
    ids: ["x"],
  });
  const again = setThreadDone(done, A, true, 300, { at: 20, ids: ["y"] });
  assert.deepEqual(again.roots[A], {
    done: true,
    updatedAt: 300,
    activityAt: 20,
    activityIds: ["y"],
  });
  assert.deepEqual(
    setThreadDone(again, A, false, 400, { at: 30, ids: ["z"] }).roots[A],
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
  const entries = [
    row(A, FRONTIER + 1, ["new"]),
    row(B),
    row(C, FRONTIER - 1, ["old"]),
  ];
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

test("a new reply in the frontier's own second reopens the thread, before and after it is read", () => {
  // Marked with the latest reply at 1000 s; another reply lands in 1000 s.
  const marks = markA(1_000, ["first"]);
  const after = row(A, 1_000, ["first", "second"]);
  assert.equal(isThreadDone(after, marks, new Map([[A, 1]])), false);
  assert.equal(
    isThreadDone(after, marks, NO_UNREAD),
    false,
    "read, still open",
  );
  assert.equal(
    isThreadDone(row(A, 1_000, ["first"]), marks, NO_UNREAD),
    true,
    "the activity it was marked with keeps it done",
  );
});

test("a reply in the same second as the mark, by wall clock, reopens the thread", () => {
  // Marked at 1000.500 s with the thread last active at 999 s; the reply is
  // stamped 1000 s, before the mark by wall clock.
  const marks = doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 1_000_500, {
      at: 999,
      ids: ["seen"],
    }),
  );
  assert.equal(isThreadDone(row(A, 999), marks, NO_UNREAD), true);
  assert.equal(isThreadDone(row(A, 1_000, ["new"]), marks, NO_UNREAD), false);
});

test("a reply from a sender whose clock runs behind still reopens the thread", () => {
  // Marked at 2000 s; the sender's clock is 60 s slow, so the reply is stamped
  // 1940 s. It is still past the 1900 s frontier.
  assert.equal(
    isThreadDone(row(A, 1_940, ["new"]), markA(1_900), NO_UNREAD),
    false,
  );
});

test("a mark made while the latest reply's clock ran ahead still files it away", () => {
  // The latest reply is stamped 30 s in the future of the marking device.
  assert.equal(isThreadDone(row(A, 1_030), markA(1_030), NO_UNREAD), true);
});

test("a mark from before the frontier fields compares activity with when it was made", () => {
  const legacy = new Map([[A, { done: true, updatedAt: 1_000_000 }]]);
  assert.equal(isThreadDone(row(A, 1_000), legacy, NO_UNREAD), true);
  assert.equal(isThreadDone(row(A, 1_001), legacy, NO_UNREAD), false);
});

test("a row without frontier ids compares seconds only", () => {
  assert.equal(
    isThreadDone(
      { rootId: A, lastActivityAt: FRONTIER },
      markA(FRONTIER),
      NO_UNREAD,
    ),
    true,
  );
});

test("marking a reopened thread done again files it away", () => {
  const entry = row(A, FRONTIER + 50, ["new"]);
  assert.equal(isThreadDone(entry, markA(FRONTIER), NO_UNREAD), false);
  assert.equal(
    isThreadDone(entry, markA(FRONTIER + 50, ["new"]), NO_UNREAD),
    true,
  );
});

test("a thread with a saturated second can be marked done and stays done", () => {
  const ids = Array.from({ length: MAX_FRONTIER_IDS }, (_, i) => `r${i}`);
  const entry = row(A, 1_000, ids);
  assert.equal(isThreadDone(entry, markA(1_000, ids), NO_UNREAD), true);
  // A store that somehow holds more keeps only the bound, and parsing it
  // back still accepts the mark.
  const store = setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 1, {
    at: 1_000,
    ids: [...ids, "extra"],
  });
  assert.equal(store.roots[A].activityIds.length, MAX_FRONTIER_IDS);
  assert.deepEqual(parseThreadDonePayload(store), store);
});

test("marking after an out-of-order busy second stays done when the poll returns the Rust selection", () => {
  // 60 replies in one second: f00..f49 arrive first, then smaller a00..a09.
  const late = Array.from(
    { length: 50 },
    (_, i) => `f${String(i).padStart(2, "0")}`,
  );
  const early = Array.from(
    { length: 10 },
    (_, i) => `a${String(i).padStart(2, "0")}`,
  );
  let live;
  for (const id of [...late, ...early]) live = advanceFrontier(live, 1_000, id);
  const staleRow = {
    ...row(A, 900, ["older"]),
    channelId: "c",
    title: "t",
  };
  const [displayed] = mergeObservedActivity([staleRow], new Map([[A, live]]));
  const marks = doneRoots(
    setThreadDone(EMPTY_THREAD_DONE_STORE, A, true, 1, {
      at: displayed.lastActivityAt,
      ids: displayed.lastActivityIds,
    }),
  );
  assert.equal(isThreadDone(displayed, marks, NO_UNREAD), true);

  // The next poll: Rust keeps the smallest 50 of the same 60 events.
  const polled = {
    ...staleRow,
    lastActivityAt: 1_000,
    lastActivityIds: normalizeFrontierIds([...late, ...early]),
  };
  const [refreshed] = mergeObservedActivity([polled], new Map([[A, live]]));
  assert.equal(isThreadDone(refreshed, marks, NO_UNREAD), true);
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
        [A]: { done: true, updatedAt: 5, activityAt: 4, activityIds: ["x"] },
        [B]: { done: true, updatedAt: 5, activityAt: "4" },
        [C]: { done: true, updatedAt: 5, activityAt: 4, activityIds: [7] },
      },
    }),
    store({
      [A]: { done: true, updatedAt: 5, activityAt: 4, activityIds: ["x"] },
    }),
  );
});
