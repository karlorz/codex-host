import { expect, test } from "@playwright/test";
import { BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE } from "../../packages/desktop-control/src/browser-annotation-style-compat.js";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const fixture = `
  window.violations = [];
  addEventListener('securitypolicyviolation', e => window.violations.push(e.effectiveDirective));
  const host = document.createElement('div');
  host.id = 'codex-browser-sidebar-comments-root';
  document.documentElement.append(host);
  const shadow = host.attachShadow({mode:'open'});
  const existing = new CSSStyleSheet();
  existing.replaceSync('.unrelated { color: red }');
  shadow.adoptedStyleSheets = [existing];
  const style = document.createElement('style');
  style.textContent = '.annotation-selection-cursor { position: fixed; display: block; z-index: 1 }';
  shadow.append(style);
  const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cursor.classList.add('annotation-selection-cursor');
  Object.assign(cursor.style, {left:'200px', top:'150px', width:'20px', height:'20px'});
  shadow.append(cursor);
`;

for (const strict of [true, false]) {
  test(`annotation cursor styles ${strict ? "recover under strict CSP across reloads" : "stay native when inline styles are allowed"}`, async ({
    page,
  }) => {
    const csp = `default-src 'none'; script-src 'self'; style-src 'self'${strict ? "" : " 'unsafe-inline'"}`;
    await page.route("https://annotation.test/**", async (route) => {
      if (route.request().url().endsWith("/fixture.js")) {
        await route.fulfill({ contentType: "text/javascript", body: fixture });
      } else {
        await route.fulfill({
          contentType: "text/html",
          headers: { "Content-Security-Policy": csp },
          body: '<!doctype html><script src="/fixture.js"></script>',
        });
      }
    });
    const response = await page.goto("https://annotation.test/");
    expect(response?.headers()["content-security-policy"]).toBe(csp);
    const cursor = page.locator(
      "#codex-browser-sidebar-comments-root .annotation-selection-cursor",
    );
    await expect(cursor).toHaveCSS("position", strict ? "static" : "fixed");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE,
    });
    await cdp.send("Runtime.evaluate", { expression: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE });
    await expect(cursor).toHaveCSS("position", "fixed");
    await expect(cursor).toHaveCSS("left", "200px");
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const violations = await page.evaluate(() => Reflect.get(window, "violations"));
    expect(violations).toEqual(strict ? ["style-src-elem"] : []);
    for (let i = 0; i < 3; i++)
      await cdp.send("Runtime.evaluate", { expression: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE });
    const count = () =>
      page.evaluate(
        () =>
          document.getElementById("codex-browser-sidebar-comments-root")?.shadowRoot
            ?.adoptedStyleSheets.length,
      );
    expect(await count()).toBe(strict ? 2 : 1);
    await page.evaluate(() => {
      const shadow = document.getElementById("codex-browser-sidebar-comments-root")?.shadowRoot;
      const style = shadow?.querySelector("style");
      if (!style) throw new Error("Missing annotation stylesheet");
      style.textContent = ".annotation-selection-cursor { position: fixed; z-index: 7 }";
    });
    await expect(cursor).toHaveCSS("z-index", "7");
    expect(await count()).toBe(strict ? 2 : 1);
    await page.evaluate(() =>
      document
        .getElementById("codex-browser-sidebar-comments-root")
        ?.shadowRoot?.querySelector("style")
        ?.remove(),
    );
    await expect.poll(count).toBe(1);
    // Keep the CDP session alive, as the production controller must: Chromium
    // removes new-document registrations when this connection detaches.
    await page.reload();
    await expect(cursor).toHaveCSS("position", "fixed");
    expect(await count()).toBe(strict ? 2 : 1);
    await cdp.detach();
  });
}

test("ignores other shadow roots and reconnects when Codex replaces its annotation root", async ({
  page,
}) => {
  await page.route("https://annotation.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": "style-src 'self'" },
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("https://annotation.test/");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Runtime.evaluate", { expression: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE });
  await page.evaluate(() => {
    for (const id of ["page-owned", "codex-browser-sidebar-comments-root"]) {
      const host = document.createElement("div");
      host.id = id;
      document.documentElement.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = ".annotation-selection-cursor {position:fixed}";
      shadow.append(style);
    }
  });
  const sheetCounts = () =>
    page.evaluate(() =>
      ["page-owned", "codex-browser-sidebar-comments-root"].map(
        (id) => document.getElementById(id)?.shadowRoot?.adoptedStyleSheets.length,
      ),
    );
  await expect.poll(sheetCounts).toEqual([0, 1]);
  await page.evaluate(() => {
    const old = document.getElementById("codex-browser-sidebar-comments-root");
    if (!old) throw new Error("Missing annotation root");
    const next = document.createElement("div");
    next.id = old.id;
    const shadow = next.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ".annotation-selection-cursor {position:fixed}";
    shadow.append(style);
    old.replaceWith(next);
    Reflect.set(window, "oldShadow", old.shadowRoot);
  });
  await expect.poll(sheetCounts).toEqual([0, 1]);
  expect(
    await page.evaluate(() => Reflect.get(window, "oldShadow").adoptedStyleSheets.length),
  ).toBe(0);
  // attachShadow itself emits no light-DOM mutation. Model the controller's
  // next health check after Desktop asynchronously initializes the host.
  await page.evaluate(() => {
    const old = document.getElementById("codex-browser-sidebar-comments-root");
    if (!old) throw new Error("Missing annotation root");
    const next = document.createElement("div");
    next.id = old.id;
    old.replaceWith(next);
  });
  await cdp.send("Runtime.evaluate", { expression: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE });
  await page.evaluate(() => {
    const host = document.getElementById("codex-browser-sidebar-comments-root");
    if (!host) throw new Error("Missing annotation root");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ".annotation-selection-cursor {position:fixed}";
    shadow.append(style);
  });
  expect(await sheetCounts()).toEqual([0, 0]);
  await cdp.send("Runtime.evaluate", { expression: BROWSER_ANNOTATION_STYLE_COMPAT_SOURCE });
  await expect.poll(sheetCounts).toEqual([0, 1]);
  await cdp.detach();
});
