import { expect, it, vi } from "vitest";
import type { RendererRpcSubmissionContext } from "@codexhost/desktop-control/renderer-bindings";
import { desktopImageAttachmentPaths } from "@codexhost/shared-contracts";
import { prepareRendererRpcAttachments } from "../src/renderer-rpc-attachments.js";

const image = { type: "image", url: "data:image/png;base64,aGVsbG8=" };
const request = (input: unknown[] = [image]) => ({
  input,
  threadId: "thread",
  model: "native-model",
});
function fixture() {
  let current = true;
  const manager = {
    getConversation: vi.fn(async (id: string) => ({ id, modelProvider: "codexhost" })),
    getTurnCoordinator: vi.fn(async () => ({})),
    createFileAttachment: vi.fn(
      async ({
        contents,
        label,
      }: {
        contents: { arrayBuffer(): Promise<ArrayBuffer> };
        label: string;
      }) => {
        expect(new TextDecoder().decode(await contents.arrayBuffer())).toBe("hello");
        return { path: `/native/${label}`, fsPath: `/native/${label}` };
      },
    ),
    removePastedTextAttachment: vi.fn(async (path: string) => {
      void path;
    }),
  };
  const context: RendererRpcSubmissionContext = {
    hostId: "local",
    threadId: "thread",
    manager,
    isCurrent: () => current,
  };
  return {
    context,
    manager,
    retire() {
      current = false;
    },
  };
}
function paths(value: { input: unknown[] }) {
  const text = value.input
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" && item !== null && "type" in item && item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
  return desktopImageAttachmentPaths(text);
}

it("stores inline annotation images for all native variants, retains previews and disposal", async () => {
  const f = fixture();
  const dispose = vi.fn();
  const input = [image, image];
  const value = Object.defineProperty(
    {
      steer: {
        ...request(input),
        userMessageAdmissionStart: { request: request(input), admission: "native" },
      },
      start: { request: request(input), resume: { conversationId: "thread" } },
      native: "kept",
    },
    Symbol.dispose,
    { value: dispose },
  );
  const result = (await prepareRendererRpcAttachments(value, f.context)) as typeof value;
  expect(f.manager.createFileAttachment).toHaveBeenCalledTimes(2);
  for (const prepared of [
    result.steer,
    result.steer.userMessageAdmissionStart.request,
    result.start.request,
  ]) {
    expect(paths(prepared)).toEqual(["/native/image-1.png", "/native/image-2.png"]);
    expect(prepared.input.slice(1)).toEqual(input);
    expect(prepared.model).toBe("native-model");
  }
  expect(result.start.resume).toBe(value.start.resume);
  expect(Object.getOwnPropertyDescriptor(result, Symbol.dispose)).toEqual(
    Object.getOwnPropertyDescriptor(value, Symbol.dispose),
  );
  expect(result.native).toBe("kept");
  expect(value.steer.input).toBe(input);
  expect(dispose).not.toHaveBeenCalled();
  expect(f.manager.removePastedTextAttachment).not.toHaveBeenCalled();
});

it("keeps text-only and complete native-path preparations identical", async () => {
  const f = fixture();
  for (const input of [
    [{ type: "text", text: "Hello" }],
    [
      {
        type: "text",
        text: "# Files mentioned by the user:\n## native.png: /native/picture.png\nImage attachment: true\n\n## My request:\nDescribe",
      },
      image,
    ],
  ]) {
    const value = { steer: request(input), start: { request: request(input) } };
    expect(await prepareRendererRpcAttachments(value, f.context)).toBe(value);
  }
  expect(f.manager.createFileAttachment).not.toHaveBeenCalled();
});

it("cleans uploads exactly once if a later variant fails before dispatch", async () => {
  const f = fixture();
  const value = {
    steer: request(),
    start: { request: request([image, { type: "image", url: "bad" }]) },
  };
  await expect(prepareRendererRpcAttachments(value, f.context)).rejects.toThrow(
    "supported base64 image",
  );
  expect(f.manager.removePastedTextAttachment).toHaveBeenCalledExactlyOnceWith(
    "/native/image-1.png",
  );
});

it("does not delete through a retired connection or silently accept a failed upload", async () => {
  const f = fixture();
  const upload = Promise.withResolvers<{ path: string; fsPath: string }>();
  f.manager.createFileAttachment.mockReturnValueOnce(upload.promise);
  const pending = prepareRendererRpcAttachments({ steer: request() }, f.context);
  const rejected = expect(pending).rejects.toThrow("no longer available");
  await vi.waitFor(() => expect(f.manager.createFileAttachment).toHaveBeenCalledOnce());
  f.retire();
  upload.resolve({ path: "/native/image-1.png", fsPath: "/native/image-1.png" });
  await rejected;
  expect(f.manager.removePastedTextAttachment).not.toHaveBeenCalled();
});
