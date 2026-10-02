import type { ThreadTitle } from "@/shared/api/tauriThreadTitles";

/** Same bound the relay enforces on the NIP-AR `title` tag. */
export const MAX_THREAD_TITLE_BYTES = 512;

export const THREAD_TITLES_QUERY_KEY = ["thread-titles"] as const;

/** The shared title for a thread, if one is set. */
export function findThreadTitle(
  titles: readonly ThreadTitle[] | undefined,
  channelId: string | null,
  rootId: string | null,
): ThreadTitle | null {
  if (!titles || !channelId || !rootId) {
    return null;
  }
  const root = rootId.toLowerCase();
  return (
    titles.find(
      (entry) => entry.channelId === channelId && entry.rootId === root,
    ) ?? null
  );
}

/**
 * The shared title for a thread root, in any channel. Event ids are unique and
 * the relay only accepts a title whose root exists in its home channel, so the
 * root alone identifies the thread.
 */
export function findThreadTitleByRoot(
  titles: readonly ThreadTitle[] | undefined,
  rootId: string | null,
): ThreadTitle | null {
  if (!titles || !rootId) {
    return null;
  }
  const root = rootId.toLowerCase();
  return titles.find((entry) => entry.rootId === root) ?? null;
}

/** User-facing message for a failed title save. */
export function describeTitleSaveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("conflict:")) {
    return "Someone else changed this thread's title while you were editing. Your change wasn't saved.";
  }
  return `Couldn't save the thread title: ${message}`;
}

export type TitleDraftResult =
  | { kind: "set"; title: string }
  | { kind: "clear" }
  | { kind: "unchanged" }
  | { kind: "too-long" };

/** Interpret an edited title: blank clears it, an unchanged value writes nothing. */
export function interpretTitleDraft(
  draft: string,
  current: string | null,
): TitleDraftResult {
  const title = draft.trim();
  if (title === (current ?? "")) {
    return { kind: "unchanged" };
  }
  if (title.length === 0) {
    return { kind: "clear" };
  }
  if (new TextEncoder().encode(title).length > MAX_THREAD_TITLE_BYTES) {
    return { kind: "too-long" };
  }
  return { kind: "set", title };
}

/** Optimistically apply a write to the cached list so the UI updates before the refetch. */
export function applyTitleWrite(
  titles: readonly ThreadTitle[] | undefined,
  write: {
    channelId: string;
    rootId: string;
    title: string | null;
    /** Stored revision once known; until then the previous one is kept. */
    revision?: string | null;
  },
  nowSeconds: number,
): ThreadTitle[] {
  const root = write.rootId.toLowerCase();
  const rest = (titles ?? []).filter(
    (entry) => !(entry.channelId === write.channelId && entry.rootId === root),
  );
  if (write.title === null) {
    return rest;
  }
  const previous = findThreadTitle(titles, write.channelId, root);
  return [
    {
      author: previous?.author ?? "",
      channelId: write.channelId,
      lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, nowSeconds),
      revision: write.revision ?? previous?.revision ?? "",
      rootId: root,
      title: write.title,
      updatedAt: nowSeconds,
    },
    ...rest,
  ];
}

/**
 * Unread reply counts per thread root, for the titled threads only. Replies
 * are counted once each, so a reply listed twice (live activity plus a
 * reopened Inbox row) can't inflate a count.
 */
export function countUnreadByTitledRoot(
  titles: readonly ThreadTitle[] | undefined,
  unreadReplies: ReadonlyArray<{ id: string; rootId: string | null }>,
): Map<string, number> {
  const titledRoots = new Set((titles ?? []).map((entry) => entry.rootId));
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const reply of unreadReplies) {
    const root = reply.rootId?.toLowerCase();
    if (!root || !titledRoots.has(root) || seen.has(reply.id)) {
      continue;
    }
    seen.add(reply.id);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}
