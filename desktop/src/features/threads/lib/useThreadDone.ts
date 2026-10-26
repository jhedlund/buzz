import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import {
  EMPTY_THREAD_DONE_STORE,
  mergeThreadDoneStores,
  doneRoots,
  readThreadDoneStore,
  threadDoneStoresEqual,
  toggleDone,
  writeThreadDoneStore,
  type ThreadDoneStore,
} from "./threadDone";
import { ThreadDoneSyncManager, type RemoteThreadDone } from "./threadDoneSync";

/**
 * The current identity's done thread roots, synced across devices, plus a
 * toggle. Toggling is unavailable (undefined) until the relay and identity
 * resolve.
 */
export function useThreadDone(
  relayUrl: string | null,
  pubkey: string | undefined,
): {
  done: ReadonlySet<string>;
  toggle: ((rootId: string) => void) | undefined;
} {
  const [store, setStore] = React.useState<ThreadDoneStore>(
    EMPTY_THREAD_DONE_STORE,
  );
  const storeRef = React.useRef(store);
  storeRef.current = store;
  const managerRef = React.useRef<ThreadDoneSyncManager | null>(null);
  const lastAppliedRemoteTs = React.useRef(0);
  const lastAppliedEventId = React.useRef("");

  React.useEffect(() => {
    lastAppliedRemoteTs.current = 0;
    lastAppliedEventId.current = "";
    if (!relayUrl || !pubkey) {
      setStore(EMPTY_THREAD_DONE_STORE);
      return;
    }
    setStore(readThreadDoneStore(relayUrl, pubkey));
    managerRef.current = new ThreadDoneSyncManager(pubkey, relayUrl);
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [pubkey, relayUrl]);

  const applyRemote = React.useCallback(
    (remote: RemoteThreadDone) =>
      (current: ThreadDoneStore): ThreadDoneStore => {
        if (!relayUrl || !pubkey) return current;
        if (remote.createdAt < lastAppliedRemoteTs.current) return current;
        if (
          remote.createdAt === lastAppliedRemoteTs.current &&
          remote.eventId <= lastAppliedEventId.current
        ) {
          return current;
        }
        lastAppliedRemoteTs.current = remote.createdAt;
        lastAppliedEventId.current = remote.eventId;
        managerRef.current?.cancelPendingPublish();
        const merged = mergeThreadDoneStores(current, remote.store);
        writeThreadDoneStore(relayUrl, pubkey, merged);
        if (!threadDoneStoresEqual(merged, remote.store)) {
          managerRef.current?.publishDone(merged);
        }
        return merged;
      },
    [pubkey, relayUrl],
  );

  React.useEffect(() => {
    if (!relayUrl || !pubkey) return;
    let cancelled = false;
    void managerRef.current
      ?.bootstrap(readThreadDoneStore(relayUrl, pubkey))
      .then((result) => {
        if (!cancelled && result.action === "apply-remote") {
          setStore(applyRemote(result.data));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyRemote, pubkey, relayUrl]);

  React.useEffect(() => {
    if (!relayUrl || !pubkey) return;
    let unsubscribe: (() => Promise<void>) | null = null;
    let cancelled = false;
    void managerRef.current
      ?.subscribe((remote) => {
        if (!cancelled) setStore(applyRemote(remote));
      })
      .then((dispose) => {
        if (cancelled) {
          void dispose();
        } else {
          unsubscribe = dispose;
        }
      });
    return () => {
      cancelled = true;
      if (unsubscribe) void unsubscribe();
    };
  }, [applyRemote, pubkey, relayUrl]);

  React.useEffect(() => {
    if (!relayUrl || !pubkey) return;
    let cancelled = false;
    const unsubscribe = relayClient.subscribeToReconnects(() => {
      void managerRef.current?.fetchRemoteDone().then((result) => {
        if (cancelled) return;
        if (result.status === "found") setStore(applyRemote(result.data));
        const pending = managerRef.current?.getPendingStore();
        if (pending) managerRef.current?.publishDone(pending);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyRemote, pubkey, relayUrl]);

  const toggle = React.useMemo(() => {
    if (!relayUrl || !pubkey) return undefined;
    return (rootId: string) => {
      // Computed from the ref, not inside a state updater, so the write and
      // publish run exactly once even under StrictMode's double-invoke.
      const next = toggleDone(storeRef.current, rootId, Date.now());
      storeRef.current = next;
      setStore(next);
      writeThreadDoneStore(relayUrl, pubkey, next);
      managerRef.current?.publishDone(next);
    };
  }, [pubkey, relayUrl]);

  const done = React.useMemo(() => doneRoots(store), [store]);
  return { done, toggle };
}
