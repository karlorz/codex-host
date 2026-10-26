import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
import {installRendererQuestions} from './packages/renderer-extension/src/renderer-questions.ts';
const question={interactionId:'ask-1',turnId:'turn-1',title:'Grok',questions:[
 {id:'letters',type:'choice',prompt:'Choose letters',multiple:true,allowOther:true,optional:false,options:[{value:'a',label:'Alpha'},{value:'b',label:'Beta'},{value:'g',label:'Gamma'}]},
 {id:'note',type:'text',prompt:'Add a note',multiline:true,secret:false,optional:true},
 {id:'single',type:'choice',prompt:'Choose one',multiple:false,allowOther:false,optional:true,options:[{value:'x',label:'One'},{value:'y',label:'Two'}]},
]};
const state={questions:[question],calls:[],thread:'thread-1',host:'local',fail:false,hold:false,defer:null,listHold:false,listDefer:null,activityHold:false,activityDefer:null,activityFail:false,activityAck:null};
const route={async sendRequest(method,params){state.calls.push({method,params});
 if(method.endsWith('/list')){if(state.listHold)await new Promise(r=>state.listDefer=r);return {questions:state.questions};}
 if(method.endsWith('/activity')){if(state.activityHold)await new Promise(r=>state.activityDefer=r);if(state.activityFail)throw Error('activity failed');return {autoResolution:state.activityAck};}
 if(!method.endsWith('/respond'))throw Error('Unused fixture RPC');
 if(state.hold)await new Promise(r=>state.defer=r);
 if(state.fail)throw Error('retry');state.questions=[];return {accepted:true};
}};
let context=()=>state.thread?{hostId:state.host,threadId:state.thread,composer:document.querySelector('#composer'),route}:null;
const controller=installRendererQuestions(window,()=>context());
Object.assign(window,{fixture:state,controller,setContext:fn=>context=fn,route});
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
if (!bundle) throw new Error("Question test bundle missing");
test.beforeEach(async ({ page }) => {
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="composer"></div>' }),
  );
  await page.goto("http://localhost/");
  await page.addScriptTag({ content: bundle });
});

test("resets countdown only after native ack, preserves drafts and ignores stale polling", async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.questions[0].autoResolution = {
      deadlineUnixMs: Date.now() + 5000,
      action: "recommended",
      resetOnActivity: true,
    };
    state.activityAck = {
      deadlineUnixMs: Date.now() + 120000,
      action: "recommended",
      resetOnActivity: true,
    };
    state.activityHold = true;
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("timer")).toHaveText("Auto-select recommended in 0:05");
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).hover();
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).evaluate((input) => {
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  });
  await page.clock.runFor(300);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
        c.method.endsWith("/activity"),
      ),
    ),
  ).toHaveLength(0);
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).check();
  await page.getByLabel("Choose letters: Other", { exact: true }).fill("keep my draft");
  await page.clock.runFor(300);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
        c.method.endsWith("/activity"),
      ),
    ),
  ).toEqual([
    {
      method: "codexhost/thread/question/activity",
      params: { threadId: "thread-1", turnId: "turn-1", interactionId: "ask-1" },
    },
  ]);
  await expect(page.getByRole("timer")).toHaveText("Auto-select recommended in 0:05");
  await page.evaluate(() => Reflect.get(window, "fixture").activityDefer());
  await expect(page.getByRole("timer")).toHaveText("Auto-select recommended in 2:00");
  await page.evaluate(async () => {
    await Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("timer")).toHaveText("Auto-select recommended in 2:00");
  await expect(page.getByRole("checkbox", { name: "Alpha", exact: true })).toBeChecked();
  await expect(page.getByLabel("Choose letters: Other", { exact: true })).toHaveValue(
    "keep my draft",
  );
});

test("does not reset a disabled timer or optimistically reset a failed request", async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.questions[0].autoResolution = {
      deadlineUnixMs: Date.now() + 3000,
      action: "recommended",
      resetOnActivity: false,
    };
    await Reflect.get(window, "controller").refresh();
  });
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).check();
  await page.clock.runFor(300);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
        c.method.endsWith("/activity"),
      ),
    ),
  ).toHaveLength(0);
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.questions[0].autoResolution.resetOnActivity = true;
    state.activityFail = true;
    await Reflect.get(window, "controller").refresh();
  });
  await page.getByRole("checkbox", { name: "Gamma", exact: true }).check();
  await page.clock.runFor(300);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
        c.method.endsWith("/activity"),
      ),
    ),
  ).toHaveLength(1);
  await page.clock.runFor(2500);
  await expect(page.getByRole("timer")).toHaveText("Waiting for Harness…");
  await expect(page.getByRole("checkbox", { name: "Alpha", exact: true })).toBeChecked();
});

