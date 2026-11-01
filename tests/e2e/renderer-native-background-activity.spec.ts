import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const bundle = await build({
  entryPoints: [
    path.resolve(
      import.meta.dirname,
      "../../packages/renderer-extension/src/renderer-background-activity.ts",
    ),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2024",
  loader: { ".png": "dataurl" },
});
const source = bundle.outputFiles[0]?.text;
if (!source) throw Error("Missing activity fixture bundle");
const targetBundle = await build({
  entryPoints: [
    path.resolve(
      import.meta.dirname,
      "../../packages/renderer-extension/src/renderer-activity-section.ts",
    ),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const targetSource = targetBundle.outputFiles[0]?.text;
if (!targetSource) throw Error("Missing target fixture bundle");

// Static-derived primitives from Desktop 26.1027.30824/build22943:
// thread-summary-panel-components-265aaea48bf8.js. This is not live DOM evidence.
const nativeTypography = readFileSync(
  new URL("./fixtures/native-summary-typography.css", import.meta.url),
  "utf8",
);
const nativeSection = `<section role="presentation" class="relative z-0 flex flex-col"><header class="native-heading h-7 text-sm font-normal text-secondary">Context</header><div class="relative z-0 overflow-hidden"><div class="flex flex-col gap-0.5 px-5"><span class="native-label text-sm">Native context</span></div></div></section>`;
const nativePanel = `<aside class="group/summary-panel relative flex max-h-full min-h-0 flex-col overflow-hidden" data-summary-panel-variant="summary" data-summary-panel-density="comfortable"><div class="flex h-fit max-h-full min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto"><div class="flex flex-col gap-2 py-2.5" data-fixture-sections>${nativeSection}</div></div></aside>`;
const section = "[data-codexhost-background-activity]";

async function change(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(
    (value) => Object.assign(Reflect.get(window, "activityFixture"), value),
    patch,
  );
}
async function calls(page: Page) {
  return page.evaluate(() => Reflect.get(window, "activityFixture").calls.length as number);
}

test.beforeEach(async ({ page }) => {
  await page.route("https://activity.test/target.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: targetSource }),
  );
  await page.route("https://activity.test/activity.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: source }),
  );
  await page.route("https://activity.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>
  ${nativeTypography}
  html,body{height:100%;margin:0;font:14px sans-serif;color-scheme:dark;background:#171717;color:#eee}*{box-sizing:border-box}.workspace{display:flex;height:100%;gap:16px}[data-app-shell-main-content-layout]{flex:1;min-width:0}form{padding:16px}aside{display:flex;flex-direction:column;width:340px;overflow:auto}section{display:flex;flex-direction:column}button{color:inherit} [hidden]{display:none!important}
  </style><div class="workspace"><main data-app-shell-main-content-layout><div id="plan">Native Plan</div><form data-codex-composer-root><div data-above-composer-portal></div><div data-composer-rail class="_rail_1hrlq_1 _attached_1hrlq_36"><div id="goal" data-composer-rail-item>Native Goal</div></div><div contenteditable>draft</div></form></main>${nativePanel}</div>`,
    }),
  );
  await page.goto("https://activity.test/");
  await page.evaluate(async () => {
    const state = {
      host: "local",
      thread: "parent",
      empty: false,
      completed: false,
      stoppedIds: [] as string[],
      mixed: false,
      unsupported: false,
      failStop: false,
      failRead: false,
      output: "Native prompt and output",
      active: true,
      override: null as Record<string, unknown>[] | null,
      holdList: false,
      holdRead: false,
      listChildIdentityMissing: false,
      releaseList: () => {},
      releaseRead: () => {},
      calls: [] as { method: string; params: Record<string, string> }[],
    };
    const activities = () =>
      (
        state.override ??
        (state.empty
          ? []
          : [
              {
                id: "loop:one",
                kind: "loop",
                label: "Health check",
                status: state.completed ? "completed" : "scheduled",
                canStop: true,
                schedule: "every 15 minutes",
                nextRunAt: "2026-01-01T00:00:00Z",
                relatedActivityId: "child:one",
              },
              {
                id: "child:one",
                kind: "subagent",
                label: "Genuine child",
                status: "completed",
                canStop: false,
                threadId: "child-thread",
              },
              ...(state.mixed
                ? [
                    {
                      id: "task:native",
                      kind: "task",
                      label: "Native Run",
                      status: "running",
                      canStop: true,
                      commandItemId: "native-command",
                    },
                  ]
                : []),
            ])
      ).filter((item) => !state.stoppedIds.includes(String(item.id)));
    const routes = new Map();
    const route = (host: string) => {
      if (!routes.has(host))
        routes.set(host, {
          async sendRequest(method: string, params: Record<string, string>) {
            state.calls.push({ method, params });
            if (method.endsWith("/list")) {
              const snapshot = activities();
              if (state.holdList) {
                state.holdList = false;
                await new Promise<void>((resolve) => {
                  state.releaseList = resolve;
                });
              }
              return {
                supported: !state.unsupported,
                activities: state.listChildIdentityMissing
                  ? snapshot.map((item) =>
                      item.kind === "subagent" ? { ...item, threadId: undefined } : item,
                    )
                  : snapshot,
              };
            }
            if (method.endsWith("/read")) {
              if (state.failRead) throw Error("Native read failed");
              const activity = activities().find((item) => item.id === params.activityId);
              if (!activity) throw Error("Native activity missing");
              if (state.holdRead) {
                state.holdRead = false;
                await new Promise<void>((resolve) => {
                  state.releaseRead = resolve;
                });
              }
              return { activity, output: state.output, truncated: false };
            }
            if (state.failStop) throw Error("Native delete failed");
            state.stoppedIds.push(params.activityId ?? "");
            return { outcome: "stopped" };
          },
        });
      return routes.get(host);
    };
    const url = "/activity.js";
    const { installRendererBackgroundActivity } = await import(url);
    const create = () =>
      installRendererBackgroundActivity(window, () =>
        state.active
          ? {
              hostId: state.host,
              threadId: state.thread,
              composer: document.querySelector("form"),
              route: route(state.host),
            }
          : null,
      );
    let control = create();
    Reflect.set(window, "activityFixture", state);
    Reflect.set(window, "activityControl", control);
    Reflect.set(window, "activityRestart", () => {
      control.dispose();
      control = create();
      Reflect.set(window, "activityControl", control);
    });
  });
});

test("Loop-only uses the native summary section with no composer entry or separate pane", async ({
  page,
}) => {
  await page
    .locator("#goal,#plan,[data-composer-rail]")
    .evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await expect(page.locator(`[data-fixture-sections] > ${section}`)).toBeVisible();
  await expect(page.locator(section).getByRole("button", { name: /Health check/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open background activity", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("[data-codexhost-activity-pane],[data-codexhost-activity-rail]"),
  ).toHaveCount(0);
  await expect(page.locator(section).getByText("Genuine child", { exact: true })).toHaveCount(0);
  await expect(
    page.locator(section).getByText("Waiting for Harness", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(section).getByText(/Schedule · scheduled · every 15 minutes/),
  ).toBeVisible();
  await expect(page.locator("#goal,[data-composer-rail]")).toHaveCount(0);
});

test("Loop detail separates the title from collapsed instructions and preserves disclosure across polls", async ({
  page,
}) => {
  const instructions =
    "Deadline 01:54 JST.\nRun date once.\nDelete only this schedule at expiry.\n<script>unsafe()</script>";
  await change(page, { output: "Loop visibility check\n" + instructions });
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  const detail = page.locator(section + " .activity-detail");
  await expect(
    detail.getByRole("heading", { name: "Loop visibility check", exact: true }),
  ).toBeVisible();
  await expect(detail.getByText(instructions, { exact: true })).toBeHidden();
  await expect(detail.getByRole("button", { name: "Delete schedule", exact: true })).toBeVisible();
  await detail.locator("summary").click();
  await expect(detail.getByText(instructions, { exact: true })).toBeVisible();
  await change(page, {
    override: [
      {
        id: "loop:one",
        kind: "loop",
        label: "Health check",
        status: "scheduled",
        canStop: true,
        nextRunAt: new Date().toISOString(),
      },
    ],
  });
  await expect(detail.locator("details")).toHaveAttribute("open", "");
  await expect(detail.locator("script")).toHaveCount(0);
  expect(await page.locator("form [contenteditable]").innerText()).toBe("draft");
});

test("latest run uses the parent-owned native subagent callback without a sidebar row", async ({
  page,
}) => {
  await page.evaluate(() => {
    const form = document.querySelector("form");
    if (!form) throw Error("Missing composer");
    Reflect.set(window, "openedNativeChild", null);
    Object.defineProperty(form, "__reactFiber$native", {
      value: {
        memoizedProps: {},
        return: {
          memoizedProps: {
            hostId: "local",
            conversationId: "parent",
            onOpenBackgroundAgent: (child: unknown) =>
              Reflect.set(window, "openedNativeChild", child),
          },
          return: null,
        },
      },
    });
  });
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await page.locator(section).getByRole("button", { name: "Open latest run", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "openedNativeChild")))
    .toEqual({ conversationId: "child-thread", displayName: "Genuine child", canInteract: false });
  await expect(page.locator(section + " .activity-error")).toBeEmpty();
});

test("late latest-run child lookup cannot navigate after switching chats", async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 100));
  await page.evaluate(() => {
    const form = document.querySelector("form");
    if (!form) throw Error("Missing composer");
    Reflect.set(window, "openedNativeChild", null);
    Object.defineProperty(form, "__reactFiber$native", {
      value: {
        memoizedProps: {},
        return: {
          memoizedProps: {
            hostId: "local",
            conversationId: "parent",
            onOpenBackgroundAgent: (child: unknown) =>
              Reflect.set(window, "openedNativeChild", child),
          },
          return: null,
        },
      },
    });
  });
  await change(page, { listChildIdentityMissing: true });
  await page.evaluate(() => Reflect.get(window, "activityRestart")());
  await expect(page.locator(section)).toBeVisible();
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await expect(page.locator(section + " .activity-prompt-title")).toBeVisible();
  await change(page, { holdRead: true });
  await page.locator(section).getByRole("button", { name: "Open latest run", exact: true }).click();
  const childRead = await page.evaluate(() => Reflect.get(window, "activityFixture").calls.at(-1));
  expect(childRead).toMatchObject({
    method: "codexhost/thread/activity/read",
    params: { threadId: "parent", activityId: "child:one" },
  });
  await change(page, { thread: "another-parent" });
  await page.evaluate(() => Reflect.get(window, "activityControl").refreshContext());
  await page.evaluate(() => Reflect.get(window, "activityFixture").releaseRead());
  await expect(page.locator(section)).toHaveAttribute(
    "data-codexhost-background-activity",
    "another-parent",
  );
  expect(await page.evaluate(() => Reflect.get(window, "openedNativeChild"))).toBeNull();
  await expect(page.locator(section + " .activity-error")).toBeEmpty();
});

test("deleting the final schedule removes its section without touching native content", async ({
  page,
}) => {
  const before = await page.locator("form").evaluate((node) => node.outerHTML);
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await expect(
    page.locator(section).getByText("Native prompt and output", { exact: true }),
  ).toBeVisible();
  await page.locator(section).getByRole("button", { name: "Delete schedule", exact: true }).click();
  await expect(page.locator(section)).toHaveCount(0);
  expect(await page.locator("form").evaluate((node) => node.outerHTML)).toBe(before);
  const stop = await page.evaluate(() =>
    Reflect.get(window, "activityFixture").calls.filter((call: { method: string }) =>
      call.method.endsWith("/stop"),
    ),
  );
  expect(stop).toEqual([
    {
      method: "codexhost/thread/activity/stop",
      params: { threadId: "parent", activityId: "loop:one" },
    },
  ]);
});

for (const theme of ["light", "dark"] as const) {
  test("long Loop prompts stay compact until expanded in " + theme, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 820, height: 800 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((scheme) => {
      for (const node of [document.documentElement, document.body]) {
        node.style.colorScheme = scheme;
        node.style.backgroundColor = scheme === "light" ? "#fafafa" : "#171717";
        node.style.color = scheme === "light" ? "#242424" : "#eee";
      }
    }, theme);
    await page.locator("aside").evaluate((node) => {
      node.style.width = "280px";
      node.style.flexShrink = "0";
    });
    const prompt =
      "Review background health.\n" + "Keep this native instruction in details. ".repeat(40);
    await change(page, {
      output: prompt,
      override: [
        {
          id: "loop:long",
          kind: "loop",
          label: prompt,
          status: "scheduled",
          canStop: true,
          schedule: "every 2 minutes",
          nextRunAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const row = page.locator(section).getByRole("button", { name: /Review background health/ });
    await expect(row).toBeVisible();
    expect((await row.boundingBox())?.height).toBeLessThan(85);
    await expect(row.locator(".activity-title")).toHaveText("Review background health.");
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(section).locator("pre")).toHaveCount(0);
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(section).locator(".activity-prompt-title")).toHaveText(
      "Review background health.",
    );
    await expect(page.locator(section).locator(".activity-prompt-instructions")).toBeHidden();
    await page.locator(section).locator("summary").click();
    await expect(page.locator(section).locator(".activity-prompt-instructions")).toHaveText(
      prompt.split("\n").slice(1).join("\n"),
    );
    expect((await row.boundingBox())?.height).toBeLessThan(85);
    await row.click();
    await expect(page.locator(section).locator("pre")).toHaveCount(0);
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(row.getByText(/scheduled · every 2 minutes/)).toBeVisible();
    const longLine = prompt.replaceAll("\n", " ");
    await change(page, {
      output: longLine,
      override: [
        {
          id: "loop:long",
          kind: "loop",
          label: longLine,
          status: "scheduled",
          canStop: true,
          schedule: "every 2 minutes",
          nextRunAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    await expect(row.locator(".activity-title")).toHaveText(longLine.slice(0, 71) + "…");
    expect((await row.boundingBox())?.height).toBeLessThan(85);
    expect(
      await row.locator(".activity-title").evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(true);
    await row.click();
    await expect(page.locator(section).locator(".activity-prompt-title")).toHaveText(longLine);
    await row.click();
    await expect(page.locator(section).locator("pre")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("compact-loop-" + theme + ".png") });
  });
}

test("mixed native processes are not duplicated and restored processes remain accessible", async ({
  page,
}) => {
  await change(page, { mixed: true });
  await page.locator("[data-fixture-sections]").evaluate((node) => {
    const native = document.createElement("section");
    native.className = "flex flex-col";
    native.id = "native-process";
    native.textContent = "Native Run terminal";
    node.prepend(native);
  });
  await expect(page.locator(section)).toBeVisible();
  await expect(page.locator(section).getByText("Native Run", { exact: true })).toHaveCount(0);
  await expect(page.locator("#native-process")).toHaveText("Native Run terminal");
  await change(page, {
    override: [
      {
        id: "restored",
        kind: "monitor",
        label: "Restored monitor",
        status: "unknown",
        canStop: true,
      },
    ],
  });
  await page
    .locator(section)
    .getByRole("button", { name: /Restored monitor/ })
    .click();
  await expect(
    page.locator(section).getByRole("button", { name: "Stop task", exact: true }),
  ).toBeVisible();
  await expect(page.locator(section).getByText(/Process · unknown/)).toBeVisible();
});

test("matches native section typography and preserves controls through header collapse", async ({
  page,
}) => {
  const font = (selector: string) =>
    page.locator(selector).evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.color];
    });
  await expect(page.locator(section)).toBeVisible();
  expect(await font(section + " .activity-heading")).toEqual(await font(".native-heading"));
  expect(await font(section + " .activity-title")).toEqual(await font(".native-label"));
  const heading = page
    .locator(section)
    .getByRole("button", { name: "Background activity", exact: true });
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await expect(page.locator(section).locator(".activity-prompt-title")).toBeVisible();
  await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(section).getByRole("button", { name: /Health check/ })).toBeHidden();
  const before = await calls(page);
  await expect.poll(() => calls(page)).toBeGreaterThan(before);
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await page
    .locator("[data-summary-panel-variant]")
    .evaluate((node) => ((node as HTMLElement).hidden = true));
  await expect(page.locator(section)).toHaveCount(0);
  await page
    .locator("[data-summary-panel-variant]")
    .evaluate((node) => ((node as HTMLElement).hidden = false));
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await heading.click();
  await expect(page.locator(section).locator(".activity-prompt-title")).toHaveText(
    "Native prompt and output",
  );
  expect(await page.locator("form [contenteditable]").innerText()).toBe("draft");
  await heading.click();
  await change(page, { thread: "another-parent" });
  await expect(page.locator(section)).toHaveAttribute(
    "data-codexhost-background-activity",
    "another-parent",
  );
  await expect(heading).toHaveAttribute("aria-expanded", "true");
});

for (const mode of [
  "missing",
  "ambiguous",
  "decoy",
  "no-section",
  "ambiguous-sections",
  "lost-context",
] as const) {
  test("fails closed for " + mode + " while polling independently", async ({ page }) => {
    await expect(page.locator(section)).toBeVisible();
    const before = await calls(page);
    await page.evaluate((kind) => {
      Reflect.get(window, "activityControl").dispose();
      const root = document.querySelector("[data-summary-panel-variant]");
      if (!root) throw Error("Missing fixture panel");
      if (kind === "missing") root.remove();
      if (kind === "ambiguous") root.parentElement?.append(root.cloneNode(true));
      if (kind === "decoy") document.body.append(root);
      if (kind === "no-section") root.replaceChildren();
      if (kind === "ambiguous-sections") {
        const other = document.createElement("div");
        other.innerHTML = '<section class="flex flex-col">Other native section</section>';
        root.append(other);
      }
      if (kind === "lost-context") Reflect.get(window, "activityFixture").active = false;
      Reflect.get(window, "activityRestart")();
    }, mode);
    await expect(page.locator(section)).toHaveCount(0);
    if (mode !== "lost-context") {
      const reason = await page.evaluate(async () => {
        const url = "/target.js";
        const { activitySectionTarget } = await import(url);
        return activitySectionTarget(window, document.querySelector("form"), null).reason;
      });
      expect(reason).toBe(
        mode === "ambiguous"
          ? "ambiguous-panel"
          : mode === "no-section"
            ? "missing-sections"
            : mode === "ambiguous-sections"
              ? "ambiguous-sections"
              : "missing-panel",
      );
    }
    await expect(
      page.locator("[data-codexhost-activity-pane],[data-codexhost-activity-rail]"),
    ).toHaveCount(0);
    if (mode !== "lost-context") await expect.poll(() => calls(page)).toBeGreaterThan(before + 1);
    const form = await page.locator("form").evaluate((node) => node.outerHTML);
    await page.waitForTimeout(1100);
    expect(await page.locator("form").evaluate((node) => node.outerHTML)).toBe(form);
  });
}

test("keeps one Loop section through 120 polls, Turn end and inline/overlay changes", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-01T00:00:01Z"));
  await page.evaluate(() => Reflect.get(window, "activityRestart")());
  await expect(page.locator(section)).toBeVisible();
  const baseline = await page.evaluate(() => {
    Reflect.set(
      window,
      "originalSection",
      document.querySelector("[data-codexhost-background-activity]"),
    );
    return Reflect.get(window, "activityFixture").calls.filter((call: { method: string }) =>
      call.method.endsWith("/list"),
    ).length;
  });
  for (let phase = 0; phase < 4; phase++) {
    await page.evaluate((step) => {
      const root = document.querySelector("[data-summary-panel-variant]");
      if (!root) throw Error("Missing native panel");
      if (step === 1) {
        // A Turn finishes and its last native section is removed; the Loop remains scheduled.
        root.querySelector("section[role=presentation]")?.remove();
      }
      if (step === 2) {
        const overlay = document.createElement("div");
        overlay.dataset.fixtureOverlay = "";
        overlay.style.cssText = "position:fixed;right:0;top:0;height:100%";
        root.parentElement?.append(overlay);
        overlay.append(root);
      }
      if (step === 3) {
        document.querySelector(".workspace")?.append(root);
        document.querySelector("[data-fixture-overlay]")?.remove();
      }
    }, phase);
    await page.clock.runFor(30_000);
    await expect(page.locator(section)).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          Reflect.get(window, "originalSection") ===
          document.querySelector("[data-codexhost-background-activity]"),
      ),
    ).toBe(true);
  }
  const count = await page.evaluate(
    () =>
      Reflect.get(window, "activityFixture").calls.filter((call: { method: string }) =>
        call.method.endsWith("/list"),
      ).length,
  );
  expect(count - baseline).toBe(120);
  await page
    .locator("[data-summary-panel-variant]")
    .evaluate((root) => ((root as HTMLElement).hidden = true));
  await page.clock.runFor(1000);
  await expect(page.locator(section)).toHaveCount(0);
  await page
    .locator("[data-summary-panel-variant]")
    .evaluate((root) => ((root as HTMLElement).hidden = false));
  await page.clock.runFor(1000);
  await expect(page.locator(section)).toBeVisible();
});

test("A to B to A clears each old section once and rejects retained controls", async ({ page }) => {
  await expect(page.locator(section)).toBeVisible();
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await expect(
    page.locator(section).getByRole("button", { name: "Delete schedule" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const roots: Element[] = [];
    Reflect.set(window, "removedActivityRoots", roots);
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes) {
          if (node instanceof Element && node.matches("[data-codexhost-background-activity]"))
            roots.push(node);
        }
    });
    observer.observe(document.querySelector(".workspace") as Element, {
      childList: true,
      subtree: true,
    });
    Reflect.set(
      window,
      "oldDelete",
      document.querySelector("[data-codexhost-background-activity] .activity-action:last-child"),
    );
  });
  await change(page, { thread: "B", empty: true });
  await page.evaluate(() => Reflect.get(window, "activityControl").refreshContext());
  await expect(page.locator(section)).toHaveCount(0);
  await change(page, { thread: "parent", empty: false });
  await page.evaluate(() => Reflect.get(window, "activityControl").refreshContext());
  await expect(page.locator(section)).toHaveAttribute(
    "data-codexhost-background-activity",
    "parent",
  );
  // B had no surface, so only A's original section was removed, exactly once.
  expect(await page.evaluate(() => Reflect.get(window, "removedActivityRoots").length)).toBe(1);
  await page.evaluate(() => Reflect.get(window, "oldDelete").click());
  expect(await page.evaluate(() => Reflect.get(window, "activityFixture").stoppedIds)).toEqual([]);
  await expect(page.locator(section).getByRole("button", { name: "Delete schedule" })).toHaveCount(
    0,
  );
  await expect(page.locator(section)).toHaveCount(1);
});

test("retains open details through native section churn and container replacement", async ({
  page,
}) => {
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await expect(page.locator(section).locator(".activity-prompt-title")).toHaveText(
    "Native prompt and output",
  );
  await page.evaluate(() => {
    const own = document.querySelector("[data-codexhost-background-activity]");
    Reflect.set(window, "originalSection", own);
    document.querySelector("[data-fixture-sections] > section[role=presentation]")?.remove();
  });
  const before = await calls(page);
  await expect.poll(() => calls(page)).toBeGreaterThan(before);
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, "originalSection") ===
        document.querySelector("[data-codexhost-background-activity]"),
    ),
  ).toBe(true);
  await page.locator("[data-fixture-sections]").evaluate((node) => {
    const native = document.createElement("section");
    native.className = "flex flex-col";
    native.textContent = "Native replacement";
    const next = document.createElement("div");
    next.dataset.fixtureSections = "";
    next.append(native);
    node.replaceWith(next);
  });
  await expect(page.locator("[data-fixture-sections] > " + section)).toHaveCount(1);
  await expect(page.locator(section).locator(".activity-prompt-title")).toHaveText(
    "Native prompt and output",
  );
});

test("supports the dynamic-isle container and hidden/visible lifecycle", async ({ page }) => {
  await expect(page.locator(section)).toBeVisible();
  await page.locator("[data-summary-panel-variant]").evaluate((root) => {
    root.setAttribute("data-summary-panel-variant", "dynamic-isle");
    const sections = root.querySelector("[data-fixture-sections]");
    if (!sections) throw Error("Missing sections");
    root.replaceChildren(...sections.childNodes);
  });
  await expect(page.locator("[data-summary-panel-variant] > " + section)).toHaveCount(1);
  await page
    .locator("[data-summary-panel-variant]")
    .evaluate((root) => ((root as HTMLElement).hidden = true));
  await expect(page.locator(section)).toHaveCount(0);
  const before = await calls(page);
  await expect.poll(() => calls(page)).toBeGreaterThan(before);
  await page
    .locator("[data-summary-panel-variant]")
    .evaluate((root) => ((root as HTMLElement).hidden = false));
  await expect(page.locator("[data-summary-panel-variant] > " + section)).toBeVisible();
});

test("steady polls and detail reads do not mutate DOM or write composer layout", async ({
  page,
}) => {
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await expect(page.locator(section).locator(".activity-prompt-title")).toHaveText(
    "Native prompt and output",
  );
  await page.evaluate(() => {
    const mutations: string[] = [];
    const observer = new MutationObserver((records) =>
      mutations.push(...records.map((record) => record.type)),
    );
    observer.observe(document.querySelector(".workspace") as Element, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    Reflect.set(window, "activityMutations", mutations);
    Reflect.set(window, "activityObserver", observer);
  });
  const before = await calls(page);
  await expect.poll(() => calls(page)).toBeGreaterThan(before + 3);
  expect(await page.evaluate(() => Reflect.get(window, "activityMutations"))).toEqual([]);
});

test("terminal-only history removes the section and polling can rediscover work", async ({
  page,
}) => {
  await expect(page.locator(section)).toBeVisible();
  await change(page, { completed: true });
  await expect(page.locator(section)).toHaveCount(0);
  await change(page, { completed: false });
  await expect(page.locator(section)).toBeVisible();
  await page.evaluate(() => Reflect.get(window, "activityControl").dispose());
  await expect(page.locator(section)).toHaveCount(0);
  await expect(page.locator("[data-fixture-sections] > section")).toHaveCount(1);
});

test("native errors preserve schedule and do not imply deletion", async ({ page }) => {
  await change(page, { failRead: true });
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await expect(page.locator(section).getByRole("status")).toHaveText("Native read failed");
  await change(page, { failRead: false });
  await expect(
    page.locator(section).getByRole("button", { name: "Delete schedule", exact: true }),
  ).toBeVisible();
  await change(page, { failStop: true });
  await page.locator(section).getByRole("button", { name: "Delete schedule", exact: true }).click();
  await expect(page.locator(section).getByRole("status")).toHaveText("Native delete failed");
  await expect(
    page.locator(section).getByRole("button", { name: "Delete schedule", exact: true }),
  ).toBeEnabled();
});

test("late old-context list and detail replies cannot restore old controls", async ({ page }) => {
  await expect(page.locator(section)).toBeVisible();
  await change(page, { holdList: true });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "activityFixture").holdList))
    .toBe(false);
  await change(page, { host: "other", thread: "other-thread" });
  await page.evaluate(() => Reflect.get(window, "activityControl").refreshContext());
  await expect(page.locator(section)).toHaveAttribute(
    "data-codexhost-background-activity",
    "other-thread",
  );
  await page.evaluate(() => Reflect.get(window, "activityFixture").releaseList());
  await change(page, { holdRead: true });
  await page
    .locator(section)
    .getByRole("button", { name: /Health check/ })
    .click();
  await change(page, { active: false });
  await page.evaluate(() => Reflect.get(window, "activityControl").refreshContext());
  await page.evaluate(() => Reflect.get(window, "activityFixture").releaseRead());
  await expect(page.locator(section)).toHaveCount(0);
});

test("unsupported plugins leave native content alone", async ({ page }) => {
  await change(page, { unsupported: true });
  await expect(page.locator(section)).toHaveCount(0);
  await expect(page.locator("#goal")).toHaveText("Native Goal");
  await expect(page.locator("#plan")).toHaveText("Native Plan");
});

test("stopping a restored process leaves the schedule and native command UI intact", async ({
  page,
}) => {
  await change(page, {
    override: [
      { id: "restored", kind: "task", label: "Restored process", status: "running", canStop: true },
      { id: "loop:one", kind: "loop", label: "Health check", status: "scheduled", canStop: true },
      {
        id: "native",
        kind: "task",
        label: "Native process",
        status: "running",
        canStop: true,
        commandItemId: "item-native",
      },
    ],
  });
  await page
    .locator(section)
    .getByRole("button", { name: /Restored process/ })
    .click();
  await page.locator(section).getByRole("button", { name: "Stop task", exact: true }).click();
  await expect(page.locator(section).getByRole("button", { name: /Restored process/ })).toHaveCount(
    0,
  );
  await expect(page.locator(section).getByRole("button", { name: /Health check/ })).toBeVisible();
  const stopped = await page.evaluate(() => Reflect.get(window, "activityFixture").stoppedIds);
  expect(stopped).toEqual(["restored"]);
});

test("a native slash-menu fixture keeps its DOM and geometry during activity mount and cleanup", async ({
  page,
}) => {
  await page.evaluate(() => {
    Reflect.get(window, "activityControl").dispose();
    const editor = document.querySelector("[contenteditable]");
    editor?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key !== "/") return;
      const menu = document.createElement("div");
      menu.id = "native-slash";
      menu.setAttribute("role", "menu");
      menu.textContent = "Native slash commands";
      document.querySelector("[data-above-composer-portal]")?.append(menu);
    });
  });
  await page.locator("[contenteditable]").press("/");
  const baseline = await page
    .locator("form")
    .evaluate((node) => ({ html: node.outerHTML, rect: node.getBoundingClientRect().toJSON() }));
  await page.evaluate(() => Reflect.get(window, "activityRestart")());
  await expect(page.locator(section)).toBeVisible();
  expect(
    await page
      .locator("form")
      .evaluate((node) => ({ html: node.outerHTML, rect: node.getBoundingClientRect().toJSON() })),
  ).toEqual(baseline);
  await change(page, { empty: true });
  await expect(page.locator(section)).toHaveCount(0);
  expect(
    await page
      .locator("form")
      .evaluate((node) => ({ html: node.outerHTML, rect: node.getBoundingClientRect().toJSON() })),
  ).toEqual(baseline);
});

for (const theme of ["light", "dark"] as const) {
  test("static-derived shared activity is readable in " + theme, async ({ page }, testInfo) => {
    await page.evaluate((mode) => {
      for (const node of [document.documentElement, document.body]) node.style.colorScheme = mode;
      document.body.style.color = mode === "light" ? "#242424" : "#ededed";
      document.body.style.background = mode === "light" ? "#fafafa" : "#202020";
      document.querySelector("#goal")?.remove();
      const label = document.createElement("p");
      label.textContent = "STATIC-DERIVED FIXTURE — NOT INSTALLED UI PROOF";
      document.querySelector("[data-app-shell-main-content-layout]")?.prepend(label);
    }, theme);
    await page
      .locator(section)
      .getByRole("button", { name: /Health check/ })
      .click();
    await expect(page.locator(section).locator(".activity-prompt-title")).toHaveText(
      "Native prompt and output",
    );
    const color = await page
      .locator(section)
      .getByRole("button", { name: /Health check/ })
      .evaluate((node) => getComputedStyle(node).color);
    expect(color).toBe(theme === "light" ? "rgb(36, 36, 36)" : "rgb(237, 237, 237)");
    await page.screenshot({
      path: testInfo.outputPath("static-derived-shared-panel-" + theme + ".png"),
    });
  });
}
