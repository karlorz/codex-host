import type { RendererRpcSubmissionContext } from "@codexhost/desktop-control/renderer-bindings";
import { createRemoteAttachmentSender } from "./renderer-remote-attachments.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function replace(value: Record<string, unknown>, updates: Record<string, unknown>) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, item] of Object.entries(updates)) {
    descriptors[key] = { ...descriptors[key], value: item };
  }
  return Object.create(Object.getPrototypeOf(value), descriptors) as Record<string, unknown>;
}

/** Complete every native start/steer variant without changing admission or preview Items. */
export async function prepareRendererRpcAttachments(
  value: unknown,
  context: RendererRpcSubmissionContext,
): Promise<unknown> {
  if (!record(value) || !record(value.steer) || !Array.isArray(value.steer.input)) return value;
  const { manager, threadId, isCurrent } = context;
  const created = new Set<string>();
  const uploads = new Map<string, Promise<unknown>>();
  const storage = {
    getConversation: () => ({ id: threadId, modelProvider: "codexhost" }),
    async createFileAttachment({ contents, label }: { contents: Blob; label: string }) {
      const bytes = await contents.arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const key = `${label}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const cached = uploads.get(key);
      if (cached) return cached;
      // Blob instances are not capnweb values. Its native consumer only needs arrayBuffer().
      const upload = manager
        .createFileAttachment({ contents: { arrayBuffer: async () => bytes }, label })
        .then((saved) => {
          if (record(saved) && typeof saved.path === "string") created.add(saved.path);
          return saved;
        });
      uploads.set(key, upload);
      return upload;
    },
    removePastedTextAttachment: (path: string) => {
      created.delete(path);
      return manager.removePastedTextAttachment(path);
    },
  };
  const send = createRemoteAttachmentSender(storage, context.hostId, isCurrent);
  const input = async (request: Record<string, unknown>) => {
    const prepared = await send({ ...request, threadId }, (params) => params);
    if (!record(prepared)) throw new Error("Image attachment preparation returned invalid input");
    return prepared.input === request.input ? request : replace(request, { input: prepared.input });
  };
  try {
    let steer = await input(value.steer);
    if (
      record(steer.userMessageAdmissionStart) &&
      record(steer.userMessageAdmissionStart.request)
    ) {
      const admission = steer.userMessageAdmissionStart;
      const request = await input(admission.request as Record<string, unknown>);
      if (request !== admission.request) {
        // Preserve the native submission, including its non-enumerable disposal hook.
        steer = replace(steer, {
          userMessageAdmissionStart: replace(admission, { request }),
        });
      }
    }
    let start = value.start;
    if (record(start) && record(start.request)) {
      const request = await input(start.request);
      if (request !== start.request) start = replace(start, { request });
    }
    return steer === value.steer && start === value.start
      ? value
      : replace(value, { steer, ...(start === undefined ? {} : { start }) });
  } catch (error) {
    if (isCurrent())
      await Promise.allSettled(
        [...created].map((path) => manager.removePastedTextAttachment(path)),
      );
    throw error;
  }
}
