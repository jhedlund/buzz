import { expect, type Page, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type MockMessageWindow = Window & {
  __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
    channelName: string;
    content: string;
    parentEventId?: string | null;
    createdAt?: number;
    pubkey?: string;
  }) => { id: string } | undefined;
  __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
    channelName: string;
    kind?: number;
  }) => boolean;
  __BUZZ_E2E_SET_REMOTE_THREAD_TITLE__?: (input: {
    channelName: string;
    rootId: string;
    title: string;
  }) => void;
};

const CHANNEL_NAME = "engineering";
const MOCK_IDENTITY_PUBKEY = "deadbeef".repeat(8);
const ALICE_PUBKEY =
  "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f";

async function openThread(
  page: Page,
  rootContent: string,
  options: { replyCreatedAt?: number } = {},
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
    ({ channelName, createdAt, parentEventId, pubkey }) => {
      (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content: "First reply.",
        createdAt,
        parentEventId,
        pubkey,
      });
    },
    {
      channelName: CHANNEL_NAME,
      createdAt: options.replyCreatedAt,
      parentEventId: rootId,
      pubkey: ALICE_PUBKEY,
    },
  );
  // A new root collapses its reply into a summary row as it renders, so a
  // click on the inline reply can land on a detached node. Wait for the
  // summary instead; `.last()` alone could still resolve to an earlier one.
  const summaries = page.getByTestId("message-thread-summary");
  await expect(summaries).toHaveCount(summariesBefore + 1);
  await summaries.last().click();
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

/**
 * Sets titles as another user would. The title list is cached app-wide and
 * only a title event in a live-subscribed channel invalidates it, so the last
 * title must be in CHANNEL_NAME; that write is what makes the others show.
 */
