import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
    import { installRendererQuestions } from './packages/renderer-extension/src/renderer-questions.ts';
    import { writeHarnessQuestionPlacement } from './packages/renderer-extension/src/renderer-question-placement-preference.ts';
    const question = {interactionId:'ask-1',turnId:'turn-1',title:'Question',questions:[
      {id:'platform',type:'choice',prompt:'Choose platforms',multiple:true,allowOther:true,optional:false,
       options:[{value:'mac',label:'macOS'},{value:'win',label:'Windows'}]},
    ]};
    const record = {interactionId:'ask-old',turnId:'turn-0',itemId:'item-record',title:'Earlier',
      questions:[{id:'platform',type:'choice',prompt:'Choose platforms',multiple:true,allowOther:true,optional:false,
       options:[{value:'mac',label:'macOS'},{value:'win',label:'Windows'}]}],
      outcome:'answered',answers:{platform:['mac']}};
    const folded = {interactionId:'ask-folded',turnId:'turn-folded',itemId:'item-folded',title:'Letters',
      questions:[{id:'letters',type:'choice',prompt:'Which letters?',multiple:true,allowOther:true,optional:false,
       options:[{value:'alpha',label:'Alpha'},{value:'beta',label:'Beta'}]}],
      outcome:'answered',answers:{letters:['alpha']}};
    const skipped = {interactionId:'ask-skipped',turnId:'turn-working',itemId:'item-working',title:'Letters',
      questions:[{id:'letters',type:'choice',prompt:'Which letters?',multiple:true,allowOther:true,optional:false,
       options:[{value:'alpha',label:'Alpha'},{value:'beta',label:'Beta'}]}],
      outcome:'skipped',answers:{}};
    const narrow = {interactionId:'ask-narrow',turnId:'turn-narrow',itemId:'item-narrow',title:'Letters',
      questions:[{id:'letters',type:'choice',prompt:'Which letters?',multiple:true,allowOther:true,optional:false,
       options:[{value:'alpha',label:'Alpha'},{value:'beta',label:'Beta'}]}],
      outcome:'skipped',answers:{}};
    const pending = {interactionId:'ask-pending',turnId:'turn-pending',itemId:'item-pending',title:'Letters',
      questions:[{id:'letters',type:'choice',prompt:'Which letters?',multiple:true,allowOther:true,optional:false,
       options:[{value:'alpha',label:'Alpha'},{value:'beta',label:'Beta'}]}],
      outcome:'skipped',answers:{}};
    const state={questions:[question],records:[record,folded,skipped,narrow,pending],pendingAnchors:[{interactionId:'ask-1',turnId:'turn-1',itemId:'item-live'}],
      thread:'thread-1',host:'local',calls:[],recordsUnsupported:false};
    const route={async sendRequest(method,params){
      state.calls.push({method,params});
      if(method.endsWith('question-records/list')) {
        if(state.recordsUnsupported) throw Object.assign(new Error('method not found'), {code:-32601});
        return {records:structuredClone(state.records),pendingAnchors:structuredClone(state.pendingAnchors)};
      }
      if(method.endsWith('/list')) return {questions:structuredClone(state.questions)};
      if(!method.endsWith('/respond')) throw Error('Unused fixture RPC');
      state.questions=[]; return {accepted:true};
    }};
    const controller=installRendererQuestions(window,()=>state.thread?{
      hostId:state.host,threadId:state.thread,composer:document.querySelector('#composer'),route
    }:null);
    Object.assign(window,{fixture:state,controller,writeHarnessQuestionPlacement});
  `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
});
const bundle = outputFiles[0]?.text;
if (!bundle) throw new Error("Question records bundle missing");

test.beforeEach(async ({ page }) => {
  await page.route("http://localhost/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
<div id="transcript">
  <div data-local-conversation-item-target-ids="item-live">live row</div>
  <div data-local-conversation-item-target-ids="item-record">record row</div>
  <div data-content-search-turn-key="turn-folded">
    <div>
      <button aria-expanded="false" style="width:120px;height:24px">fold</button>
    </div>
    <div style="width:80px;height:12px"></div>
    <div id="folded-reply" style="width:400px;height:48px">You picked Alpha</div>
  </div>
  <div data-content-search-turn-key="turn-working">
    <button aria-expanded="false" style="width:120px;height:24px">Working for 25s</button>
    <div id="working-row" style="display:flex;flex-direction:row;width:800px;height:160px">
      <div data-local-conversation-item-target-ids="item-working" style="width:80px;height:140px">tool</div>
      <div id="stream-reply" style="flex:1;width:400px;height:140px">The tool result says the user declined</div>
    </div>
  </div>
  <div data-content-search-turn-key="turn-narrow">
    <button aria-expanded="false" style="width:120px;height:24px">Working for 4s</button>
    <div id="narrow-row" style="display:flex;flex-direction:row;width:800px;height:160px">
      <div data-local-conversation-item-target-ids="item-narrow" style="width:80px;height:140px">tool</div>
      <div id="question-label" style="flex:1;width:400px;height:140px">Question</div>
    </div>
  </div>
  <div data-content-search-turn-key="turn-pending">
    <div id="pending-col" style="width:800px;height:80px">
      <button aria-expanded="false" style="width:160px;height:24px">Working for 4s</button>
      <div data-local-conversation-item-target-ids="item-pending" style="width:0;height:0;overflow:hidden">tool</div>
    </div>
  </div>
</div>
<form id="composer"><div contenteditable="true" role="textbox" aria-label="Chat message">chat draft</div></form>`,
    }),
  );
  await page.goto("http://localhost/");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("checkbox", { name: "macOS", exact: true }).first()).toBeVisible();
});