test("drops late activity acknowledgement after leaving the question chat", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const state = Reflect.get(window, "fixture");
    state.questions[0].autoResolution = {
      deadlineUnixMs: Date.now() + 1000,
      action: "recommended",
      resetOnActivity: true,
    };
    state.activityHold = true;
    state.activityAck = {
      deadlineUnixMs: Date.now() + 120000,
      action: "recommended",
      resetOnActivity: true,
    };
    await Reflect.get(window, "controller").refresh();
  });
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).check();
  await page.clock.runFor(300);
  await page.evaluate(async () => {
    Reflect.get(window, "fixture").thread = null;
    await Reflect.get(window, "controller").refresh();
    Reflect.get(window, "fixture").activityDefer();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("submits Alpha and Gamma with mixed text and single-choice fields", async ({ page }) => {
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).check();
  await page.getByRole("checkbox", { name: "Gamma", exact: true }).check();
  await page.getByLabel("Add a note", { exact: true }).fill("hello");
  await page.getByRole("radio", { name: "Two", exact: true }).check();
  // Periodic refreshes must preserve unsent selections and text.
  await page.waitForTimeout(900);
  await expect(page.getByRole("checkbox", { name: "Alpha", exact: true })).toBeChecked();
  await expect(page.getByLabel("Add a note", { exact: true })).toHaveValue("hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  const calls = await page.evaluate(() =>
    Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
      c.method.endsWith("/respond"),
    ),
  );
  expect(calls).toEqual([
    {
      method: "codexhost/thread/question/respond",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        interactionId: "ask-1",
        answers: { letters: ["a", "g"], note: ["hello"], single: ["y"] },
        cancelled: false,
      },
    },
  ]);
});

test("shows only a native deadline countdown and never submits on expiry", async ({ page }) => {
  await page.addStyleTag({
    content: ":root { color-scheme: dark; } body { background: #101010; margin: 24px; }",
  });
  await expect(page.getByRole("timer")).toBeHidden();
  await page.clock.install();
  await page.evaluate(() => {
    Reflect.get(window, "fixture").questions[0].autoResolution = {
      deadlineUnixMs: Date.now() + 2000,
      action: "recommended",
    };
    document.querySelector("[data-codexhost-question]")?.remove();
    void Reflect.get(window, "controller").refresh();
  });
  await expect(page.getByRole("timer")).toHaveText("Auto-select recommended in 0:02");
  await page.locator("[data-codexhost-question]").screenshot({
    path: path.resolve(import.meta.dirname, "../../.codexhost/live-tests/question-countdown.png"),
  });
  await page.clock.runFor(1000);
  await expect(page.getByRole("timer")).toHaveText("Auto-select recommended in 0:01");
  await page.clock.runFor(1000);
  await expect(page.getByRole("timer")).toHaveText("Waiting for Harness…");
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "fixture").calls.some((call: { method: string }) =>
        call.method.endsWith("/respond"),
      ),
    ),
  ).toBe(false);
  await page.evaluate(() => {
    Reflect.get(window, "fixture").questions = [];
    void Reflect.get(window, "controller").refresh();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("single-choice Other leaves the normal message editor available", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = Reflect.get(window, "fixture");
    fixture.questions[0].questions = [{ ...fixture.questions[0].questions[0], multiple: false }];
    const composer = document.querySelector("#composer");
    if (!composer) throw Error("Missing Composer");
    composer.innerHTML =
      '<div contenteditable="true" role="textbox" aria-label="Chat message"></div>';
    document.querySelector("[data-codexhost-question]")?.remove();
    void Reflect.get(window, "controller").refresh();
  });
  await page.getByRole("radio", { name: "Alpha", exact: true }).check();
  await page.getByLabel("Choose letters: Other", { exact: true }).fill("Other layout test");
  await expect(page.getByRole("radio", { name: "Alpha", exact: true })).not.toBeChecked();
  await page.getByRole("textbox", { name: "Chat message", exact: true }).fill("message draft");
  await expect(page.locator("#composer [contenteditable]")).toHaveText("message draft");
  await expect(page.locator("#composer [data-codexhost-question]")).toHaveCount(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, "fixture").calls.find((call: { method: string }) =>
          call.method.endsWith("/respond"),
        ).params.answers,
    ),
  ).toEqual({ letters: ["Other layout test"] });
});

