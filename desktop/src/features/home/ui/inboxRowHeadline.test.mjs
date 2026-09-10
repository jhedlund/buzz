/**
 * Rendered coverage for the Inbox row headline.
 *
 * The contract only exists where the derivation in `buildInboxItems` meets the
 * row markup in `InboxListPane`, so this test drives the real feed → row path:
 *
 *   - a row whose thread root carries a subject renders that subject as the
 *     primary line, ahead of the type label,
 *   - its sender folds into the type-label line rather than disappearing,
 *   - a row with no derivable subject keeps today's layout exactly — sender on
 *     the primary line, no headline, and no duplicated type label.
 *
 * Nothing is stubbed but the environment: no Tauri command is reached, and the
 * pane renders its production markup.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const SELF = "1".repeat(64);
const AUTHOR = "2".repeat(64);
const REPLIER = "3".repeat(64);
const RELAY_URL = "wss://relay.example";

const NAMED_ROOT_ID = "named-root";
const NAMED_REPLY_ID = "named-reply";
const ORPHAN_REPLY_ID = "orphan-reply";
const SUBJECT = "Threads have no editable, shared subject";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

class NoopWebSocket {
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}
globalThis.WebSocket = NoopWebSocket;
dom.window.WebSocket = NoopWebSocket;

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  IntersectionObserver: NoopObserver,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: NoopObserver,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  self: dom.window,
  window: dom.window,
});
// Bulk-copy DOM constructors Radix / React reference without a window prefix.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (
    !(key in globalThis) &&
    (key.startsWith("HTML") ||
      key.startsWith("SVG") ||
      [
        "Element",
        "DOMRect",
        "DOMRectReadOnly",
        "Node",
        "NodeFilter",
        "NodeList",
        "NamedNodeMap",
        "Event",
        "CustomEvent",
        "MouseEvent",
        "KeyboardEvent",
        "FocusEvent",
        "InputEvent",
        "PointerEvent",
        "Text",
        "Comment",
        "DocumentFragment",
        "Range",
        "Selection",
      ].includes(key))
  ) {
    const value = dom.window[key];
    if (value !== undefined) globalThis[key] = value;
  }
}
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
  writable: true,
});
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
globalThis.matchMedia = dom.window.matchMedia;
dom.window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
dom.window.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;

const originalDispatch = dom.window.EventTarget.prototype.dispatchEvent;
dom.window.EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
  if (!(event instanceof dom.window.Event)) return false;
  return originalDispatch.call(this, event);
};
globalThis.EventTarget = dom.window.EventTarget;

// The virtualized Inbox list measures its scroll container; JSDOM reports zero
// layout, so force a nonzero box or no row is ever mounted.
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return 600;
  },
});
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 400;
  },
});

globalThis.__TAURI_INTERNALS__ = {
  invoke: (command) => {
    if (command === "get_identity") {
      return Promise.resolve({ pubkey: SELF, display_name: "Me" });
    }
    if (command === "get_channels") {
      return Promise.resolve({ hash: "h", channels: [], last_messages: {} });
    }
    if (command === "get_users_batch") {
      return Promise.resolve({ profiles: {}, missing: [] });
    }
    if (command === "get_channel_members") return Promise.resolve({});
    if (command === "get_open_channel_directory") return Promise.resolve([]);
    if (command.startsWith("plugin:event|")) return Promise.resolve(0);
    return Promise.reject(new Error(`unmocked Tauri command: ${command}`));
  },
  transformCallback: () => 1,
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
dom.window.__TAURI_EVENT_PLUGIN_INTERNALS__ =
  globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__;

function seedCommunity() {
  window.localStorage.setItem(
    "buzz-communities",
    JSON.stringify([
      {
        id: "community-a",
        name: "Community A",
        relayUrl: RELAY_URL,
        pubkey: SELF,
        addedAt: "2026-01-01T00:00:00Z",
      },
    ]),
  );
  window.localStorage.setItem("buzz-active-community-id", "community-a");
}

const channels = [{ id: CHANNEL_ID, name: "buzz-dev", channelType: "stream" }];

function feedItem(overrides) {
  return {
    channelId: CHANNEL_ID,
    channelName: "buzz-dev",
    content: "",
    createdAt: 1_700_000_000,
    kind: 9,
    pubkey: AUTHOR,
    tags: [["h", CHANNEL_ID]],
    ...overrides,
  };
}

/**
 * One named thread (root in the feed, subject tag present) and one orphan
 * mention whose root is not in the feed — the two shapes the headline rule
 * has to tell apart.
 */
const FEED = {
  feed: {
    mentions: [
      feedItem({
        id: NAMED_REPLY_ID,
        content: "Agreed, but the label has to survive an unknown kind.",
        createdAt: 1_700_000_200,
        pubkey: REPLIER,
        tags: [
          ["h", CHANNEL_ID],
          ["e", NAMED_ROOT_ID, "", "root"],
          ["e", NAMED_ROOT_ID, "", "reply"],
        ],
      }),
      feedItem({
        id: ORPHAN_REPLY_ID,
        content: "Bumping this — still no traction.",
        createdAt: 1_700_000_100,
        pubkey: REPLIER,
        tags: [
          ["h", CHANNEL_ID],
          ["e", "root-not-in-feed", "", "root"],
          ["e", "root-not-in-feed", "", "reply"],
        ],
      }),
    ],
    needsAction: [],
    activity: [
      feedItem({
        id: NAMED_ROOT_ID,
        content: "Opening line nobody should see as the headline.",
        tags: [
          ["h", CHANNEL_ID],
          ["subject", SUBJECT],
        ],
      }),
    ],
    agentActivity: [],
  },
  meta: { since: 0, total: 3, generatedAt: 0 },
};

