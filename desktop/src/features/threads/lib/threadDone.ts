import { MAX_FRONTIER_IDS } from "./observedThreadActivity";

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

export type ThreadDoneEntry = {
  done: boolean;
  updatedAt: number;
  /**
   * The thread's latest activity (seconds) when it was marked done, and the
   * ids of the events in that second. A later second, or an unseen id in the
   * same second, reopens the thread. Marks written before these fields fall
   * back to comparing activity with `updatedAt`.
   */
  activityAt?: number;
  activityIds?: readonly string[];
};

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

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

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
            isTimestamp(mark.updatedAt) &&
            (mark.activityAt === undefined || isTimestamp(mark.activityAt)) &&
            (mark.activityIds === undefined ||
              (Array.isArray(mark.activityIds) &&
                mark.activityIds.length <= MAX_FRONTIER_IDS &&
                mark.activityIds.every((id) => typeof id === "string")))
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

/**
 * Sets the state explicitly rather than flipping it: a thread reopened by new
 * activity is still stored as done, and marking it done again must restamp it.
 * `activity` is the thread's latest activity as the user saw it when marking.
 */
export function setThreadDone(
  store: ThreadDoneStore,
  rootId: string,
  done: boolean,
  nowMs: number,
  activity?: { at: number; ids: readonly string[] },
): ThreadDoneStore {
  const root = rootId.toLowerCase();
  const current = store.roots[root];
  // Strictly after the previous write, so a clock that stepped backwards
  // still produces a write that wins the merge.
  const updatedAt = Math.max(nowMs, (current?.updatedAt ?? 0) + 1);
  return {
    version: 1,
    roots: capEntries({
      ...store.roots,
      [root]:
        done && activity
          ? {
              done,
              updatedAt,
              activityAt: activity.at,
              activityIds: activity.ids.slice(0, MAX_FRONTIER_IDS),
            }
          : { done, updatedAt },
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

function sameIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((id, i) => id === right[i]);
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
      rightEntry.updatedAt === left.roots[root].updatedAt &&
      rightEntry.activityAt === left.roots[root].activityAt &&
      sameIds(rightEntry.activityIds, left.roots[root].activityIds)
    );
  });
}

/** Done thread roots → their done marks. */
export function doneRoots(
  store: ThreadDoneStore,
): ReadonlyMap<string, ThreadDoneEntry> {
  return new Map(Object.entries(store.roots).filter(([, entry]) => entry.done));
}

/**
 * A thread is done only while nothing has happened since it was marked:
 * any later activity, including the user's own reply, reopens it until it is
 * marked done again. That is a view rule, so no device writes to the store
 * when a reply lands.
 *
 * "Later" compares the thread's activity frontier with the one it had when
 * it was marked: a newer second, or an event in the same second the mark did
 * not include. Both sides are author-stamped, so the marking device's clock
 * plays no part. Unread replies also reopen it, covering a reply stamped
 * before the frontier until it is read.
 *
 * Accepted limits: a reply stamped before the frontier (its author's clock
 * running behind the previous replier's) in a thread nothing notifies you
 * about stays done until the next reply, since only relay ingest order could
 * tell it from a replayed old event. And past `MAX_FRONTIER_IDS` events in one
 * second, further events in that second are not told apart.
 */
export function isThreadDone(
  entry: {
    rootId: string;
    lastActivityAt: number;
    lastActivityIds?: readonly string[];
  },
  done: ReadonlyMap<string, ThreadDoneEntry>,
  unreadCounts: ReadonlyMap<string, number>,
): boolean {
  const mark = done.get(entry.rootId.toLowerCase());
  if (!mark) return false;
  const quiet =
    mark.activityAt !== undefined
      ? entry.lastActivityAt < mark.activityAt ||
        (entry.lastActivityAt === mark.activityAt &&
          (entry.lastActivityIds ?? []).every((id) =>
            (mark.activityIds ?? []).includes(id),
          ))
      : entry.lastActivityAt * 1000 <= mark.updatedAt;
  return quiet && (unreadCounts.get(entry.rootId) ?? 0) === 0;
}

/** Splits off done threads, keeping the incoming activity order. */
export function partitionByDone<
  T extends {
    rootId: string;
    lastActivityAt: number;
    lastActivityIds?: readonly string[];
  },
>(
  entries: readonly T[],
  done: ReadonlyMap<string, ThreadDoneEntry>,
  unreadCounts: ReadonlyMap<string, number>,
): { active: T[]; done: T[] } {
  const active: T[] = [];
  const doneEntries: T[] = [];
  for (const entry of entries) {
    (isThreadDone(entry, done, unreadCounts) ? doneEntries : active).push(
      entry,
    );
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