test("validates required choices and Other text and retains values after rejection", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("required");
  await page.getByRole("checkbox", { name: "Other: Choose letters", exact: true }).check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Other");
  await page.getByLabel("Choose letters: Other", { exact: true }).fill("Delta");
  await expect(
    page.getByRole("checkbox", { name: "Other: Choose letters", exact: true }),
  ).toBeChecked();
  await expect(page.locator(".other .selected-indicator").first()).toBeVisible();
  await page.evaluate(() => (Reflect.get(window, "fixture").fail = true));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not submit");
  await expect(page.getByLabel("Choose letters: Other", { exact: true })).toHaveValue("Delta");
  await page.evaluate(() => (Reflect.get(window, "fixture").fail = false));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("suppresses duplicate submissions and cancels with no answers", async ({ page }) => {
  await page.evaluate(() => (Reflect.get(window, "fixture").hold = true));
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByRole("button", { name: "Skip", exact: true })).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, "fixture").calls.filter((c: { method: string }) =>
          c.method.endsWith("/respond"),
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => Reflect.get(window, "fixture").defer());
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, "fixture").calls.find((c: { method: string }) =>
          c.method.endsWith("/respond"),
        ).params,
    ),
  ).toMatchObject({ answers: {}, cancelled: true });
});

test("uses the native-style header and dismissal without submitting selected answers", async ({
  page,
}) => {
  const card = page.locator("[data-codexhost-question]");
  await expect(card.locator(".title")).toHaveText("Question");
  await expect(card.locator(".question-icon svg")).toHaveCount(1);
  await expect(card.getByRole("button", { name: "Dismiss question" }).locator("svg")).toHaveCount(
    1,
  );
  await expect(card.locator(".option:not(.other) .shortcut")).toHaveText(["1", "2", "3", "1", "2"]);
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).check();
  await page.getByRole("button", { name: "Dismiss question", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, "fixture").calls.find((call: { method: string }) =>
          call.method.endsWith("/respond"),
        ).params,
    ),
  ).toMatchObject({ answers: {}, cancelled: true });
});

test("hides on chat switching, restores drafts, and withdraws closed questions", async ({
  page,
}) => {
  await page.getByRole("checkbox", { name: "Gamma", exact: true }).check();
  await page.evaluate(() => (Reflect.get(window, "fixture").thread = null));
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.evaluate(() => (Reflect.get(window, "fixture").thread = "thread-1"));
  await expect(page.getByRole("checkbox", { name: "Gamma", exact: true })).toBeChecked();
  await page.evaluate(() => (Reflect.get(window, "fixture").questions = []));
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "fixture").calls.some((c: { method: string }) =>
        c.method.endsWith("/respond"),
      ),
    ),
  ).toBe(false);
});

test("ignores late results after Host/Thread switch and after disposal", async ({ page }) => {
  await page.evaluate(() => {
    const f = Reflect.get(window, "fixture");
    f.listHold = true;
    f.host = "remote";
    f.thread = "thread-2";
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const f = Reflect.get(window, "fixture");
    f.thread = null;
    f.listDefer();
  });
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.evaluate(() => {
    Reflect.get(window, "controller").dispose();
    Reflect.get(window, "fixture").thread = "thread-1";
  });
  await page.waitForTimeout(900);
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
});

test("recovers a card removed by a native rerender without losing the draft", async ({ page }) => {
  await page.getByRole("checkbox", { name: "Gamma", exact: true }).check();
  await page.locator("[data-codexhost-question]").evaluate((root) => root.remove());
  await expect(page.getByRole("checkbox", { name: "Gamma", exact: true })).toBeChecked();
});

