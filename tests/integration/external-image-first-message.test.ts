import { expect, it, vi } from "vitest";
import { installRendererRpcSubmissionPreparation } from "../../packages/desktop-control/src/renderer-rpc-submission.js";
import { prepareRendererRpcAttachments } from "../../packages/renderer-extension/src/renderer-rpc-attachments.js";
import { externalTurnInputText } from "../../packages/host-runtime/src/external-turn-input.js";

const image = { type: "image", url: "data:image/png;base64,aGVsbG8=" };
function fixture(hostId: string) {
  const harness = vi.fn((input: unknown) => externalTurnInputText(input));
  const create = vi.fn(
    async (
      input: { input: unknown; collaborationMode: { settings: { model: string } } },
      options: unknown,
    ) => {
      const text = input.collaborationMode.settings.model.startsWith("codexhost/")
        ? harness(input.input)
        : null;
      return { status: "created", firstTurn: { status: "accepted" }, text, options };
    },
  );
  const storage = vi.fn(async ({ label }: { label: string }) => ({
    path: `/native/${label}`,
    fsPath: `/native/${label}`,
  }));
  const rpc = {
    startConversation: create,
    createFileAttachment: storage,
    getConversation: vi.fn(),
    getTurnCoordinator: vi.fn(),
    removePastedTextAttachment: vi.fn(),
  };
  const connection = { status: "ready", client: { hostId, rpc } };
  const store = {
    familyBindings: new Map([
      [{ kind: "signal-family" }, new Map([[hostId, { value: { get: () => connection } }]])],
    ]),
  };
  const handle = { node: store, chain: {}, scope: {}, get() {}, set() {}, watch() {} };
  const root = {
    getElementById: () => ({
      __reactContainer$app: { memoizedState: { memoizedState: { current: handle }, next: null } },
    }),
  };
  let selected = "codexhost/grok-native";
  const hook = installRendererRpcSubmissionPreparation(
    root,
    prepareRendererRpcAttachments,
    (host, draft) => (host === hostId && draft === "client-new-thread:external" ? selected : null),
  );
  const input = {
    input: [image],
    cwd: "/workspace",
    collaborationMode: {
      mode: "default",
      settings: { model: "gpt-reserve", reasoning_effort: "high" },
    },
    attachments: [{ native: "kept" }],
  };
  const options = { clientThreadId: "client-new-thread:external", onSettled: vi.fn() };
  return {
    rpc: connection.client.rpc,
    input,
    options,
    storage,
    create,
    harness,
    hook,
    retire: () => {
      connection.status = "disconnected";
    },
    select: (model: string) => {
      selected = model;
    },
  };
}

it.each(["local", "ssh:remote"])(
  "delivers an image-only first message through %s startup and the real Host parser",
  async (hostId) => {
    const f = fixture(hostId);
    const result = await f.rpc.startConversation(f.input, f.options);
    expect(result.firstTurn.status).toBe("accepted");
    expect(result.text).toContain("## image-1.png: /native/image-1.png\nImage attachment: true");
    expect(f.storage).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.create.mock.calls[0]?.[0].input).toContain(image);
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/workspace",
      attachments: f.input.attachments,
      collaborationMode: { settings: { model: "codexhost/grok-native", reasoning_effort: "high" } },
    });
    expect(f.create.mock.calls[0]?.[1]).toBe(f.options);
    expect(f.input.input).toEqual([image]);
    f.hook.dispose();
  },
);

it("captures the originating draft model and waits for storage before creating a chat", async () => {
  const f = fixture("local");
  const upload = Promise.withResolvers<{ path: string; fsPath: string }>();
  f.storage.mockReturnValueOnce(upload.promise);
  const pending = f.rpc.startConversation(f.input, f.options);
  await vi.waitFor(() => expect(f.storage).toHaveBeenCalledOnce());
  expect(f.create).not.toHaveBeenCalled();
  f.select("codexhost/other-native");
  upload.resolve({ path: "/native/image-1.png", fsPath: "/native/image-1.png" });
  await pending;
  expect(f.create.mock.calls[0]?.[0].collaborationMode.settings.model).toBe(
    "codexhost/grok-native",
  );
  f.hook.dispose();
});

it("rejects storage failure without leaving a newly created empty chat", async () => {
  const f = fixture("local");
  f.storage.mockRejectedValueOnce(new Error("upload failed"));
  await expect(f.rpc.startConversation(f.input, f.options)).rejects.toThrow("upload failed");
  expect(f.create).not.toHaveBeenCalled();
  expect(f.harness).not.toHaveBeenCalled();
  f.hook.dispose();
});

it("preserves official startup byte-for-byte despite another external draft", async () => {
  const f = fixture("local");
  const options = { ...f.options, clientThreadId: "client-new-thread:official" };
  await f.rpc.startConversation(f.input, options);
  expect(f.create).toHaveBeenCalledExactlyOnceWith(f.input, options);
  expect(f.storage).not.toHaveBeenCalled();
  expect(f.harness).not.toHaveBeenCalled();
  f.hook.dispose();
});

it("rejects a Host disconnect during first-message upload before native startup", async () => {
  const f = fixture("local");
  const upload = Promise.withResolvers<{ path: string; fsPath: string }>();
  f.storage.mockReturnValueOnce(upload.promise);
  const pending = f.rpc.startConversation(f.input, f.options);
  const rejected = expect(pending).rejects.toThrow("no longer available");
  await vi.waitFor(() => expect(f.storage).toHaveBeenCalledOnce());
  f.retire();
  upload.resolve({ path: "/native/image-1.png", fsPath: "/native/image-1.png" });
  await rejected;
  expect(f.create).not.toHaveBeenCalled();
  expect(f.rpc.removePastedTextAttachment).not.toHaveBeenCalled();
  f.hook.dispose();
});

it("never retries startup or deletes files after an ambiguous native outcome", async () => {
  const f = fixture("local");
  f.create.mockRejectedValueOnce(new Error("outcome unknown"));
  await expect(f.rpc.startConversation(f.input, f.options)).rejects.toThrow("outcome unknown");
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.storage).toHaveBeenCalledOnce();
  expect(f.rpc.removePastedTextAttachment).not.toHaveBeenCalled();
  f.hook.dispose();
});

it("retains an explicit native external carrier from the originating startup call", async () => {
  const f = fixture("local");
  f.input.collaborationMode.settings.model = "codexhost/origin-native";
  await f.rpc.startConversation(f.input, f.options);
  expect(f.create.mock.calls[0]?.[0].collaborationMode.settings.model).toBe(
    "codexhost/origin-native",
  );
  f.hook.dispose();
});
