import type { ThreadTitle } from "@/shared/api/tauriThreadTitles";

/**
 * Thread activity this device has seen live: every threaded reply from the
 * relay subscription, whoever wrote it and whether or not it notifies, plus
 * the user's own sends. The titles list folds it over the relay's answer, so
 * a reply reopens a done thread at once rather than at the next poll, and a
 * poll that started before the reply cannot roll it back.
 */
export type ActivityFrontier = {
  /** Newest activity, unix seconds. */
  at: number;
  /** Ids of the events stamped `at`. */
  ids: readonly string[];
};

/** Roots remembered; the oldest activity is forgotten first. */
export const MAX_OBSERVED_ROOTS = 500;

/**
 * Ids one frontier keeps for its second, on every side: the Rust list, this
 * store and a done mark. Past it the frontier saturates and stops growing, so
 * a mark always covers the row it was made from and memory stays bounded; the
 * cost is that more than this many events in one second read as one.
 * Mirrors `MAX_ACTIVITY_IDS` in `commands/thread_titles.rs`.
 */
export const MAX_FRONTIER_IDS = 50;

let observed: ReadonlyMap<string, ActivityFrontier> = new Map();
const listeners = new Set<() => void>();

/**
 * Folds one event into a frontier; returns the same object when nothing
 * changes: an older second, a known id, or a saturated second.
 */
export function advanceFrontier(
  frontier: ActivityFrontier | undefined,
  at: number,
  id: string,
): ActivityFrontier {
  if (!frontier || at > frontier.at) return { at, ids: [id] };
  if (
    at < frontier.at ||
    frontier.ids.length >= MAX_FRONTIER_IDS ||
    frontier.ids.includes(id)
  ) {
    return frontier;
  }
  return { at, ids: [...frontier.ids, id] };
}

export function recordThreadActivity(
  rootId: string | null | undefined,
  createdAt: number,
  eventId: string,
): void {
  if (!rootId || !Number.isFinite(createdAt)) return;
  const root = rootId.toLowerCase();
  const current = observed.get(root);
  const next = advanceFrontier(current, createdAt, eventId);
  if (next === current) return;
  const updated = new Map(observed);
  updated.delete(root);
  updated.set(root, next);
  if (updated.size > MAX_OBSERVED_ROOTS) {
    let oldest: string | undefined;
    for (const [key, frontier] of updated) {
      if (!oldest || frontier.at < (updated.get(oldest)?.at ?? 0)) {
        oldest = key;
      }
    }
    if (oldest) updated.delete(oldest);
  }
  observed = updated;
  for (const listener of listeners) listener();
}

export function subscribeObservedThreadActivity(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getObservedThreadActivity(): ReadonlyMap<
  string,
  ActivityFrontier
> {
  return observed;
}

/** Test seam: forget everything observed. */
export function resetObservedThreadActivity(): void {
  observed = new Map();
  for (const listener of listeners) listener();
}

/**
 * The relay's list with observed activity folded in, newest first. Returns
 * the same array when nothing observed is newer, so a `select` built on it
 * keeps referential identity.
 */
export function mergeObservedActivity(
  titles: ThreadTitle[],
  activity: ReadonlyMap<string, ActivityFrontier>,
): ThreadTitle[] {
  if (activity.size === 0) return titles;
  let changed = false;
  const next = titles.map((entry) => {
    const seen = activity.get(entry.rootId.toLowerCase());
    if (!seen || seen.at < entry.lastActivityAt) return entry;
    let frontier: ActivityFrontier = {
      at: entry.lastActivityAt,
      ids: entry.lastActivityIds ?? [],
    };
    for (const id of seen.ids) {
      frontier = advanceFrontier(frontier, seen.at, id);
    }
    if (
      frontier.at === entry.lastActivityAt &&
      frontier.ids.length === (entry.lastActivityIds ?? []).length
    ) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      lastActivityAt: frontier.at,
      lastActivityIds: frontier.ids,
    };
  });
  if (!changed) return titles;
  // Stable, so ties keep the relay's order.
  return next.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}
