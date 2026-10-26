/**
 * Marking a thread done is a personal triage flag, like a pin: it never
 * touches the shared title artifact. The store mirrors `threadPins.ts` under
 * its own NIP-78 d-tag (see `threadDoneSync.ts`), so a build without this
 * feature never reads or rewrites it. Reopened threads are kept as tombstones
 * so a per-root last-writer-wins merge cannot mark them done again.
 */
const THREAD_DONE_PREFIX = "buzz.threads.done.v1";
/** Upper bound on stored roots, done marks and tombstones together. */
export const MAX_THREAD_DONE_ENTRIES = 500;

export type ThreadDoneEntry = { done: boolean; updatedAt: number };

export type ThreadDoneStore = {
  version: 1;
  /** Thread root id (lowercase hex) → latest done state. */
  roots: Record<string, ThreadDoneEntry>;
};

export const EMPTY_THREAD_DONE_STORE: ThreadDoneStore = Object.freeze({
  version: 1,
  roots: Object.freeze({}),
}) as ThreadDoneStore;

const ROOT_ID_RE = /^[0-9a-f]{64}$/;

export function threadDoneStorageKey(relayOrigin: string, pubkey: string) {
  return `${THREAD_DONE_PREFIX}.${encodeURIComponent(relayOrigin)}.${pubkey.toLowerCase()}`;
}

export function parseThreadDonePayload(value: unknown): ThreadDoneStore | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, roots } = value as Record<string, unknown>;
  if (version !== 1) return null;
  if (!roots || typeof roots !== "object" || Array.isArray(roots)) return null;
  return {
    version: 1,
    roots: Object.fromEntries(
      Object.entries(roots as Record<string, unknown>).filter(
        (entry): entry is [string, ThreadDoneEntry] => {
          const mark = entry[1] as Record<string, unknown> | null;
          return (
            ROOT_ID_RE.test(entry[0]) &&
            typeof mark === "object" &&
            mark !== null &&
            typeof mark.done === "boolean" &&
            typeof mark.updatedAt === "number" &&
            Number.isFinite(mark.updatedAt) &&
            mark.updatedAt >= 0
          );
        },
      ),
    ),
  };
}

/**
 * Keeps the store bounded: tombstones go first, then the oldest done marks,
 * whose threads then show as active again.
 */
function capEntries(roots: Record<string, ThreadDoneEntry>) {
  const entries = Object.entries(roots);
  if (entries.length <= MAX_THREAD_DONE_ENTRIES) return roots;
  entries.sort(
    ([, left], [, right]) =>
      Number(right.done) - Number(left.done) ||
      right.updatedAt - left.updatedAt,
  );
  return Object.fromEntries(entries.slice(0, MAX_THREAD_DONE_ENTRIES));
}

export function toggleDone(
  store: ThreadDoneStore,
  rootId: string,
  nowMs: number,
): ThreadDoneStore {
  const root = rootId.toLowerCase();
  const current = store.roots[root];
  // Strictly after the previous write, so a clock that stepped backwards
  // still produces a toggle that wins the merge.
  const updatedAt = Math.max(nowMs, (current?.updatedAt ?? 0) + 1);
  return {
    version: 1,
    roots: capEntries({
      ...store.roots,
      [root]: { done: !current?.done, updatedAt },
    }),
  };
}

/** Per-root last-writer-wins; an exact tie resolves to not done. */
export function mergeThreadDoneStores(
  local: ThreadDoneStore,
  remote: ThreadDoneStore,
): ThreadDoneStore {
  const roots: Record<string, ThreadDoneEntry> = { ...local.roots };
  for (const [root, remoteEntry] of Object.entries(remote.roots)) {
    const localEntry = roots[root];
    if (!localEntry || remoteEntry.updatedAt > localEntry.updatedAt) {
      roots[root] = remoteEntry;
    } else if (
      remoteEntry.updatedAt === localEntry.updatedAt &&
      remoteEntry.done !== localEntry.done
    ) {
      roots[root] = { done: false, updatedAt: localEntry.updatedAt };
    }
  }
  return { version: 1, roots: capEntries(roots) };
}

export function threadDoneStoresEqual(
  left: ThreadDoneStore,
  right: ThreadDoneStore,
): boolean {
  const leftKeys = Object.keys(left.roots);
  if (leftKeys.length !== Object.keys(right.roots).length) return false;
  return leftKeys.every((root) => {
    const rightEntry = right.roots[root];
    return (
      rightEntry !== undefined &&
      rightEntry.done === left.roots[root].done &&
      rightEntry.updatedAt === left.roots[root].updatedAt
    );
  });
}

export function doneRoots(store: ThreadDoneStore): ReadonlySet<string> {
  return new Set(
    Object.entries(store.roots)
      .filter(([, entry]) => entry.done)
      .map(([root]) => root),
  );
}

/**
 * Splits off done threads, keeping the incoming activity order. A done thread
 * with unread replies stays active so new activity on it can't be missed;
 * that is a view rule, so no device writes to the store when a reply lands.
 */
export function partitionByDone<T extends { rootId: string }>(
  entries: readonly T[],
  done: ReadonlySet<string>,
  unreadCounts: ReadonlyMap<string, number>,
): { active: T[]; done: T[] } {
  const active: T[] = [];
  const doneEntries: T[] = [];
  for (const entry of entries) {
    const isDone =
      done.has(entry.rootId.toLowerCase()) &&
      (unreadCounts.get(entry.rootId) ?? 0) === 0;
    (isDone ? doneEntries : active).push(entry);
  }
  return { active, done: doneEntries };
}

export function readThreadDoneStore(
  relayOrigin: string,
  pubkey: string,
): ThreadDoneStore {
  try {
    const raw = globalThis.localStorage?.getItem(
      threadDoneStorageKey(relayOrigin, pubkey),
    );
    if (!raw) return EMPTY_THREAD_DONE_STORE;
    return parseThreadDonePayload(JSON.parse(raw)) ?? EMPTY_THREAD_DONE_STORE;
  } catch {
    return EMPTY_THREAD_DONE_STORE;
  }
}

/** Best-effort mirror; the caller's in-memory state stays authoritative. */
export function writeThreadDoneStore(
  relayOrigin: string,
  pubkey: string,
  store: ThreadDoneStore,
): void {
  try {
    globalThis.localStorage?.setItem(
      threadDoneStorageKey(relayOrigin, pubkey),
      JSON.stringify(store),
    );
  } catch {
    // The mark still applies for this session and syncs via the relay.
  }
}