test("mounts the live picker in the transcript row and keeps the Composer free", async ({
  page,
}) => {
  await expect(
    page.locator('[data-local-conversation-item-target-ids="item-live"] [data-codexhost-question]'),
  ).toHaveCount(1);
  await expect(page.locator("#composer [data-codexhost-question]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chat message" })).toHaveText("chat draft");
  await expect(
    page.locator(
      '[data-local-conversation-item-target-ids="item-record"] [data-codexhost-question-record] .outcome',
    ),
  ).toHaveText("Answered");
  await expect(
    page
      .locator(
        '[data-local-conversation-item-target-ids="item-record"] [data-codexhost-question-record]',
      )
      .getByRole("checkbox", { name: "macOS" }),
  ).toBeDisabled();
  await expect(
    page
      .locator(
        '[data-local-conversation-item-target-ids="item-record"] [data-codexhost-question-record]',
      )
      .getByRole("button", { name: "Send" }),
  ).toHaveCount(0);
});

test("overlay mode moves only the live picker above the Composer", async ({ page }) => {
  const live = page.locator("[data-codexhost-question]");
  await live.getByRole("checkbox", { name: "Windows", exact: true }).check();
  await page.evaluate(() => {
    Reflect.get(window, "writeHarnessQuestionPlacement")(window, false);
  });
  await expect
    .poll(async () => live.evaluate((node) => node.nextElementSibling?.id === "composer"))
    .toBe(true);
  await expect(
    page.locator('[data-local-conversation-item-target-ids="item-live"] [data-codexhost-question]'),
  ).toHaveCount(0);
  await expect(live.getByRole("checkbox", { name: "Windows", exact: true })).toBeChecked();
  await expect(page.locator("[data-codexhost-question-record]")).toHaveCount(5);
});

test("shows a jump pill when the transcript contract exists but the row is unmounted", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.pendingAnchors[0].itemId = "item-missing";
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("button", { name: "Question waiting — Jump" })).toBeVisible();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("parks a folded record on the turn's visible reply", async ({ page }) => {
  const folded = page.locator('[data-codexhost-question-record="ask-folded"]');
  await expect(folded).toHaveCount(1);
  await expect(folded.locator(".outcome")).toHaveText("Answered");
  await expect(folded.getByRole("checkbox", { name: "Alpha", exact: true })).toBeDisabled();
  await expect(page.locator("#composer [data-codexhost-question-record]")).toHaveCount(0);
  await expect
    .poll(async () =>
      page.locator("#folded-reply").evaluate((reply) => {
        const card = reply.ownerDocument.querySelector(
          '[data-codexhost-question-record="ask-folded"]',
        );
        if (!(card instanceof HTMLElement)) return false;
        return reply.contains(card) || reply.previousElementSibling?.contains(card) === true;
      }),
    )
    .toBe(true);
});

test("keeps a skipped card full width above a still-open tool row", async ({ page }) => {
  const skipped = page.locator('[data-codexhost-question-record="ask-skipped"]');
  await expect(skipped).toHaveCount(1);
  await expect(skipped.locator(".outcome")).toHaveText("Skipped (you cancelled)");
  await expect(
    page.locator(
      '[data-local-conversation-item-target-ids="item-working"] [data-codexhost-question-record]',
    ),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      page.locator("#working-row").evaluate((row) => {
        const slot = row.previousElementSibling;
        return slot?.hasAttribute("data-codexhost-question-history") === true;
      }),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      skipped.evaluate((card) => {
        const row = card.ownerDocument.getElementById("working-row");
        const reply = card.ownerDocument.getElementById("stream-reply");
        if (!row || !reply) return false;
        const cardBox = card.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const replyBox = reply.getBoundingClientRect();
        return cardBox.width > 300 && cardBox.bottom <= rowBox.top + 1 && replyBox.width > 300;
      }),
    )
    .toBe(true);
});

test("does not park a skipped card in the narrow tool column beside Question", async ({ page }) => {
  const skipped = page.locator('[data-codexhost-question-record="ask-narrow"]');
  await expect(skipped).toHaveCount(1);
  await expect(
    page.locator(
      '[data-local-conversation-item-target-ids="item-narrow"] [data-codexhost-question-record]',
    ),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      page.locator("#narrow-row").evaluate((row) => {
        const slot = row.previousElementSibling;
        return slot?.hasAttribute("data-codexhost-question-history") === true;
      }),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      skipped.evaluate((card) => {
        const row = card.ownerDocument.getElementById("narrow-row");
        if (!row) return false;
        const cardBox = card.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        return cardBox.width > 300 && cardBox.bottom <= rowBox.top + 1;
      }),
    )
    .toBe(true);
});

test("keeps a skipped card visible while the turn is still working with no reply", async ({
  page,
}) => {
  const skipped = page.locator('[data-codexhost-question-record="ask-pending"]');
  await expect(skipped).toHaveCount(1);
  await expect
    .poll(async () =>
      skipped.evaluate((card) => {
        const col = card.ownerDocument.getElementById("pending-col");
        if (!col) return false;
        const cardBox = card.getBoundingClientRect();
        const hosted = col.contains(card) || col.previousElementSibling?.contains(card) === true;
        return hosted && cardBox.width > 300 && cardBox.height > 40;
      }),
    )
    .toBe(true);
});

test("keeps pending cards when records list is method-not-found", async ({ page }) => {
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.recordsUnsupported = true;
    state.records = [];
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(1);
  await expect(page.locator("[data-codexhost-question-record]")).toHaveCount(0);
});
