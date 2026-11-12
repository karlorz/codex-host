import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
    import { installRendererQuestions } from './packages/renderer-extension/src/renderer-questions.ts';
    import { writeHarnessQuestionHistory } from './packages/renderer-extension/src/renderer-question-history-preference.ts';
    import { writeHarnessQuestionPlacement } from './packages/renderer-extension/src/renderer-question-placement-preference.ts';
    const question = {interactionId:'ask-1',turnId:'turn-1',title:'Question',questions:[
      {id:'platform',type:'choice',prompt:'Choose platforms',multiple:true,allowOther:true,optional:false,
       options:[{value:'mac',label:'macOS'},{value:'win',label:'Windows'}]},
    ]};
    const record = {interactionId:'ask-old',turnId:'turn-0',itemId:'item-record',title:'Earlier',
      questions:[{id:'platform',type:'choice',prompt:'Choose platforms',multiple:true,allowOther:true,optional:false,
       options:[{value:'mac',label:'macOS'},{value:'win',label:'Windows'},{value:'linux',label:'Linux'}]}],
      outcome:'answered',answers:{platform:['mac','linux']}};
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
    const rowish = {interactionId:'ask-rowish',turnId:'turn-rowish',itemId:'item-rowish',title:'Letters',
      questions:[{id:'letters',type:'choice',prompt:'Which letters?',multiple:true,allowOther:true,optional:false,
       options:[{value:'alpha',label:'Alpha'},{value:'beta',label:'Beta'}]}],
      outcome:'answered',answers:{letters:['alpha']}};
    const state={questions:[question],records:[record,folded,skipped,narrow,pending,rowish],pendingAnchors:[{interactionId:'ask-1',turnId:'turn-1',itemId:'item-live'}],
      thread:'thread-1',host:'local',calls:[],recordsUnsupported:false};
    const route={async sendRequest(method,params){
      state.calls.push({method,params});
      if(method.endsWith('question-records/list')) {
        if(state.recordsUnsupported) throw Object.assign(new Error('method not found'), {code:-32601});
        return {records:structuredClone(state.records),pendingAnchors:structuredClone(state.pendingAnchors)};
      }
      if(method.endsWith('/list')) return {questions:params?.unobserved?[]:structuredClone(state.questions)};
      if(!method.endsWith('/respond')) throw Error('Unused fixture RPC');
      state.questions=[]; return {accepted:true};
    }};
    const controller=installRendererQuestions(window,()=>state.thread?{
      hostId:state.host,threadId:state.thread,composer:document.querySelector('#composer'),route
    }:null);
    Object.assign(window,{fixture:state,controller,writeHarnessQuestionHistory,writeHarnessQuestionPlacement});
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
  <div id="turn-rowish" data-content-search-turn-key="turn-rowish" style="display:flex;flex-direction:row;width:800px;height:160px">
    <div data-local-conversation-item-target-ids="item-rowish" style="width:80px;height:140px">tool</div>
    <div id="rowish-reply" style="flex:1;width:400px;height:140px">You picked Alpha</div>
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
  const record = page.locator(
    '[data-local-conversation-item-target-ids="item-record"] [data-codexhost-question-record]',
  );
  await expect(record.locator(".outcome")).toHaveText("Answered");
  await expect(record).toHaveAttribute("data-history", "selected");
  await expect(record.getByText("macOS", { exact: true })).toBeVisible();
  await expect(record.getByText("Linux", { exact: true })).toBeVisible();
  await expect(record.locator("[data-option-order]")).toHaveText(["1", "3"]);
  await expect(record.getByText("Windows", { exact: true })).toHaveCount(0);
  await expect(record.getByRole("checkbox")).toHaveCount(0);
  await expect(record.getByRole("button", { name: "Send" })).toHaveCount(0);
});

test("Appearance can restore every option in question history", async ({ page }) => {
  const record = page.locator(
    '[data-local-conversation-item-target-ids="item-record"] [data-codexhost-question-record]',
  );
  await page.evaluate(() => {
    Reflect.get(window, "writeHarnessQuestionHistory")(window, false);
  });
  await expect(record).toHaveAttribute("data-history", "all");
  await expect(record.getByRole("checkbox", { name: "macOS", exact: true })).toBeDisabled();
  await expect(record.getByRole("checkbox", { name: "Windows", exact: true })).toBeDisabled();
  await page.evaluate(() => {
    Reflect.get(window, "writeHarnessQuestionHistory")(window, true);
  });
  await expect(record).toHaveAttribute("data-history", "selected");
  await expect(record.getByText("Windows", { exact: true })).toHaveCount(0);
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
  await expect(page.locator("[data-codexhost-question-record]")).toHaveCount(6);
});

