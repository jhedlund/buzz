import assert from "node:assert/strict";
import test from "node:test";

const POST = "a".repeat(64);
const COMMENT = "c".repeat(64);
const CHANNEL = "634a9a88-e929-427c-9dc7-3b7f7194e882";
const tauriMock = {
  invoke(command, args) {
    if (command === "send_channel_message") {
      return Promise.resolve({
        event_id: COMMENT,
        parent_event_id: args.parentEventId,
        root_event_id: args.parentEventId,
        depth: 1,
        created_at: 500,
      });
    }
    return Promise.reject(new Error(`unmocked Tauri command: ${command}`));
  },
  transformCallback() {
    return Math.random();
  },
};
globalThis.__TAURI_INTERNALS__ = tauriMock;
globalThis.window.__TAURI_INTERNALS__ = tauriMock;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { useCreateForumReplyMutation } = await import("./hooks.ts");
const { THREAD_TITLES_QUERY_KEY } = await import(
  "../threads/lib/threadTitles.ts"
);

test("your own forum comment carries its activity into the titled thread", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(THREAD_TITLES_QUERY_KEY, [
    {
      author: "p".repeat(64),
      channelId: CHANNEL,
      lastActivityAt: 100,
      revision: "r".repeat(64),
      rootId: POST,
      title: "Forum thread",
      updatedAt: 100,
    },
  ]);
  const latest = {};
  function Harness() {
    latest.mutation = useCreateForumReplyMutation({
      id: CHANNEL,
      channelType: "forum",
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Harness),
      ),
    );
  });

  await act(async () => {
    await latest.mutation.mutateAsync({
      content: "My follow-up.",
      parentEventId: POST,
    });
  });

  assert.equal(
    queryClient.getQueryData(THREAD_TITLES_QUERY_KEY)[0].lastActivityAt,
    500,
  );
  await act(async () => root.unmount());
});
