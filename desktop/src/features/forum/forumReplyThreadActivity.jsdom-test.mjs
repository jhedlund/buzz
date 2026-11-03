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
const { getObservedThreadActivity, resetObservedThreadActivity } = await import(
  "../threads/lib/observedThreadActivity.ts"
);

test("your own forum comment is recorded as activity on its thread", async () => {
  const queryClient = new QueryClient();
  resetObservedThreadActivity();
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

  assert.deepEqual(getObservedThreadActivity().get(POST), {
    at: 500,
    ids: [COMMENT],
  });
  await act(async () => root.unmount());
});
