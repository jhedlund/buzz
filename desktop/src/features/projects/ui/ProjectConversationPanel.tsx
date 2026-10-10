import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useChannelMembersQuery,
  useChannelsQuery,
} from "@/features/channels/hooks";
import { getThreadPanelLayout } from "@/features/channels/lib/threadPanelLayout";
import { FocusThreadDrawer } from "@/features/channels/ui/FocusThreadDrawer";
import { RightAuxiliaryPane } from "@/features/channels/ui/RightAuxiliaryPane";
import {
  useChannelSubscription,
  useSendMessageMutation,
  useToggleReactionMutation,
} from "@/features/messages/hooks";
import { getThreadReference } from "@/features/messages/lib/threading";
import { useIndependentThreadPanel } from "@/features/messages/useIndependentThreadPanel";
import { useThreadReplies } from "@/features/messages/useThreadReplies";
import { MessageThreadPanel } from "@/features/messages/ui/MessageThreadPanel";
import { MessageThreadPanelSkeleton } from "@/features/messages/ui/MessageThreadPanelSkeleton";
import type { TimelineMessage } from "@/features/messages/types";
import { useProfileQuery, useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { SearchHit } from "@/shared/api/searchTypes";
import { getEventById } from "@/shared/api/tauri";
import type { RelayEvent, RespondToMode } from "@/shared/api/types";
import { useIsThreadPanelOverlay } from "@/shared/hooks/use-mobile";
import { Button } from "@/shared/ui/button";

const EMPTY_PERSONA_LOOKUP = new Map<string, string>();
const EMPTY_RESPOND_TO_LOOKUP = new Map<string, RespondToMode>();

async function loadConversationEvent(eventId: string) {
  return getEventById(eventId);
}

/** The event to open and, when known, its thread root. */
export type ConversationTarget = Pick<
  SearchHit,
  "channelId" | "channelName" | "eventId" | "threadRootId"
>;

/** Opens the thread as the large focus drawer instead of the side pane. */
export type ConversationFocusDrawer = {
  /** Names the scrim behind the drawer, e.g. "Back to Threads". */
  backLabel: string;
};

/** Channel thread shown beside project details and the Threads view. */
export function ProjectConversationPanel({
  canResetWidth,
  focusDrawer,
  headerLeading,
  hit,
  onClose,
  onResetWidth,
  onResizeStart,
  sharedHeaderBackdrop,
  widthPx,
}: {
  canResetWidth: boolean;
  /** Ignored while the window is narrow enough for the floating overlay. */
  focusDrawer?: ConversationFocusDrawer;
  headerLeading?: React.ReactNode;
  hit: ConversationTarget;
  onClose: () => void;
  onResetWidth: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
  sharedHeaderBackdrop?: boolean;
  widthPx: number;
}) {
  const { goChannel } = useAppNavigation();
  const channelsQuery = useChannelsQuery();
  const activeChannel =
    channelsQuery.data?.find((channel) => channel.id === hit.channelId) ?? null;
  const channelId = activeChannel?.id ?? hit.channelId ?? null;
  const channelLabel = activeChannel?.name ?? hit.channelName ?? null;
  const identityQuery = useIdentityQuery();
  const profileQuery = useProfileQuery();
  const membersQuery = useChannelMembersQuery(activeChannel?.id ?? null);
  const targetQuery = useQuery({
    queryKey: ["project-conversation-target", hit.eventId],
    queryFn: () => loadConversationEvent(hit.eventId),
  });
  const targetEvent = targetQuery.data ?? null;
  const targetThread = targetEvent
    ? getThreadReference(targetEvent.tags)
    : null;
  const rootId =
    hit.threadRootId ??
    targetThread?.rootId ??
    targetThread?.parentId ??
    targetEvent?.id ??
    null;
  const rootQuery = useQuery({
    queryKey: ["project-conversation-root", rootId ?? "none"],
    queryFn: () =>
      rootId ? loadConversationEvent(rootId) : Promise.resolve(null),
    enabled: Boolean(rootId && rootId !== targetEvent?.id),
  });
  const threadRepliesQuery = useThreadReplies(activeChannel, rootId);
  const repliesQueryEnabled =
    activeChannel != null &&
    activeChannel.channelType !== "forum" &&
    rootId != null;
  useChannelSubscription(activeChannel);
  const threadReplyEvents = threadRepliesQuery.data ?? [];
  const rootEvent =
    rootId && targetEvent?.id === rootId
      ? targetEvent
      : (rootQuery.data ?? null);
  const rootEvents = React.useMemo(
    () => (rootEvent ? [rootEvent] : []),
    [rootEvent],
  );
  const profilePubkeys = React.useMemo(
    () => [
      ...new Set(
        [rootEvent, ...threadReplyEvents]
          .filter((event): event is RelayEvent => event !== null)
          .map((event) => event.pubkey),
      ),
    ],
    [rootEvent, threadReplyEvents],
  );
  const profilesQuery = useUsersBatchQuery(profilePubkeys, {
    enabled: profilePubkeys.length > 0,
  });
  const profiles = profilesQuery.data?.profiles;
  const [expandedReplyIds, setExpandedReplyIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const expansionKey = rootId ? `${hit.eventId}:${rootId}` : null;
  const [appliedExpansionKey, setAppliedExpansionKey] = React.useState<
    string | null
  >(null);
  const [replyTargetId, setReplyTargetId] = React.useState<string | null>(
    rootId,
  );
  const [scrollTargetId, setScrollTargetId] = React.useState<string | null>(
    hit.eventId === rootId ? null : hit.eventId,
  );
  const threadIdentity = `${hit.eventId}:${rootId ?? ""}`;
  const threadIdentityRef = React.useRef(threadIdentity);
  if (threadIdentityRef.current !== threadIdentity) {
    threadIdentityRef.current = threadIdentity;
    setAppliedExpansionKey(null);
    setExpandedReplyIds(new Set());
    setReplyTargetId(rootId);
    setScrollTargetId(hit.eventId === rootId ? null : hit.eventId);
  }
  if (
    expansionKey &&
    repliesQueryEnabled &&
    threadRepliesQuery.isFetched &&
    appliedExpansionKey !== expansionKey
  ) {
    setAppliedExpansionKey(expansionKey);
    setExpandedReplyIds(new Set(threadReplyEvents.map((event) => event.id)));
  }

  const panelData = useIndependentThreadPanel({
    activeChannel,
    channelEvents: rootEvents,
    threadReplyEvents,
    rootId,
    replyTargetId,
    expandedReplyIds,
    currentPubkey: identityQuery.data?.pubkey,
    currentAvatarUrl: profileQuery.data?.avatarUrl ?? null,
    profiles,
    ownerProfiles: profiles,
    members: membersQuery.data,
    personaLookup: EMPTY_PERSONA_LOOKUP,
    respondToLookup: EMPTY_RESPOND_TO_LOOKUP,
    relaySelfPubkey: null,
  });
  const sendMessageMutation = useSendMessageMutation(
    activeChannel,
    identityQuery.data,
  );
  const toggleReactionMutation = useToggleReactionMutation();
  const isOverlay = useIsThreadPanelOverlay();
  const isComposerDisabled =
    !activeChannel?.isMember ||
    activeChannel.archivedAt !== null ||
    activeChannel.channelType === "forum";
  const canShowThread =
    Boolean(activeChannel && panelData.threadHead) &&
    (expansionKey == null ||
      !repliesQueryEnabled ||
      appliedExpansionKey === expansionKey);
  const isResolving =
    !canShowThread &&
    (channelsQuery.isPending ||
      targetQuery.isPending ||
      Boolean(
        rootId &&
          targetEvent &&
          rootId !== targetEvent.id &&
          rootQuery.isPending,
      ) ||
      Boolean(repliesQueryEnabled && !threadRepliesQuery.isFetched) ||
      Boolean(
        repliesQueryEnabled &&
          expansionKey &&
          threadRepliesQuery.isFetched &&
          appliedExpansionKey !== expansionKey,
      ));
  const openChannel = React.useCallback(() => {
    if (channelId) void goChannel(channelId);
  }, [channelId, goChannel]);
  const activeFocusDrawer = isOverlay ? undefined : focusDrawer;
  const layoutProps = {
    canResetWidth,
    enterMotion: !canShowThread,
    headerLeading,
    headerTitle: channelLabel ? `#${channelLabel}` : "Thread",
    headerTitleAriaLabel: channelLabel ? `Open #${channelLabel}` : undefined,
    isFocusMode: false,
    isSinglePanelView: !isOverlay,
    layout: "standalone" as const,
    onHeaderTitleClick: channelId ? openChannel : undefined,
    onResetWidth,
    onResizeStart,
    showBackButton: false,
    splitPaneClamp: false,
    testId: isOverlay ? "project-conversation-panel" : "message-thread-panel",
    transparentChrome: sharedHeaderBackdrop,
    ...(activeFocusDrawer
      ? getThreadPanelLayout({
          headerLeading,
          isFocusDrawer: true,
          isSinglePanelView: true,
          useSplitAuxiliaryPane: true,
        })
      : null),
  };
  const paneOptions = {
    canResetWidth,
    channelName: activeChannel?.name ?? hit.channelName ?? "channel",
    focusDrawer: activeFocusDrawer,
    isOverlay,
    onClose,
    onResetWidth,
    onResizeStart,
    widthPx,
  };

  const handleSend = React.useCallback(
    async (
      content: string,
      mentionPubkeys: string[],
      mediaTags?: string[][],
      channelId?: string | null,
      threadContext?: {
        parentEventId: string | null;
        threadHeadId: string | null;
      } | null,
    ) => {
      if (!activeChannel || !rootId) return;
      const parentEventId =
        threadContext?.parentEventId ?? replyTargetId ?? rootId;
      const sentMessage = await sendMessageMutation.mutateAsync({
        channelId: channelId ?? activeChannel.id,
        content,
        mediaTags,
        mentionPubkeys,
        parentEventId,
        targetChannel: activeChannel,
      });
      setReplyTargetId(rootId);
      setExpandedReplyIds((current) => new Set(current).add(parentEventId));
      setScrollTargetId(sentMessage.id);
    },
    [activeChannel, replyTargetId, rootId, sendMessageMutation.mutateAsync],
  );
  const handleExpandReplies = React.useCallback((message: TimelineMessage) => {
    setExpandedReplyIds((current) => {
      const next = new Set(current);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
  }, []);

  if (canShowThread && activeChannel && panelData.threadHead) {
    return wrapProjectConversationPane(
      <MessageThreadPanel
        {...layoutProps}
        activityAccessoryVisible={false}
        channel={activeChannel}
        channelId={activeChannel.id}
        channelName={activeChannel.name}
        currentPubkey={identityQuery.data?.pubkey}
        disabled={isComposerDisabled}
        isSending={sendMessageMutation.isPending}
        onCancelReply={() => setReplyTargetId(rootId)}
        onClose={onClose}
        onExpandReplies={handleExpandReplies}
        onScrollTargetResolved={() => setScrollTargetId(null)}
        onSelectReplyTarget={(message) => setReplyTargetId(message.id)}
        onSend={handleSend}
        onToggleReaction={
          isComposerDisabled
            ? undefined
            : async (message, emoji, remove) => {
                await toggleReactionMutation.mutateAsync({
                  emoji,
                  eventId: message.id,
                  remove,
                });
              }
        }
        profiles={profiles}
        replyTargetMessage={panelData.replyTargetMessage}
        scrollTargetId={scrollTargetId}
        threadHead={panelData.threadHead}
        threadReplies={panelData.visibleReplies}
        threadRepliesPending={threadRepliesQuery.isPending}
        threadRepliesError={threadRepliesQuery.isError}
        onRetryThreadReplies={() => {
          void threadRepliesQuery.refetch();
        }}
        threadTypingPubkeys={[]}
        widthPx={widthPx}
      />,
      paneOptions,
    );
  }

  if (isResolving) {
    return wrapProjectConversationPane(
      <MessageThreadPanelSkeleton
        {...layoutProps}
        onClose={onClose}
        widthPx={widthPx}
      />,
      paneOptions,
    );
  }

  return wrapProjectConversationPane(
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <p className="text-sm text-muted-foreground">
        This conversation could not be loaded.
      </p>
      <Button onClick={onClose} size="sm" variant="outline">
        Close
      </Button>
    </div>,
    paneOptions,
  );
}

function wrapProjectConversationPane(
  panel: React.ReactNode,
  {
    canResetWidth,
    channelName,
    focusDrawer,
    isOverlay,
    onClose,
    onResetWidth,
    onResizeStart,
    widthPx,
  }: {
    canResetWidth: boolean;
    channelName: string;
    focusDrawer: ConversationFocusDrawer | undefined;
    isOverlay: boolean;
    onClose: () => void;
    onResetWidth: () => void;
    onResizeStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
    widthPx: number;
  },
) {
  if (isOverlay) return panel;
  if (focusDrawer) {
    return (
      <FocusThreadDrawer
        backLabel={focusDrawer.backLabel}
        channelName={channelName}
        onClose={onClose}
      >
        {panel}
      </FocusThreadDrawer>
    );
  }
  return (
    <RightAuxiliaryPane
      canResetWidth={canResetWidth}
      onResetWidth={onResetWidth}
      onResizeStart={onResizeStart}
      testId="project-conversation-panel"
      widthPx={widthPx}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden [&>aside]:!h-full [&>aside]:!w-full [&>aside]:!max-w-none [&>aside]:!border-l-0">
        {panel}
      </div>
    </RightAuxiliaryPane>
  );
}
