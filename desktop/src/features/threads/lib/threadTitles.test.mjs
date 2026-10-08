import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTitleWrite,
  batchTitleSyncChannels,
  countUnreadByTitledRoot,
  findThreadTitle,
  findThreadTitleByRoot,
  interpretTitleDraft,
  MAX_LIVE_SYNC_CHANNELS_PER_FILTER,
} from "./threadTitles.ts";

const CHANNEL = "634a9a88-e929-427c-9dc7-3b7f7194e882";
const OTHER_CHANNEL = "11111111-2222-4333-8444-555555555555";
const ROOT = "a".repeat(64);
const OTHER_ROOT = "b".repeat(64);

function entry(overrides = {}) {
  return {
    author: "p".repeat(64),
    channelId: CHANNEL,
    lastActivityAt: 100,
    revision: "r".repeat(64),
    rootId: ROOT,
    title: "Release checklist",
    updatedAt: 100,
    ...overrides,
  };
}

test("findThreadTitle matches channel and root, case-insensitively on the root", () => {
  const titles = [entry(), entry({ rootId: OTHER_ROOT, title: "Other" })];
  assert.equal(
    findThreadTitle(titles, CHANNEL, ROOT.toUpperCase())?.title,
    "Release checklist",
  );
  // The same root id in another channel is a different thread.
  assert.equal(findThreadTitle(titles, OTHER_CHANNEL, ROOT), null);
  assert.equal(findThreadTitle(undefined, CHANNEL, ROOT), null);
  assert.equal(findThreadTitle(titles, null, ROOT), null);
});

test("findThreadTitleByRoot needs no channel", () => {
  const titles = [entry({ channelId: OTHER_CHANNEL })];
  assert.equal(
    findThreadTitleByRoot(titles, ROOT.toUpperCase())?.title,
    "Release checklist",
  );
  assert.equal(findThreadTitleByRoot(titles, OTHER_ROOT), null);
  assert.equal(findThreadTitleByRoot(titles, null), null);
});

test("interpretTitleDraft trims, clears on blank, and skips no-op writes", () => {
  assert.deepEqual(interpretTitleDraft("  New  ", "Old"), {
    kind: "set",
    title: "New",
  });
  assert.deepEqual(interpretTitleDraft(" Old ", "Old"), { kind: "unchanged" });
  assert.deepEqual(interpretTitleDraft("   ", "Old"), { kind: "clear" });
  assert.deepEqual(interpretTitleDraft("", null), { kind: "unchanged" });
});

test("interpretTitleDraft bounds titles by UTF-8 bytes, not characters", () => {
  assert.equal(interpretTitleDraft("é".repeat(256), null).kind, "set");
  assert.equal(interpretTitleDraft("é".repeat(257), null).kind, "too-long");
});

test("applyTitleWrite moves a renamed thread to the top and drops a cleared one", () => {
  const titles = [
    entry({ rootId: OTHER_ROOT, title: "Newer", lastActivityAt: 500 }),
    entry(),
  ];
  const renamed = applyTitleWrite(
    titles,
    { channelId: CHANNEL, rootId: ROOT, title: "Renamed" },
    900,
  );
  assert.deepEqual(
    renamed.map((t) => [t.rootId, t.title, t.lastActivityAt]),
    [
      [ROOT, "Renamed", 900],
      [OTHER_ROOT, "Newer", 500],
    ],
  );

  const cleared = applyTitleWrite(
    titles,
    { channelId: CHANNEL, rootId: ROOT.toUpperCase(), title: null },
    900,
  );
  assert.deepEqual(
    cleared.map((t) => t.rootId),
    [OTHER_ROOT],
  );
});

test("countUnreadByTitledRoot counts unread replies of titled threads only", () => {
  const titles = [entry(), entry({ rootId: OTHER_ROOT, title: "Other" })];
  const counts = countUnreadByTitledRoot(titles, [
    { id: "r1", rootId: ROOT },
    { id: "r2", rootId: ROOT.toUpperCase() },
    // The same reply surfaced twice (live activity and a reopened Inbox row).
    { id: "r2", rootId: ROOT },
    // Untitled thread and a reply with no resolvable root are ignored.
    { id: "r3", rootId: "c".repeat(64) },
    { id: "r4", rootId: null },
  ]);
  assert.deepEqual([...counts], [[ROOT, 2]]);
  // A titled thread with nothing unread has no entry rather than a zero.
  assert.equal(counts.has(OTHER_ROOT), false);
});

test("countUnreadByTitledRoot is empty before titles load", () => {
  assert.equal(
    countUnreadByTitledRoot(undefined, [{ id: "r1", rootId: ROOT }]).size,
    0,
  );
});

test("batchTitleSyncChannels dedupes, sorts, and splits at the relay #h cap", () => {
  assert.deepEqual(batchTitleSyncChannels([]), []);
  assert.deepEqual(batchTitleSyncChannels(["b", "a", "b", ""]), [["a", "b"]]);
  const ids = Array.from(
    { length: 130 },
    (_, i) => `c${String(i).padStart(3, "0")}`,
  );
  const batches = batchTitleSyncChannels(ids.reverse());
  assert.equal(MAX_LIVE_SYNC_CHANNELS_PER_FILTER, 128);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [128, 2],
  );
  assert.equal(batches[0][0], "c000");
  assert.equal(batches[1][1], "c129");
});