test("keeps the live picker in-chat when the item row is folded", async ({ page }) => {
  await page.evaluate(async () => {
    const row = document.querySelector('[data-local-conversation-item-target-ids="item-live"]');
    const transcript = document.querySelector("#transcript");
    if (!(row instanceof HTMLElement) || !transcript) throw new Error("live row missing");
    const turn = document.createElement("div");
    turn.setAttribute("data-content-search-turn-key", "turn-1");
    turn.setAttribute("style", "width:800px");
    const col = document.createElement("div");
    col.id = "live-col";
    col.setAttribute("style", "width:800px;height:80px");
    const fold = document.createElement("button");
    fold.setAttribute("aria-expanded", "false");
    fold.setAttribute("style", "width:160px;height:24px");
    fold.textContent = "Working for 44s";
    row.style.width = "0px";
    row.style.height = "0px";
    row.style.overflow = "hidden";
    col.append(fold, row);
    turn.append(col);
    transcript.prepend(turn);
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("button", { name: "Question waiting — Jump" })).toHaveCount(0);
  await expect(page.locator("#live-col [data-codexhost-question]")).toBeVisible();
  await expect(
    page.locator('[data-local-conversation-item-target-ids="item-live"] [data-codexhost-question]'),
  ).toHaveCount(0);
  await expect(page.locator("#composer [data-codexhost-question]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Chat message" })).toHaveText("chat draft");
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

test("jump click keeps the reminder when the transcript row stays hidden", async ({ page }) => {
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.pendingAnchors[0].itemId = "item-missing";
    await Reflect.get(window, "controller").refresh();
  });
  await page.getByRole("button", { name: "Question waiting — Jump" }).click();
  await expect(page.getByRole("button", { name: "Question waiting — Jump" })).toBeVisible();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("shows jump instead of the overlay when the transcript is hidden", async ({ page }) => {
  await page.evaluate(async () => {
    for (const node of document.querySelectorAll("[data-local-conversation-item-target-ids]")) {
      node.remove();
    }
    for (const node of document.querySelectorAll("[data-content-search-turn-key]")) {
      node.remove();
    }
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("button", { name: "Question waiting — Jump" })).toBeVisible();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("jump click selects this chat tab when another window tab is active", async ({ page }) => {
  await page.evaluate(async () => {
    const bar = document.createElement("div");
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Chat tabs");
    bar.innerHTML =
      '<button type="button" role="tab" aria-label="Ask user to choose letters" aria-selected="false" id="chat-tab">Ask user to choose letters</button>' +
      '<button type="button" role="tab" aria-label="ORCA BURN LOOP" aria-selected="true" id="other-tab">ORCA BURN LOOP</button>';
    for (const tab of bar.querySelectorAll('[role="tab"]')) {
      tab.addEventListener("click", () => {
        for (const node of bar.querySelectorAll('[role="tab"]')) {
          node.setAttribute("aria-selected", node === tab ? "true" : "false");
        }
      });
    }
    const row = document.createElement("div");
    row.setAttribute("data-app-action-sidebar-thread-row", "");
    row.setAttribute("data-app-action-sidebar-thread-id", "local:thread-1");
    row.setAttribute("aria-current", "page");
    row.textContent = "UnreadAsk user to choose letters";
    document.body.prepend(bar, row);
    const state = Reflect.get(window, "fixture");
    state.pendingAnchors[0].itemId = "item-missing";
    await Reflect.get(window, "controller").refresh();
  });
  await page.getByRole("button", { name: "Question waiting — Jump" }).click();
  await expect(page.locator("#chat-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#other-tab")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("button", { name: "Question waiting — Jump" })).toBeVisible();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("parks a folded record on the turn's visible reply", async ({ page }) => {
  const folded = page.locator('[data-codexhost-question-record="ask-folded"]');
  await expect(folded).toHaveCount(1);
  await expect(folded.locator(".outcome")).toHaveText("Answered");
  await expect(folded.getByText("Alpha", { exact: true })).toBeVisible();
  await expect(folded.getByText("Beta", { exact: true })).toHaveCount(0);
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
  await expect(skipped.getByText("Alpha", { exact: true })).toHaveCount(0);
  await expect(skipped.getByText("Beta", { exact: true })).toHaveCount(0);
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

test("keeps a history slot inside a flex-row turn instead of beside it in the transcript", async ({
  page,
}) => {
  const card = page.locator('[data-codexhost-question-record="ask-rowish"]');
  await expect(card).toHaveCount(1);
  await expect
    .poll(async () =>
      page.locator("#turn-rowish").evaluate((turn) => {
        const slot = turn.querySelector("[data-codexhost-question-history]");
        const card = turn.ownerDocument.querySelector(
          '[data-codexhost-question-record="ask-rowish"]',
        );
        return (
          slot?.parentElement === turn &&
          turn.contains(card) &&
          turn.parentElement?.querySelector(":scope > [data-codexhost-question-history]") == null
        );
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    await Reflect.get(window, "controller").refresh();
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.locator("#turn-rowish > [data-codexhost-question-history]")).toHaveCount(1);
  await expect(page.locator("#transcript > [data-codexhost-question-history]")).toHaveCount(0);
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
