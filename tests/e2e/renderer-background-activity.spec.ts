import { expect, test } from "@playwright/test";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
} from "@codexhost/shared-contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const renderer = await readFile(
  path.resolve(import.meta.dirname, "../../packages/renderer-extension/dist/index.js"),
  "utf8",
);

const nativeRailCss = await readFile(
  path.resolve(import.meta.dirname, "fixtures/native-composer-rail.css"),
  "utf8",
);

test.beforeEach(async ({ page }) => {
  await page.route("https://codexhost.test/renderer.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: renderer }),
  );
  await page.route("https://codexhost.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;font:14px -apple-system,sans-serif;color-scheme:dark;background:#171717;color:#eee}*{box-sizing:border-box}
      header{height:44px;padding:12px;border-bottom:1px solid #444}.workspace{display:flex;height:calc(100vh - 44px);min-width:0;overflow:hidden}
      [data-app-shell-main-content-layout]{display:flex;flex:1;flex-direction:column;min-width:0}.chat{display:flex;flex-direction:column;height:100%;width:100%}.transcript{flex:1;padding:28px}.composer-block{transform:translateZ(0);contain:layout;overflow:hidden;padding:12px 24px 18px}.composer-width{max-width:760px;margin:auto}
      #composer{--spacing:4px;--radius-2xl:16px;--home-composer-inline-inset:8px;--spacing-token-button-composer:28px;--color-border:#444;--color-surface-elevated-secondary:#292929;--color-text-primary:#eee;--text-size-chat:14px}
      .input-card{position:relative;z-index:1;border:1px solid #444;background:#242424;padding:22px;border-radius:18px;min-height:100px}
      ${nativeRailCss}
      [data-composer-rail]{position:relative;display:flex;flex-direction:column;border-color:color-mix(in oklab,var(--color-border) 80%,transparent)}
      [data-composer-rail-item]{position:relative;min-width:0;overflow:clip;border-style:solid;border-width:1px 1px 0;background:var(--color-surface-elevated-secondary);color:var(--color-text-primary)}
      #goal{padding:6px 10px;min-height:32px}#plan{padding:20px;color:#aaa}
      </style><header>BUILT COMPONENT · SAMPLE DATA · INSTALLED VISUAL ACCEPTANCE PENDING</header>
      <div class="workspace"><div data-app-shell-main-content-layout="thread-edge-scroll" style="flex:1 1 0%;width:100%;min-width:0"><main class="chat" data-app-shell-focus-area="main"><div class="transcript">Grok integration<div id="plan">Plan: independent fixture checklist</div></div>
      <div class="composer-block"><div class="composer-width"><form id="composer" data-codex-composer-root><div data-above-composer-portal data-above-composer-conversation-id="parent"></div><div data-composer-rail data-composer-rail-placement="above" class="_rail_1hrlq_1 _attached_1hrlq_36"><div id="goal" class="_item_1hrlq_8" data-composer-rail-item="present" data-composer-rail-framed>Pursuing goal: independent fixture state</div></div><div class="input-card"><div contenteditable="true" role="textbox">parent draft</div><button type="submit">Send</button></div></form></div></div></main></div></div>`,
    }),
  );
  await page.goto("https://codexhost.test/");
  // Static-derived native summary primitives; not an installed DOM capture.
  await page.locator(".workspace").evaluate((workspace) => {
    const panel = document.createElement("aside");
    panel.className =
      "group/summary-panel relative flex max-h-full min-h-0 flex-col overflow-hidden";
    panel.dataset.summaryPanelVariant = "summary";
    panel.style.cssText = "width:340px;display:flex;flex-direction:column;overflow:auto";
    panel.innerHTML =
      '<div><section role="presentation" class="relative z-0 flex flex-col"><header>Native context</header></section></div>';
    workspace.append(panel);
  });
  await page.evaluate(
    async (transportModelId) => {
      const moduleUrl = "/renderer.js";
      const { installRendererBindingProbe } = await import(moduleUrl);
      const state = {
        calls: [] as { host: string; method: string; params: Record<string, string> }[],
        clicked: [] as string[],
        host: "local",
        holdList: false,
        holdRead: false,
        releaseList: () => {},
        releaseRead: () => {},
        stopped: false,
        failStop: false,
        empty: false,
        finished: false,
        nativeCommands: false,
        onlyProcesses: false,
        nextRunAt: new Date(Date.now() + 120000).toISOString(),
      };
      const activities = (host: string) =>
        [
          {
            id: "native-task",
            kind: "task",
            label: `${host} Run tests`,
            status: state.finished ? "completed" : "running",
            canStop: !state.finished,
            ...(state.nativeCommands ? { commandItemId: "native-command-item" } : {}),
          },
          ...(!state.stopped && !state.finished
            ? [
                {
                  id: "native-loop",
                  kind: "loop",
                  label: `${host} health watch`,
                  status: "scheduled",
                  canStop: true,
                  schedule: "every 15 minutes",
                  nextRunAt: state.nextRunAt,
                  relatedActivityId: "native-child",
                },
              ]
            : []),
          {
            id: "native-child",
            kind: "subagent",
            label: `${host} genuine child`,
            status: "completed",
            canStop: false,
            threadId: "child-thread",
          },
        ].filter((activity) => !state.onlyProcesses || activity.kind === "task");
      const routes = new Map<
        string,
        { sendRequest: (method: string, params: Record<string, string>) => Promise<unknown> }
      >();
      const routeFor = (host: string) => {
        let route = routes.get(host);
        if (!route) {
          route = {
            async sendRequest(method, params) {
              state.calls.push({ host, method, params });
              if (method === "codexhost/thread/activity/list") {
                const snapshot = state.empty ? [] : activities(host);
                if (state.holdList) {
                  state.holdList = false;
                  await new Promise<void>((resolve) => {
                    state.releaseList = resolve;
                  });
                }
                return { supported: true, activities: snapshot };
              }
              if (method === "codexhost/thread/activity/read") {
                if (state.holdRead) {
                  state.holdRead = false;
                  await new Promise<void>((resolve) => {
                    state.releaseRead = resolve;
                  });
                }
                const activity = activities(host).find((entry) => entry.id === params.activityId);
                if (!activity) throw Error("Native activity no longer exists");
                return {
                  activity,
                  output: `${host} actual output for ${params.activityId}`,
                  truncated: params.activityId === "native-task",
                };
              }
              if (method === "codexhost/thread/activity/stop") {
                if (state.failStop) throw Error("Native stop rejected");
                state.stopped = true;
                return { outcome: "stopped" };
              }
              if (method === "codexhost/thread/questions/list") return { questions: [] };
              throw Object.assign(Error("Unused fixture method"), { code: -32601 });
            },
          };
          routes.set(host, route);
        }
        return route;
      };
      const globals = window as unknown as Record<string, unknown>;
      globals.__codexhostHostRoutingV1 = {
        forHost: (host: string) => ({ hostId: host, manager: routeFor(host) }),
      };
      const editor = document.querySelector("[contenteditable]");
      Object.defineProperty(editor, "__reactFiber$activity", {
        value: {
          memoizedProps: { isOrbit: false },
          return: {
            memoizedProps: {
              conversationId: "parent",
              get hostId() {
                return state.host;
              },
              onOpenBackgroundAgent: (child: unknown) => {
                state.clicked.push(state.host);
                Reflect.set(window, "openedNativeChild", child);
              },
            },
            return: null,
          },
        },
      });
      const binding = installRendererBindingProbe({
        enabledAgents: ["codex", "grok"],
        defaultAgent: "grok",
      });
      const client = new Proxy(
        {},
        {
          get: (_, key) => {
            if (key === "currentHostId") return () => state.host;
            if (key === "clientForHost" || key === "knownHostIds") return undefined;
            if (String(key).startsWith("subscribe")) return () => () => {};
            if (key === "inspectThread")
              return async () => ({
                owner: "external",
                harnessId: "grok",
                transportModelId,
                locked: true,
                history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
              });
            if (key === "listHarnessPlugins")
              return async () => ({ plugins: [{ id: "grok", name: "Grok", version: "fixture" }] });
            return async () => {
              throw Error("Unused fixture client");
            };
          },
        },
      );
      binding.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        () => true,
        client,
      );
      const addChild = (host: string) => {
        const row = document.createElement("button");
        const attributes = {
          "data-app-action-sidebar-thread-row": "true",
          "data-app-action-sidebar-thread-id": `${host}:child-thread`,
          "data-app-action-sidebar-thread-host-id": host,
        };
        for (const [key, value] of Object.entries(attributes)) row.setAttribute(key, value);
        Object.defineProperty(row, "__reactFiber$activity", {
          value: {
            memoizedProps: { conversationId: "child-thread", dataAttributes: attributes },
            return: null,
          },
        });
        row.textContent = `${host} child sidebar`;
        row.onclick = () => state.clicked.push(host);
        document.body.append(row);
      };
      addChild("foreign");
      globals.activityFixture = state;
      globals.activityBinding = binding;
      globals.addActivityChild = addChild;
    },
    encodeHarnessPluginRoute({
      harnessId: harnessIdSchema.parse("grok"),
      model: harnessModelRefSchema.parse({ id: "fixture" }),
    }),
  );
  await expect(
    page.locator("[data-summary-panel-variant] [data-codexhost-background-activity]"),
  ).toBeVisible();
});

test("built public binding uses the shared panel and opens the genuine child on its Host", async ({
  page,
}) => {
  const own = page.locator("[data-summary-panel-variant] [data-codexhost-background-activity]");
  await expect(
    page.getByRole("button", { name: "Open background activity", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator("[data-codexhost-activity-pane],[data-codexhost-activity-rail]"),
  ).toHaveCount(0);
  await own.getByRole("button", { name: /local health watch/ }).click();
  await expect(own.locator(".activity-prompt-title")).toHaveText(
    "local actual output for native-loop",
  );
  // Genuine children need not have any sidebar row. Only the foreign decoy exists.
  await own.getByRole("button", { name: "Open latest run", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "activityFixture").clicked))
    .toEqual(["local"]);
  expect(await page.evaluate(() => Reflect.get(window, "openedNativeChild"))).toEqual({
    conversationId: "child-thread",
    displayName: "local genuine child",
    canInteract: false,
  });
  await expect(own.getByText("local genuine child", { exact: true })).toHaveCount(0);
  await expect(page.locator("#goal")).toHaveText("Pursuing goal: independent fixture state");
  await expect(page.locator("#plan")).toHaveText("Plan: independent fixture checklist");
});

test("stable binding scans do not accelerate background polling", async ({ page }) => {
  const count = () =>
    page.evaluate(
      () =>
        Reflect.get(window, "activityFixture").calls.filter(
          (call: { method: string }) => call.method === "codexhost/thread/activity/list",
        ).length as number,
    );
  const before = await count();
  await page.waitForTimeout(1250);
  const additional = (await count()) - before;
  expect(additional).toBeGreaterThanOrEqual(1);
  expect(additional).toBeLessThanOrEqual(2);
});
