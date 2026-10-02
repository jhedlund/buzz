import { MessagesSquare } from "lucide-react";
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
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ThreadTitle } from "@/shared/api/tauriThreadTitles";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
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
  unreadCount,
}: {
  channel: Channel | undefined;
  currentPubkey: string | undefined;
  entry: ThreadTitle;
  onOpen: (entry: ThreadTitle, channel: Channel | undefined) => void;
  unreadCount: number;
}) {
  const hasUnread = unreadCount > 0;
  return (
    <button
      className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
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
  );
}

function ThreadsBody() {
  const titlesQuery = useThreadTitlesQuery({ refetchInterval: true });
  const unreadCounts = useTitledThreadUnreadCounts();
  const channelsQuery = useChannelsQuery();
  const currentPubkey = useIdentityQuery().data?.pubkey;
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

  return (
    <ul aria-label="Named threads" className="flex flex-col">
      {titlesQuery.data.map((entry) => (
        <li key={`${entry.channelId}:${entry.rootId}`}>
          <ThreadRow
            channel={channelsById.get(entry.channelId)}
            currentPubkey={currentPubkey}
            entry={entry}
            onOpen={handleOpen}
            unreadCount={unreadCounts.get(entry.rootId) ?? 0}
          />
        </li>
      ))}
    </ul>
  );
}

/** Named threads across every readable channel, most recently active first. */
export function ThreadsScreen() {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
        data-testid="threads-view"
      >
        <div className="mx-auto w-full max-w-6xl space-y-6">
          <PageHeader
            description={
              <span data-testid="threads-view-subheader">
                Named threads, most recent activity first. Name any thread from
                its header.
              </span>
            }
            title="Threads"
          />
          {/* Rows pad their hover background; pull them out to align text. */}
          <div className="-mx-3">
            <ThreadsBody />
          </div>
        </div>
      </div>
    </div>
  );
}
