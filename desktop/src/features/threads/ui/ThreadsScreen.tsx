import { MessagesSquare, Pin } from "lucide-react";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  mergeOpenChannelDirectory,
  useOpenChannelDirectoryQuery,
} from "@/features/channels/openChannelDirectory";
import { formatRelativeTime } from "@/features/forum/lib/time";
import { resolveChannelDisplayLabel } from "@/features/sidebar/lib/channelLabels";
import {
  useThreadTitlesQuery,
  useTitledThreadUnreadCounts,
} from "@/features/threads/hooks";
import { partitionByPin } from "@/features/threads/lib/threadPins";
import { useThreadPins } from "@/features/threads/lib/useThreadPins";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import type { ThreadTitle } from "@/shared/api/tauriThreadTitles";
import type { Channel } from "@/shared/api/types";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";

function channelLabel(
  channel: Channel | undefined,
  currentPubkey: string | undefined,
): string {
  if (!channel) {
    return "Unknown channel";
  }
  const label = resolveChannelDisplayLabel(channel, currentPubkey, undefined);
  return channel.channelType === "dm" ? label : `#${label}`;
}

function ThreadRow({
  channel,
  currentPubkey,
  entry,
  onOpen,
  onTogglePin,
  pinned,
  unreadCount,
}: {
  channel: Channel | undefined;
  currentPubkey: string | undefined;
  entry: ThreadTitle;
  onOpen: (entry: ThreadTitle, channel: Channel | undefined) => void;
  onTogglePin: ((rootId: string) => void) | undefined;
  pinned: boolean;
  unreadCount: number;
}) {
  const hasUnread = unreadCount > 0;
  return (
    <div className="group/thread-row relative flex min-w-0 items-center rounded-lg hover:bg-accent focus-within:bg-accent">
      <button
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left focus-visible:outline-none"
        data-pinned={pinned ? "true" : undefined}
        data-testid="threads-view-row"
        data-unread={hasUnread ? "true" : undefined}
        onClick={() => onOpen(entry, channel)}
        type="button"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              hasUnread
                ? "font-bold text-foreground"
                : "font-normal text-foreground/80",
            )}
          >
            {entry.title}
          </span>
          {hasUnread ? (
            <span
              className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary"
              data-testid="threads-view-row-unread"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-primary"
              />
              {unreadCount} new
            </span>
          ) : null}
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {channelLabel(channel, currentPubkey)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">
            {formatRelativeTime(entry.lastActivityAt)}
          </span>
        </span>
      </button>
      {onTogglePin ? (
        <button
          aria-label={pinned ? "Unpin thread" : "Pin thread"}
          aria-pressed={pinned}
          className={cn(
            "mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            pinned
              ? "text-primary"
              : "opacity-0 group-hover/thread-row:opacity-100 group-focus-within/thread-row:opacity-100",
          )}
          data-testid="threads-view-row-pin"
          onClick={() => onTogglePin(entry.rootId)}
          title={pinned ? "Unpin thread" : "Pin thread"}
          type="button"
        >
          <Pin className={cn("h-3.5 w-3.5", pinned && "fill-current")} />
        </button>
      ) : null}
    </div>
  );
}

function ThreadsBody() {
  const titlesQuery = useThreadTitlesQuery({ refetchInterval: true });
  const unreadCounts = useTitledThreadUnreadCounts();
  const channelsQuery = useChannelsQuery();
  const currentPubkey = useIdentityQuery().data?.pubkey;
  const relayOrigin = useRelayOrigin();
  const { pinned: pinnedRoots, toggle: handleTogglePin } = useThreadPins(
    relayOrigin,
    currentPubkey,
  );
  const { goChannel, goForumPost } = useAppNavigation();
  // Titles also come from open channels the user hasn't joined; only then pay
  // for the all-open directory scan (React Query dedups it across surfaces).
  const needsDirectory =
    channelsQuery.isSuccess &&
    (titlesQuery.data ?? []).some(
      (entry) =>
        !channelsQuery.data.some((channel) => channel.id === entry.channelId),
    );
  const openDirectoryQuery = useOpenChannelDirectoryQuery({
    enabled: needsDirectory,
  });
  const channelsById = React.useMemo(
    () =>
      new Map(
        mergeOpenChannelDirectory(
          channelsQuery.data ?? [],
          openDirectoryQuery.data,
        ).map((channel) => [channel.id, channel]),
      ),
    [channelsQuery.data, openDirectoryQuery.data],
  );

  const handleOpen = React.useCallback(
    (entry: ThreadTitle, channel: Channel | undefined) => {
      if (channel?.channelType === "forum") {
        void goForumPost(entry.channelId, entry.rootId);
        return;
      }
      void goChannel(entry.channelId, {
        messageId: entry.rootId,
        threadRootId: entry.rootId,
      });
    },
    [goChannel, goForumPost],
  );

  if (titlesQuery.isPending) {
    return (
      <div className="space-y-3 px-3 py-2">
        {[1, 2, 3, 4].map((i) => (
          <div className="space-y-1.5" key={i}>
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    );
  }

  if (titlesQuery.isError) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Couldn't load thread titles.
        </p>
        <Button
          onClick={() => void titlesQuery.refetch()}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (titlesQuery.data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
        <MessagesSquare className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No named threads</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Open a thread and use the pencil next to its title to name it. Named
          threads show up here, most recently active first.
        </p>
      </div>
    );
  }

  const { pinned, unpinned } = partitionByPin(titlesQuery.data, pinnedRoots);
  const renderRows = (entries: ThreadTitle[], isPinned: boolean) =>
    entries.map((entry) => (
      <li key={`${entry.channelId}:${entry.rootId}`}>
        <ThreadRow
          channel={channelsById.get(entry.channelId)}
          currentPubkey={currentPubkey}
          entry={entry}
          onOpen={handleOpen}
          onTogglePin={handleTogglePin}
          pinned={isPinned}
          unreadCount={unreadCounts.get(entry.rootId) ?? 0}
        />
      </li>
    ));

  if (pinned.length === 0) {
    return (
      <ul aria-label="Named threads" className="flex flex-col">
        {renderRows(unpinned, false)}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <section aria-labelledby="threads-view-pinned-heading">
        <h2
          className="px-3 pb-1 text-xs font-medium text-muted-foreground"
          id="threads-view-pinned-heading"
        >
          Pinned
        </h2>
        <ul
          aria-label="Pinned threads"
          className="flex flex-col"
          data-testid="threads-view-pinned"
        >
          {renderRows(pinned, true)}
        </ul>
      </section>
      {unpinned.length > 0 ? (
        <section aria-labelledby="threads-view-recent-heading">
          <h2
            className="px-3 pb-1 text-xs font-medium text-muted-foreground"
            id="threads-view-recent-heading"
          >
            Recent
          </h2>
          <ul aria-label="Named threads" className="flex flex-col">
            {renderRows(unpinned, false)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Named threads across every readable channel, most recently active first. */
export function ThreadsScreen() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <TopChromeInsetHeader flush transparent>
        <div className="px-5 py-2">
          <div className="flex min-h-9 items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Threads</h1>
          </div>
        </div>
      </TopChromeInsetHeader>
      <p
        className="border-b border-border/60 px-5 pb-3 text-sm text-muted-foreground"
        data-testid="threads-view-subheader"
      >
        Named threads, most recent activity first. Name any thread from its
        header; pin one to keep it at the top.
      </p>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="threads-view"
      >
        <div className="w-full max-w-3xl px-2 pb-10 pt-2">
          <ThreadsBody />
        </div>
      </div>
    </div>
  );
}
