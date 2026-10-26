import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import {
  installFakeWindow,
  installTauriMock,
  makeFakeWindow,
} from "../../sidebar/lib/sidebarSyncTestHelpers.mjs";
import { ThreadDoneSyncManager } from "./threadDoneSync.ts";

const RELAY = "wss://done.test";
const A = "a".repeat(64);
const B = "b".repeat(64);

function store(roots = {}) {
  return { version: 1, roots };
}

function ownEvent(createdAt) {
  return {
    id: `e${createdAt}`,
    pubkey: "pubkey",
    content: "remote-cipher",
    created_at: createdAt,
    kind: 30078,
    tags: [["d", "thread-done"]],
    sig: "s",
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test("first sync seeds non-empty local done marks when remote is absent", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  const restore = installFakeWindow(makeFakeWindow());
  try {
    const manager = new ThreadDoneSyncManager("pubkey", RELAY);
    const result = await manager.bootstrap(
      store({ [A]: { done: true, updatedAt: 1 } }),
    );
    assert.equal(result.action, "hold");
    assert.notEqual(manager.getPendingStore(), null);
    manager.destroy();
  } finally {
    restore();
    mock.reset();
  }
});

test("a failed fetch never seeds local done marks over an unseen remote", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.reject(new Error("offline")),
  );
  const restore = installFakeWindow(makeFakeWindow());
  try {
    const manager = new ThreadDoneSyncManager("pubkey", RELAY);
    const result = await manager.bootstrap(
      store({ [A]: { done: true, updatedAt: 1 } }),
    );
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingStore(), null);
    manager.destroy();
  } finally {
    restore();
    mock.reset();
  }
});

test("bootstrap hands back the remote store when one exists", async () => {
  const remote = store({ [B]: { done: true, updatedAt: 9 } });
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([ownEvent(50)]),
  );
  const restore = installFakeWindow(makeFakeWindow());
  const tauri = installTauriMock(JSON.stringify(remote));
  try {
    const manager = new ThreadDoneSyncManager("pubkey", RELAY);
    const result = await manager.bootstrap(store());
    assert.equal(result.action, "apply-remote");
    assert.deepEqual(result.data.store, remote);
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

test("publish merges the latest remote blob first, so another device's reopen survives", async () => {
  // Device two reopened A at t=20; this device still holds its t=10 mark and
  // marks B done. The published blob must keep A open.
  const remote = store({ [A]: { done: false, updatedAt: 20 } });
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([ownEvent(60)]),
  );
  const published = [];
  mock.method(relayClient, "publishEvent", (event) => {
    published.push(event);
    return Promise.resolve();
  });
  const fakeWindow = makeFakeWindow();
  const restore = installFakeWindow(fakeWindow);
  const tauri = installTauriMock(JSON.stringify(remote));
  try {
    const manager = new ThreadDoneSyncManager("pubkey", RELAY);
    manager.publishDone(
      store({
        [A]: { done: true, updatedAt: 10 },
        [B]: { done: true, updatedAt: 30 },
      }),
    );
    fakeWindow._fireTimer();
    await flush();

    assert.equal(published.length, 1);
    assert.ok(
      published[0].created_at > 60,
      "created_at passes the remote head",
    );
    assert.deepEqual(published[0].tags, [
      ["d", "thread-done"],
      ["t", "thread-done"],
    ]);
    assert.deepEqual(
      JSON.parse(tauri.capturedPlaintext()),
      store({
        [A]: { done: false, updatedAt: 20 },
        [B]: { done: true, updatedAt: 30 },
      }),
    );
    assert.equal(manager.getPendingStore(), null);
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

test("destroy cancels a pending publish", () => {
  const fakeWindow = makeFakeWindow();
  const restore = installFakeWindow(fakeWindow);
  try {
    const manager = new ThreadDoneSyncManager("pubkey", RELAY);
    manager.publishDone(store({ [A]: { done: true, updatedAt: 1 } }));
    manager.destroy();
    assert.equal(manager.getPendingStore(), null);
    assert.equal(fakeWindow._hasTimer(), false);
  } finally {
    restore();
  }
});