async function setRemoteTitles(
  page: Page,
  titles: { channelName: string; rootId: string; title: string }[],
) {
  expect(titles.at(-1)?.channelName).toBe(CHANNEL_NAME);
  await page.getByTestId(`channel-${CHANNEL_NAME}`).click();
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          (
            window as MockMessageWindow
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: name,
            kind: 45010,
          }) ?? false,
        CHANNEL_NAME,
      ),
    )
    .toBe(true);
  await page.evaluate((titles) => {
    for (const title of titles) {
      (window as MockMessageWindow).__BUZZ_E2E_SET_REMOTE_THREAD_TITLE__?.(
        title,
      );
    }
  }, titles);
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

    // The thread opens beside the list; the Threads view stays put.
    await rows.first().click();
    const sidePanel = page.getByTestId("message-thread-panel");
    await expect(sidePanel.getByTestId("thread-title")).toHaveText(
      "Release checklist",
    );
    await expect(page.getByTestId("threads-view")).toBeVisible();
    await expect(rows.first()).toHaveAttribute("data-selected", "true");

    // The pane's channel header still jumps into the channel.
    await sidePanel
      .getByRole("button", { name: `Open #${CHANNEL_NAME}` })
      .click();
    await expect(page.getByTestId("chat-title")).toHaveText(CHANNEL_NAME);
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
      "Named threads, most recent activity first. Name any thread from its header.",
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
    // Both threads are created within the same second; without a later reply
    // their activity ties and the "most recent first" order is arbitrary.
    const busyRoot = await openThread(page, "Root of a busier thread.", {
      replyCreatedAt: Math.floor(Date.now() / 1000) + 60,
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

  test("a title another user sets appears before anyone replies", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId(`channel-${CHANNEL_NAME}`).click();
    await expect(page.getByTestId("chat-title")).toHaveText(CHANNEL_NAME);
    await expect
      .poll(() =>
        page.evaluate(
          (name) =>
            (
              window as MockMessageWindow
            ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
              channelName: name,
              kind: 45010,
            }) ?? false,
          CHANNEL_NAME,
        ),
      )
      .toBe(true);

    // Visit Threads first so the (empty) title list is cached and fresh.
    await page.getByTestId("open-threads-view").click();
    await expect(page.getByTestId("threads-view-row")).toHaveCount(0);
    await page.getByTestId(`channel-${CHANNEL_NAME}`).click();

    const rootId = await page.evaluate(
      ({ channelName, pubkey }) =>
        (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName,
          content: "Question for an agent, no reply yet.",
          pubkey,
        })?.id ?? null,
      { channelName: CHANNEL_NAME, pubkey: MOCK_IDENTITY_PUBKEY },
    );
    expect(rootId).not.toBeNull();
    await expect(
      page.getByText("Question for an agent, no reply yet."),
    ).toBeVisible();

    await page.evaluate(
      ({ channelName, rootId }) =>
        (window as MockMessageWindow).__BUZZ_E2E_SET_REMOTE_THREAD_TITLE__?.({
          channelName,
          rootId,
          title: "Agent-named thread",
        }),
      { channelName: CHANNEL_NAME, rootId: rootId as string },
    );

    // Well inside the 30s staleTime: only the live refresh can deliver it.
    await expect(page.getByTestId("thread-title-line")).toHaveText(
      "Agent-named thread",
      { timeout: 5_000 },
    );
    await page.getByTestId("open-threads-view").click();
    await expect(page.getByTestId("threads-view-row")).toHaveText([
      /Agent-named thread/,
    ]);
  });

  test("filter the Threads view by channel", async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await setRemoteTitles(page, [
      { channelName: "random", rootId: "c".repeat(64), title: "Random one" },
      { channelName: CHANNEL_NAME, rootId: "a".repeat(64), title: "Eng one" },
      { channelName: CHANNEL_NAME, rootId: "b".repeat(64), title: "Eng two" },
    ]);

    await page.getByTestId("open-threads-view").click();
    const rows = page.getByTestId("threads-view-row");
    await expect(rows).toHaveCount(3);
    const filter = page.getByTestId("threads-channel-filter");
    await expect(filter).toHaveText("All channels");

    await filter.click();
    await expect(page.getByTestId("threads-channel-filter-option")).toHaveText([
      /All channels\s*3/,
      /#engineering\s*2/,
      /#random\s*1/,
    ]);
    await page
      .getByTestId("threads-channel-filter-option")
      .filter({ hasText: "#engineering" })
      .click();
    await expect(filter).toHaveText(`#${CHANNEL_NAME}`);
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Random one" })).toHaveCount(0);

    // The filter holds across leaving and coming back.
    await page.getByTestId(`channel-${CHANNEL_NAME}`).click();
    await page.getByTestId("open-threads-view").click();
    await expect(filter).toHaveText(`#${CHANNEL_NAME}`);
    await expect(rows).toHaveCount(2);

    await filter.click();
    await page
      .getByTestId("threads-channel-filter-option")
      .filter({ hasText: "All channels" })
      .click();
    await expect(rows).toHaveCount(3);
  });

  test("a thread in a channel the user hasn't joined still opens the channel", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await setRemoteTitles(page, [
      { channelName: "design", rootId: "d".repeat(64), title: "Design review" },
      {
        channelName: CHANNEL_NAME,
        rootId: "e".repeat(64),
        title: "Eng thread",
      },
    ]);

    await page.getByTestId("open-threads-view").click();
    await page
      .getByTestId("threads-view-row")
      .filter({ hasText: "Design review" })
      .click();
    await expect(page.getByTestId("chat-title")).toHaveText("design");
  });

  test("Threads follows the Focus thread layout and can switch to beside", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("buzz.channels.threadViewMode", "focus");
    });
    await installMockBridge(page);
    await page.goto("/");
    await openThread(page, "Root message for the focus drawer.");
    await nameOpenThread(page, "Focus drawer thread");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("focus-thread-drawer")).toHaveCount(0);

    await page.getByTestId("open-threads-view").click();
    const row = page.getByTestId("threads-view-row");
    await row.click();

    // Focus opens the large drawer over the list, which goes inert.
    const drawer = page.getByTestId("focus-thread-drawer");
    await expect(drawer.getByTestId("thread-title")).toHaveText(
      "Focus drawer thread",
    );
    await expect(page.getByTestId("threads-view")).toBeVisible();
    await expect(
      page.locator("[inert]").getByTestId("threads-view"),
    ).toHaveCount(1);

    // The scrim goes back to the list.
    await page
      .getByRole("button", { name: "Back to Threads" })
      .click({ position: { x: 20, y: 300 } });
    await expect(drawer).toHaveCount(0);
    await expect(
      page.locator("[inert]").getByTestId("threads-view"),
    ).toHaveCount(0);

    // The header toggle switches to the side pane and saves the choice.
    await row.click();
    await drawer.getByTestId("thread-view-mode-toggle").click();
    await expect(drawer).toHaveCount(0);
    const sidePanel = page.getByTestId("message-thread-panel");
    await expect(sidePanel.getByTestId("thread-title")).toHaveText(
      "Focus drawer thread",
    );
    await expect(
      page.locator("[inert]").getByTestId("threads-view"),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("buzz.channels.threadViewMode"),
      ),
    ).toBe("split");

    // And back to Focus from the side pane.
    await sidePanel.getByTestId("thread-view-mode-toggle").click();
    await expect(drawer.getByTestId("thread-title")).toHaveText(
      "Focus drawer thread",
    );
  });
});
