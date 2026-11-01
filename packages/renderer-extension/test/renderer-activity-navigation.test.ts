import { describe, expect, it, vi } from "vitest";
import { hostThreadIdSchema, type BackgroundActivity } from "@codexhost/shared-contracts";
import { openRendererActivityChild } from "../src/renderer-activity-navigation.js";
import type { QuestionContext } from "../src/renderer-questions.js";

const child: BackgroundActivity = {
  id: "real-child",
  kind: "subagent",
  label: "Loop tick",
  status: "completed",
  canStop: false,
  threadId: hostThreadIdSchema.parse("child-thread"),
};
function fixture(props: Record<string, unknown> = {}) {
  const open = vi.fn();
  const ownerFiber = {
    memoizedProps: {
      hostId: "local",
      conversationId: "parent",
      onOpenBackgroundAgent: open,
      ...props,
    },
    return: null as unknown,
  };
  const first = { memoizedProps: {}, return: ownerFiber };
  const composer = { isConnected: true, querySelectorAll: () => [] };
  Object.defineProperty(composer, "__reactFiber$test", { value: first });
  const owner: QuestionContext = {
    hostId: "local",
    threadId: "parent",
    composer: composer as unknown as Element,
    route: { sendRequest: vi.fn() },
  };
  return { owner, open, ownerFiber, first, composer };
}
describe("native activity child navigation ownership", () => {
  it("opens a real read-only child through its parent's native panel callback", () => {
    const { owner, open } = fixture();
    openRendererActivityChild(owner, child);
    expect(open).toHaveBeenCalledExactlyOnceWith({
      conversationId: "child-thread",
      displayName: "Loop tick",
      canInteract: false,
    });
    expect(owner.route.sendRequest).not.toHaveBeenCalled();
  });
  it.each([{ hostId: "foreign" }, { conversationId: "another-parent" }])(
    "rejects a foreign callback %o",
    (props) => {
      const { owner, open } = fixture(props);
      expect(() => openRendererActivityChild(owner, child)).toThrow(/another chat or Host/);
      expect(open).not.toHaveBeenCalled();
    },
  );
  it("rejects missing and conflicting callbacks", () => {
    const missing = fixture({ onOpenBackgroundAgent: undefined });
    expect(() => openRendererActivityChild(missing.owner, child)).toThrow(
      /unavailable or ambiguous/,
    );
    const mixed = fixture();
    const other = vi.fn();
    mixed.ownerFiber.return = {
      memoizedProps: { hostId: "local", conversationId: "parent", onOpenBackgroundAgent: other },
      return: null,
    };
    expect(() => openRendererActivityChild(mixed.owner, child)).toThrow(/unavailable or ambiguous/);
    expect(mixed.open).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });
  it("uses the published React owner rather than a retained alternate", () => {
    const { owner, open, ownerFiber, first } = fixture();
    const wrong = vi.fn();
    const liveOwner = {
      memoizedProps: { hostId: "local", conversationId: "parent", onOpenBackgroundAgent: open },
      return: null as unknown,
      child: null as unknown,
      alternate: ownerFiber,
    };
    const liveFirst = { memoizedProps: {}, return: liveOwner, alternate: first };
    liveOwner.child = liveFirst;
    const root: Record<string, unknown> = {
      stateNode: { current: null },
      return: null,
      child: liveOwner,
    };
    liveOwner.return = root;
    root.stateNode = { current: root };
    ownerFiber.return = root;
    ownerFiber.memoizedProps.onOpenBackgroundAgent = wrong;
    Object.assign(first, { alternate: liveFirst });
    openRendererActivityChild(owner, child);
    expect(open).toHaveBeenCalledOnce();
    expect(wrong).not.toHaveBeenCalled();
  });
  it("rejects detached composers, processes and missing child identities", () => {
    const state = fixture();
    state.composer.isConnected = false;
    expect(() => openRendererActivityChild(state.owner, child)).toThrow(/unavailable/);
    state.composer.isConnected = true;
    for (const bad of [
      { ...child, kind: "task" as const },
      { ...child, threadId: undefined },
    ])
      expect(() => openRendererActivityChild(state.owner, bad)).toThrow(/unavailable/);
    expect(state.open).not.toHaveBeenCalled();
  });
});
