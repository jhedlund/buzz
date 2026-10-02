import { expect, type Page, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type MockMessageWindow = Window & {
  __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
    channelName: string;
    content: string;
    parentEventId?: string | null;
    pubkey?: string;
  }) => { id: string } | undefined;
  __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
    channelName: string;
  }) => boolean;
};

const CHANNEL_NAME = "engineering";
const MOCK_IDENTITY_PUBKEY = "deadbeef".repeat(8);
const ALICE_PUBKEY =
  "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f";

async function openThread(page: Page, rootContent: string) {
  await page.getByTestId(`channel-${CHANNEL_NAME}`).click();
  await expect(page.getByTestId("chat-title")).toHaveText(CHANNEL_NAME);
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          (
            window as MockMessageWindow
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName: name }) ??
          false,
        CHANNEL_NAME,
      ),
    )
    .toBe(true);

  const rootId = await page.evaluate(
    ({ channelName, content, pubkey }) =>
      (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content,
        pubkey,
      })?.id ?? null,
    {
      channelName: CHANNEL_NAME,
      content: rootContent,
      pubkey: MOCK_IDENTITY_PUBKEY,
    },
  );
  expect(rootId).not.toBeNull();
  await page.evaluate(
    ({ channelName, parentEventId, pubkey }) => {
      (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content: "First reply.",
        parentEventId,
        pubkey,
      });
    },
    { channelName: CHANNEL_NAME, parentEventId: rootId, pubkey: ALICE_PUBKEY },
  );
  await page
    .locator('[data-testid^="reply-message-"]')
    .first()
    .click({ force: true });
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
}

test.describe("thread titles", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("name a thread, find it in the Threads view, and reopen it", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await openThread(page, "Root message that will get a title.");

    const panel = page.getByTestId("message-thread-panel");
    await expect(panel.getByTestId("thread-title")).toHaveText("Thread");

    await panel.getByTestId("thread-title").hover();
    await panel.getByTestId("thread-title-edit").click();
    const input = panel.getByTestId("thread-title-input");
    await expect(input).toBeFocused();
    await input.fill("  Release checklist  ");
    await input.press("Enter");
    await expect(panel.getByTestId("thread-title")).toHaveText(
      "Release checklist",
    );
    // The channel timeline's reply summary carries the title too.
    await expect(
      page.getByTestId("message-thread-summary-title").first(),
    ).toHaveText("Release checklist");

    // Escape abandons an edit without writing.
    await panel.getByTestId("thread-title").hover();
    await panel.getByTestId("thread-title-edit").click();
    await panel.getByTestId("thread-title-input").fill("Discarded");
    await panel.getByTestId("thread-title-input").press("Escape");
    await expect(panel.getByTestId("thread-title")).toHaveText(
      "Release checklist",
    );

    await page.getByTestId("open-threads-view").click();
    const rows = page.getByTestId("threads-view-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Release checklist");
    await expect(rows.first()).toContainText(`#${CHANNEL_NAME}`);

    await rows.first().click();
    await expect(page.getByTestId("chat-title")).toHaveText(CHANNEL_NAME);
    await expect(
      page.getByTestId("message-thread-panel").getByTestId("thread-title"),
    ).toHaveText("Release checklist");
  });

  test("clearing the title removes the thread from the Threads view", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await openThread(page, "Root message that is named, then cleared.");

    const panel = page.getByTestId("message-thread-panel");
    await panel.getByTestId("thread-title").hover();
    await panel.getByTestId("thread-title-edit").click();
    await panel.getByTestId("thread-title-input").fill("Temporary name");
    await panel.getByTestId("thread-title-input").press("Enter");
    await expect(panel.getByTestId("thread-title")).toHaveText(
      "Temporary name",
    );

    await panel.getByTestId("thread-title").hover();
    await panel.getByTestId("thread-title-edit").click();
    await panel.getByTestId("thread-title-input").fill("   ");
    await panel.getByTestId("thread-title-input").press("Enter");
    await expect(panel.getByTestId("thread-title")).toHaveText("Thread");

    await page.getByTestId("open-threads-view").click();
    await expect(page.getByTestId("threads-view")).toContainText(
      "No named threads",
    );
  });
});
