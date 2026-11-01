import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const fixture = await build({
  entryPoints: [
    path.resolve(
      import.meta.dirname,
      "../../packages/renderer-extension/src/renderer-trigger-chip-style.ts",
    ),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2024",
});
const fixtureSource = fixture.outputFiles[0]?.text;
if (!fixtureSource) throw Error("Resize fixture build missing");

test("compact composer resizing does not write layout during ResizeObserver delivery", async ({
  page,
}) => {
  await page.route("https://resize.test/chip.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: fixtureSource }),
  );
  await page.route("https://resize.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>#composer{width:500px;height:100px}#composer[data-codexhost-compact-composer]{height:50px}</style><div id="composer"></div>`,
    }),
  );
  await page.goto("https://resize.test/");
  await page.evaluate(async () => {
    const errors: string[] = [];
    window.addEventListener("error", (e) => errors.push(e.message));
    Reflect.set(window, "resizeErrors", errors);
    const url = "/chip.js";
    const { observeRendererCompactComposer } = await import(url);
    Reflect.set(
      window,
      "stopCompact",
      observeRendererCompactComposer(document.querySelector("#composer")),
    );
  });
  await expect(page.locator("#composer")).not.toHaveAttribute("data-codexhost-compact-composer");
  for (const width of [400, 500, 400, 500]) {
    await page
      .locator("#composer")
      .evaluate((el, next) => ((el as HTMLElement).style.width = `${next}px`), width);
    await expect(page.locator("#composer")).toHaveJSProperty(
      "offsetHeight",
      width <= 420 ? 50 : 100,
    );
  }
  const errors = await page.evaluate(() => Reflect.get(window, "resizeErrors"));
  expect(errors).toEqual([]);
  await page.evaluate(() => Reflect.get(window, "stopCompact")());
});