for (const scheme of ["dark", "light"] as const) {
  test(`keeps visible choice controls and selection styling under Desktop resets (${scheme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 940, height: 760 });
    // Desktop resets form appearance; a bare browser fixture misses invisible checkboxes.
    await page.addStyleTag({
      content: `
        :root { color-scheme: ${scheme}; }
        body { margin: 24px; background: ${scheme === "dark" ? "#101010" : "#ffffff"}; }
        *, ::before, ::after { box-sizing: border-box; border: 0 solid; }
        input, textarea, button { appearance: none; background: transparent; padding: 0; border-radius: 0; }
        input[type=checkbox], input[type=radio] { width: auto; height: auto; margin: 0; }
        fieldset, legend { margin: 0; padding: 0; }
      `,
    });
    await page.evaluate(() => {
      const fixture = Reflect.get(window, "fixture");
      fixture.questions[0].questions = [fixture.questions[0].questions[0]];
      for (const option of fixture.questions[0].questions[0].options) {
        option.description = `The ${option.label === "Alpha" ? "first" : option.label === "Beta" ? "second" : "third"} letter of the Greek alphabet`;
      }
      document.querySelector("[data-codexhost-question]")?.remove();
    });
    const alpha = page.getByRole("checkbox", { name: /^Alpha/ });
    const gamma = page.getByRole("checkbox", { name: /^Gamma/ });
    await expect(alpha).toBeVisible();
    const metrics = await alpha.evaluate((input) => {
      const style = getComputedStyle(input);
      return { appearance: style.appearance, width: input.clientWidth, height: input.clientHeight };
    });
    expect(metrics.appearance).toBe("none");
    expect(metrics.width).toBeGreaterThanOrEqual(16);
    expect(metrics.height).toBeGreaterThanOrEqual(16);
    const rowColor = () =>
      alpha.evaluate((input) => {
        const label = input.closest("label");
        if (!label) throw new Error("Choice label missing");
        return getComputedStyle(label).backgroundColor;
      });
    const unselected = await rowColor();
    await alpha.focus();
    await expect(alpha).toBeFocused();
    expect(await alpha.evaluate((input) => getComputedStyle(input).outlineStyle)).toBe("solid");
    await alpha.press("Space");
    await gamma.check();
    await expect(alpha).toBeChecked();
    await expect(gamma).toBeChecked();
    expect(await rowColor()).not.toBe(unselected);
    expect(
      await page
        .getByLabel("Choose letters: Other", { exact: true })
        .evaluate((input) => getComputedStyle(input).borderTopWidth),
    ).toBe("0px");
    await page.locator("[data-codexhost-question]").screenshot({
      path: path.resolve(
        import.meta.dirname,
        `../../.codexhost/live-tests/multiselect-card-${scheme}.png`,
      ),
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
    const answers = await page.evaluate(
      () =>
        Reflect.get(window, "fixture").calls.find((call: { method: string }) =>
          call.method.endsWith("/respond"),
        ).params.answers,
    );
    expect(answers).toEqual({ letters: ["a", "g"] });
  });
}

test("shows typed Other as selected alongside multiple choices", async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 760 });
  await page.addStyleTag({
    content: ":root { color-scheme: dark; } body { margin:24px; background:#101010; }",
  });
  await page.evaluate(() => {
    const fixture = Reflect.get(window, "fixture");
    fixture.questions[0].questions = [fixture.questions[0].questions[0]];
    for (const [index, option] of fixture.questions[0].questions[0].options.entries()) {
      option.description = `${["First", "Second", "Third"][index]} letter of the Greek alphabet`;
    }
    document.querySelector("[data-codexhost-question]")?.remove();
  });
  await page.getByRole("checkbox", { name: /^Alpha/ }).check();
  await page.getByRole("checkbox", { name: /^Beta/ }).check();
  await page.getByLabel("Choose letters: Other", { exact: true }).fill("test other");
  await expect(page.locator(".footer .other .selected-indicator")).toBeVisible();
  await expect(page.locator(".footer .pencil svg")).toHaveCount(1);
  await expect(page.locator(".footer .other")).toHaveCSS("outline-style", "solid");
  await expect(page.getByLabel("Choose letters: Other", { exact: true })).toHaveCSS(
    "outline-style",
    "none",
  );
  await page.getByLabel("Choose letters: Other", { exact: true }).blur();
  await page.locator("[data-codexhost-question]").screenshot({
    path: path.resolve(
      import.meta.dirname,
      "../../.codexhost/live-tests/multiselect-other-polish.png",
    ),
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const answers = await page.evaluate(
    () =>
      Reflect.get(window, "fixture").calls.find((call: { method: string }) =>
        call.method.endsWith("/respond"),
      ).params.answers,
  );
  expect(answers).toEqual({ letters: ["a", "b", "test other"] });
});

test("scrolls long question content while keeping the footer usable in a small window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 480 });
  const card = page.locator("[data-codexhost-question]");
  expect(
    await card.locator(".body").evaluate((body) => body.scrollHeight > body.clientHeight),
  ).toBe(true);
  const cancel = page.getByRole("button", { name: "Skip", exact: true });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport({
    ratio: 1,
  });
  await cancel.click();
  await expect(card).toHaveCount(0);
});

test("integrates with the full binding outside the native editor and follows Composer visibility", async ({
  page,
}) => {
  const full = await build({
    stdin: {
      contents: `
 import {installRendererBindingProbe} from './packages/renderer-extension/src/renderer-binding-probe.ts';
 import {encodeHarnessPluginRoute} from '@codexhost/shared-contracts';
 const nativeRoute=window.route;
 const routing={forHost:()=>({hostId:'local',manager:nativeRoute})};
 window.__codexhostHostRoutingV1=routing;
 const editor=document.querySelector('[contenteditable]');
 Object.defineProperty(editor,'__reactFiber$test',{value:{memoizedProps:{isOrbit:false},return:null}});
 const binding=installRendererBindingProbe({enabledAgents:['codex','grok'],defaultAgent:'grok'});
 const transportModelId=encodeHarnessPluginRoute({harnessId:'grok',model:{id:'grok-4.6'}});
 const client=new Proxy({}, {get:(_,key)=>{
  if(key==='currentHostId')return ()=> 'local';
  if(key==='clientForHost'||key==='knownHostIds')return undefined;
  if(String(key).startsWith('subscribe'))return ()=>()=>{};
  if(key==='inspectThread')return async()=>({owner:'external',harnessId:'grok',locked:true,transportModelId,history:{fork:false,forkAcrossCwd:false,rollbackLastTurn:false}});
  if(key==='listHarnessPlugins')return async()=>({plugins:[{id:'grok',name:'Grok',version:'1.0.0'}]});
  return async()=>{throw Error('Unused fixture call');};
 }});
 binding.setAdapter({state:'ready',reason:'ready',modelUpdates:0,hook:'request-bridge'},undefined,()=>true,client);
 `,
      resolveDir: path.resolve(import.meta.dirname, "../.."),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
    write: false,
  });
  await page.evaluate(() => Reflect.get(window, "controller").dispose());
  await page.setContent(
    '<form id="composer" data-codex-composer-root><div data-above-composer-portal data-above-composer-conversation-id="thread-1"></div><div contenteditable="true" role="textbox">chat draft</div><button type="submit">Send</button></form>',
  );
  const source = full.outputFiles[0]?.text;
  if (!source) throw Error("Missing binding bundle");
  await page.addScriptTag({ content: source });
  await expect(page.getByRole("checkbox", { name: "Gamma", exact: true })).toBeVisible();
  await page.screenshot({
    path: path.resolve(import.meta.dirname, "../../.codexhost/live-tests/multiselect-card.png"),
  });
  await expect(page.locator("#composer textarea")).toHaveCount(0);
  await expect(page.locator("#composer [contenteditable]")).toHaveCount(1);
  await expect(page.locator("#composer [data-codexhost-question]")).toHaveCount(0);
  await page.getByLabel("Add a note", { exact: true }).fill("question notes");
  await page.getByLabel("Add a note", { exact: true }).press("Enter");
  await expect(page.locator("#composer [contenteditable]")).toHaveText("chat draft");
  await page
    .locator("#composer")
    .evaluate((root) => ((root as HTMLElement).style.display = "none"));
  await expect(page.locator("[data-codexhost-question]")).toHaveCount(0);
  await page.locator("#composer").evaluate((root) => ((root as HTMLElement).style.display = ""));
  await expect(page.getByLabel("Add a note", { exact: true })).toHaveValue("question notes\n");
});