let React;
let act;
let createRoot;
let QueryClient;
let QueryClientProvider;
let CommunitiesProvider;
let RouterContextProvider;
let TooltipProvider;
let InboxListPane;
let buildInboxItems;
let router;

before(async () => {
  ({ default: React, act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ TooltipProvider } = await import("@/shared/ui/tooltip.tsx"));
  const {
    RouterContextProvider: RouterCtx,
    createMemoryHistory,
    createRootRoute,
    createRouter,
  } = await import("@tanstack/react-router");
  RouterContextProvider = RouterCtx;
  const rootRoute = createRootRoute();
  router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  ({ QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  ));
  ({ CommunitiesProvider } = await import(
    "@/features/communities/useCommunities.tsx"
  ));
  ({ buildInboxItems } = await import("@/features/home/lib/inbox.ts"));
  ({ InboxListPane } = await import("./InboxListPane.tsx"));
});

after(() => dom.window.close());

async function mountInbox(pickItems = (items) => items) {
  seedCommunity();
  const allItems = buildInboxItems({
    channels,
    currentPubkey: SELF,
    feed: FEED,
  });
  const items = pickItems(allItems);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  });
  client.setQueryData(["identity"], { pubkey: SELF, displayName: "Me" });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const tree = () =>
    React.createElement(
      RouterContextProvider,
      { router },
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          CommunitiesProvider,
          null,
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(InboxListPane, {
              activeDraftCount: 0,
              draftItems: [],
              doneSet: new Set(),
              dueReminderCount: 0,
              filter: "all",
              items,
              onFilterChange() {},
              onDeleteDraft() {},
              onMarkRead() {},
              onMarkUnread() {},
              onOpenDirect() {},
              onRemindLater() {},
              onSelect() {},
              onSelectDraft() {},
              onSelectReminder() {},
              onUnreadOnlyChange() {},
              reminders: [],
              selectedConversationId: null,
              selectedDraftKey: null,
              selectedReminderId: null,
              unreadOnly: false,
            }),
          ),
        ),
      ),
    );

  await act(async () => {
    root.render(tree());
  });
  // A second commit lets VirtualizedList's layout effect re-run once the
  // caller-owned scroll container is attached, so the list rows measure and
  // render (child layout effects fire before the parent ref is populated).
  await act(async () => {
    root.render(tree());
  });
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }

  return {
    container,
    items,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      // Drop every cached query and its gc timer. Without an explicit clear,
      // the identity/channel queries this mount issues leave gcTime timers
      // ref'd in the loop and the test process never exits.
      client.getQueryCache().clear();
      client.getMutationCache().clear();
      client.clear();
      client.unmount();
      container.remove();
    },
  };
}

function rowFor(container, eventId) {
  const row = container.querySelector(
    `[data-testid="home-inbox-item-${eventId}"]`,
  );
  assert.ok(row, `row for ${eventId} did not render`);
  return row;
}

test("a named thread renders its subject as the row's primary line", async () => {
  const inbox = await mountInbox();
  try {
    const row = rowFor(inbox.container, NAMED_REPLY_ID);
    const headline = row.querySelector(
      `[data-testid="home-inbox-headline-${NAMED_REPLY_ID}"]`,
    );

    assert.ok(headline, "named thread row rendered no headline");
    assert.equal(headline.textContent, SUBJECT);

    // "Headline first": the subject must precede the type label, not sit
    // under it — that ordering is the whole difference from today's row.
    const typeLabel = row.querySelector("[data-inbox-type-label]");
    assert.ok(typeLabel, "type label did not render");
    assert.ok(
      headline.compareDocumentPosition(typeLabel) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      "headline must render before the type label",
    );
  } finally {
    await inbox.unmount();
  }
});

test("the sender folds into the type-label line when a headline takes over", async () => {
  const inbox = await mountInbox();
  try {
    const item = inbox.items.find(
      (candidate) => candidate.id === NAMED_REPLY_ID,
    );
    const row = rowFor(inbox.container, NAMED_REPLY_ID);
    const sender = row.querySelector(
      "[data-inbox-type-label] [data-inbox-sender-label]",
    );

    assert.ok(sender, "sender did not move into the type-label line");
    assert.equal(sender.textContent, item.senderLabel);
    assert.notEqual(item.senderLabel, "");
  } finally {
    await inbox.unmount();
  }
});

test("a row with no derivable subject keeps the sender on its primary line", async () => {
  // Mounted alone so the virtualizer is guaranteed to render it: JSDOM
  // reports a zero-height scroll container, so only the first row measures in.
  const inbox = await mountInbox((items) =>
    items.filter((candidate) => candidate.id === ORPHAN_REPLY_ID),
  );
  try {
    const [item] = inbox.items;
    assert.equal(item.subject, null);

    const row = rowFor(inbox.container, ORPHAN_REPLY_ID);
    assert.equal(
      row.querySelector(
        `[data-testid="home-inbox-headline-${ORPHAN_REPLY_ID}"]`,
      ),
      null,
      "a row with nothing to name must not render a headline",
    );
    assert.equal(
      row.querySelector("[data-inbox-type-label] [data-inbox-sender-label]"),
      null,
      "the sender must stay on the primary line when there is no headline",
    );

    const typeLabel = row.querySelector("[data-inbox-type-label]");
    assert.ok(typeLabel, "type label did not render");
    // The old derivation would have put "Mention" here twice over.
    assert.ok(
      row.textContent.indexOf(item.senderLabel) <
        row.textContent.indexOf(typeLabel.textContent),
      "sender must precede the type label",
    );
  } finally {
    await inbox.unmount();
  }
});
