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

async function openThread(
  page: Page,
  rootContent: string,
  options: { newest?: boolean } = {},
): Promise<string> {
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

  const summariesBefore = await page
    .getByTestId("message-thread-summary")
    .count();
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
  if (options.newest) {
    // Once an earlier thread exists, a new root renders only its summary row.
    // Wait for it, or `.last()` can still resolve to the earlier thread's.
    const summaries = page.getByTestId("message-thread-summary");
    await expect(summaries).toHaveCount(summariesBefore + 1);
    await summaries.last().click();
  } else {
    await page
      .locator('[data-testid^="reply-message-"]')
      .first()
      .click({ force: true });
  }
  const panel = page.getByTestId("message-thread-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(rootContent);
  return rootId as string;
}

async function emitReply(page: Page, parentEventId: string, content: string) {
  await page.evaluate(
    ({ channelName, content, parentEventId, pubkey }) => {
      (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content,
        parentEventId,
        pubkey,
      });
    },
    { channelName: CHANNEL_NAME, content, parentEventId, pubkey: ALICE_PUBKEY },
  );
}

async function nameOpenThread(page: Page, title: string) {
  const panel = page.getByTestId("message-thread-panel");
  await panel.getByTestId("thread-title").hover();
  await panel.getByTestId("thread-title-edit").click();
  await panel.getByTestId("thread-title-input").fill(title);
  await panel.getByTestId("thread-title-input").press("Enter");
  await expect(panel.getByTestId("thread-title")).toHaveText(title);
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
    // The root message in the channel carries the title on its own line, and
    // the thread panel's copy of the root doesn't repeat it under the header.
    const titleLine = page.getByTestId("thread-title-line");
    await expect(titleLine).toHaveCount(1);
    await expect(titleLine).toHaveText("Release checklist");
    await expect(panel.getByTestId("thread-title-line")).toHaveCount(0);

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
    await expect(page.getByTestId("threads-view-subheader")).toHaveText(
      "Named threads, most recent activity first. Name any thread from its header; pin one to keep it at the top.",
    );
  });

  test("unread replies in a named thread show in the Threads view and sidebar", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    const rootId = await openThread(
      page,
      "Root message that gets new replies.",
    );
    await nameOpenThread(page, "Unread tracking");

    await page.getByTestId("open-threads-view").click();
    const row = page.getByTestId("threads-view-row");
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId("threads-unread-dot")).toHaveCount(0);

    await emitReply(page, rootId, "A reply while you're away.");
    await emitReply(page, rootId, "And another one.");
    await expect(page.getByTestId("threads-unread-dot")).toBeVisible();
    await expect(row).toHaveAttribute("data-unread", "true");
    await expect(page.getByTestId("threads-view-row-unread")).toHaveText(
      "2 new",
    );

    // Opening the thread reads it, which clears both indicators.
    await row.click();
    await expect(
      page.getByTestId("message-thread-panel").getByTestId("thread-title"),
    ).toHaveText("Unread tracking");
    await expect(page.getByTestId("threads-unread-dot")).toHaveCount(0);
    await page.getByTestId("open-threads-view").click();
    await expect(row).not.toHaveAttribute("data-unread", "true");
  });

  test("a pinned thread stays above more recently active ones", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await openThread(page, "Root of the thread to pin.");
    await nameOpenThread(page, "Pin me");
    const busyRoot = await openThread(page, "Root of a busier thread.", {
      newest: true,
    });
    await nameOpenThread(page, "Busy thread");

    await page.getByTestId("open-threads-view").click();
    const rows = page.getByTestId("threads-view-row");
    await expect(rows).toHaveText([/Busy thread/, /Pin me/]);
    await expect(page.getByTestId("threads-view-pinned")).toHaveCount(0);

    const pinMe = page
      .getByRole("listitem")
      .filter({ hasText: "Pin me" })
      .getByTestId("threads-view-row-pin");
    await pinMe.click();
    await expect(pinMe).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("threads-view-pinned")).toContainText(
      "Pin me",
    );
    await expect(rows).toHaveText([/Pin me/, /Busy thread/]);

    // New activity elsewhere doesn't move a thread above a pin, and the pin
    // survives leaving and reopening the view.
    await emitReply(page, busyRoot, "More activity in the busy thread.");
    await page.getByTestId(`channel-${CHANNEL_NAME}`).click();
    await page.getByTestId("open-threads-view").click();
    await expect(rows).toHaveText([/Pin me/, /Busy thread/]);

    await pinMe.click();
    await expect(page.getByTestId("threads-view-pinned")).toHaveCount(0);
    await expect(pinMe).toHaveAttribute("aria-pressed", "false");
    await expect(rows).toHaveText([/Busy thread/, /Pin me/]);
  });
});
