import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_THREAD_DONE } from "@/shared/constants/kinds";
import {
  advanceWatermark,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "@/features/sidebar/lib/sidebarSyncWatermark";
import {
  mergeThreadDoneStores,
  parseThreadDonePayload,
  threadDoneStoresEqual,
  type ThreadDoneStore,
} from "./threadDone";

const D_TAG = "thread-done";
const BLOB_TYPE = D_TAG;
const DEBOUNCE_MS = 2_000;

export type RemoteThreadDone = {
  store: ThreadDoneStore;
  createdAt: number;
  eventId: string;
};

async function decryptAndParse(
  event: RelayEvent,
): Promise<RemoteThreadDone | null> {
  try {
    const plaintext = await nip44DecryptFromSelf(event.content);
    const store = parseThreadDonePayload(JSON.parse(plaintext));
    if (!store) return null;
    return { store, createdAt: event.created_at, eventId: event.id };
  } catch {
    return null;
  }
}

/** Syncs the user's done threads across devices; mirrors `ThreadPinsSyncManager`. */
export class ThreadDoneSyncManager {
  private pubkey: string;
  private relayUrl: string;
  private debounceTimer: number | null = null;
  private lastRemoteCreatedAt: number;
  private pendingStore: ThreadDoneStore | null = null;
  private lastPublishedStore: ThreadDoneStore | null = null;
  private destroyed = false;

  constructor(pubkey: string, relayUrl: string) {
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    this.lastRemoteCreatedAt = readWatermark(pubkey, BLOB_TYPE, relayUrl);
  }

  private fetchOwnEvents() {
    return relayClient.fetchEvents({
      kinds: [KIND_THREAD_DONE],
      authors: [this.pubkey],
      "#d": [D_TAG],
      limit: 1,
    });
  }

  async fetchRemoteDone(): Promise<FetchResult<RemoteThreadDone>> {
    try {
      const events = await this.fetchOwnEvents();
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return { status: "absent" };
      }
      const event = events[0];
      this.recordRemoteHead(event.created_at);
      const result = await decryptAndParse(event);
      if (!result) {
        return { status: "failed", createdAt: event.created_at };
      }
      return {
        status: "found",
        data: result,
        createdAt: result.createdAt,
        eventId: result.eventId,
      };
    } catch {
      return { status: "failed" };
    }
  }

  private recordRemoteHead(createdAt: number): void {
    if (createdAt > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = createdAt;
    }
    advanceWatermark(this.pubkey, BLOB_TYPE, this.relayUrl, createdAt);
  }

  cancelPendingPublish(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  getPendingStore(): ThreadDoneStore | null {
    return this.pendingStore;
  }

  publishDone(store: ThreadDoneStore): void {
    this.pendingStore = store;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.doPublish(store);
    }, DEBOUNCE_MS);
  }

  private async mergeWithRemoteBeforePublish(
    store: ThreadDoneStore,
  ): Promise<ThreadDoneStore> {
    try {
      const events = await this.fetchOwnEvents();
      if (events.length === 0 || events[0].pubkey !== this.pubkey) return store;
      const event = events[0];
      this.recordRemoteHead(event.created_at);
      const remote = await decryptAndParse(event);
      if (!remote) return store;
      return mergeThreadDoneStores(store, remote.store);
    } catch {
      return store;
    }
  }

  private async doPublish(store: ThreadDoneStore): Promise<void> {
    try {
      const merged = await this.mergeWithRemoteBeforePublish(store);
      if (this.destroyed) return;
      if (
        this.lastPublishedStore !== null &&
        threadDoneStoresEqual(this.lastPublishedStore, merged)
      ) {
        this.pendingStore = null;
        return;
      }
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(merged));
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        this.lastRemoteCreatedAt + 1,
      );
      const event = await signRelayEvent({
        kind: KIND_THREAD_DONE,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", D_TAG],
          ["t", D_TAG],
        ],
      });
      if (this.destroyed) return;
      await relayClient.publishEvent(
        event,
        "Timed out publishing done threads.",
        "Failed to publish done threads.",
      );
      this.recordRemoteHead(event.created_at);
      this.lastPublishedStore = merged;
      this.pendingStore = null;
    } catch (error) {
      console.warn("[threadDoneSync] publish failed:", error);
    }
  }

  async subscribe(
    onUpdate: (remote: RemoteThreadDone) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      {
        kinds: [KIND_THREAD_DONE],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 0,
      },
      (event: RelayEvent) => {
        if (event.pubkey !== this.pubkey) return;
        this.recordRemoteHead(event.created_at);
        void decryptAndParse(event).then((result) => {
          if (result) onUpdate(result);
        });
      },
    );
  }

  async bootstrap(localStore: ThreadDoneStore) {
    const fetchResult = await this.fetchRemoteDone();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore,
      isLocalNonEmpty: (store) => Object.keys(store.roots).length > 0,
      publishFn: (store) => this.publishDone(store),
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelPendingPublish();
    this.pendingStore = null;
  }
}
