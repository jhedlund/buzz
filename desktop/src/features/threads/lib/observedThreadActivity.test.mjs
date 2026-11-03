import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceFrontier,
  getObservedThreadActivity,
  MAX_OBSERVED_ROOTS,
  mergeObservedActivity,
  recordThreadActivity,
  resetObservedThreadActivity,
  subscribeObservedThreadActivity,
} from "./observedThreadActivity.ts";

const ROOT = "a".repeat(64);
const OTHER = "b".repeat(64);

function entry(overrides = {}) {
  return {
    author: "p".repeat(64),
    channelId: "634a9a88-e929-427c-9dc7-3b7f7194e882",
    lastActivityAt: 100,
    lastActivityIds: ["r1"],
    revision: "r".repeat(64),
    rootId: ROOT,
    title: "Release checklist",
    updatedAt: 100,
    ...overrides,
  };
}

test("advanceFrontier moves on a later second, joins the same second, and ignores older or known events", () => {
  const first = advanceFrontier(undefined, 100, "x");
  assert.deepEqual(first, { at: 100, ids: ["x"] });
  assert.deepEqual(advanceFrontier(first, 100, "y"), {
    at: 100,
    ids: ["x", "y"],
  });
  assert.equal(advanceFrontier(first, 100, "x"), first);
  assert.equal(advanceFrontier(first, 99, "z"), first);
  assert.deepEqual(advanceFrontier(first, 101, "z"), { at: 101, ids: ["z"] });
});

test("recordThreadActivity notifies only on new activity and normalizes the root", () => {
  resetObservedThreadActivity();
  let calls = 0;
  const unsubscribe = subscribeObservedThreadActivity(() => {
    calls += 1;
  });
  recordThreadActivity(ROOT.toUpperCase(), 100, "x");
  const snapshot = getObservedThreadActivity();
  recordThreadActivity(ROOT, 100, "x");
  recordThreadActivity(ROOT, 50, "old");
  recordThreadActivity(null, 100, "y");
  assert.equal(calls, 1);
  assert.equal(getObservedThreadActivity(), snapshot, "snapshot is stable");
  assert.deepEqual(snapshot.get(ROOT), { at: 100, ids: ["x"] });
  unsubscribe();
  resetObservedThreadActivity();
});

test("the store forgets the oldest activity past its bound", () => {
  resetObservedThreadActivity();
  for (let i = 0; i <= MAX_OBSERVED_ROOTS; i++) {
    recordThreadActivity(i.toString(16).padStart(64, "0"), 1_000 + i, `e${i}`);
  }
  const observed = getObservedThreadActivity();
  assert.equal(observed.size, MAX_OBSERVED_ROOTS);
  assert.ok(!observed.has("0".repeat(64)));
  resetObservedThreadActivity();
});

test("mergeObservedActivity folds newer and same-second activity, re-sorting, and keeps the array otherwise", () => {
  const titles = [
    entry({ rootId: OTHER, lastActivityAt: 200, lastActivityIds: ["o"] }),
    entry(),
  ];
  assert.equal(mergeObservedActivity(titles, new Map()), titles);
  assert.equal(
    mergeObservedActivity(
      titles,
      new Map([
        [ROOT, { at: 100, ids: ["r1"] }],
        [OTHER, { at: 150, ids: ["late"] }],
      ]),
    ),
    titles,
    "known or older activity changes nothing",
  );

  const sameSecond = mergeObservedActivity(
    titles,
    new Map([[ROOT, { at: 100, ids: ["r2"] }]]),
  );
  assert.deepEqual(sameSecond[1].lastActivityIds, ["r1", "r2"]);
  assert.equal(sameSecond[1].lastActivityAt, 100);

  const newer = mergeObservedActivity(
    titles,
    new Map([[ROOT, { at: 300, ids: ["n"] }]]),
  );
  assert.deepEqual(
    newer.map((title) => [title.rootId, title.lastActivityAt]),
    [
      [ROOT, 300],
      [OTHER, 200],
    ],
  );
  assert.deepEqual(newer[0].lastActivityIds, ["n"]);
  assert.equal(titles[1].lastActivityAt, 100, "the input is not mutated");
});
