import { afterEach, describe, expect, it, vi } from "vitest";
import { installQuestionActivity } from "../src/renderer-question-activity.js";

function target() {
  const listeners = new Map<string, EventListener>();
  return {
    isConnected: true,
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
    emit(name: string, isTrusted = true) {
      listeners.get(name)?.({ isTrusted } as Event);
    },
  };
}
function setup(reset = vi.fn(async (): Promise<void> => {})) {
  const root = target();
  const window = {
    ...target(),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const state = { enabled: true };
  const dispose = installQuestionActivity(
    window as unknown as Window,
    root as unknown as HTMLElement,
    () => state.enabled,
    reset,
  );
  return { root, window, state, reset, dispose };
}
afterEach(() => vi.useRealTimers());
describe("question activity", () => {
  it("coalesces real interactions and later focus regain, excluding initial focus and hover", async () => {
    vi.useFakeTimers();
    const { root, window, reset, dispose } = setup();
    window.emit("focus");
    root.emit("pointermove");
    root.emit("input", false);
    await vi.advanceTimersByTimeAsync(500);
    expect(reset).not.toHaveBeenCalled();
    root.emit("pointerdown");
    root.emit("keydown");
    root.emit("input");
    root.emit("wheel");
    await vi.advanceTimersByTimeAsync(250);
    expect(reset).toHaveBeenCalledTimes(1);
    window.emit("blur");
    window.emit("focus");
    await vi.advanceTimersByTimeAsync(250);
    expect(reset).toHaveBeenCalledTimes(2);
    dispose();
  });
  it("bounds in-flight and queued pings and cancels queued work on disposal", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const reset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const { root, dispose } = setup(reset);
    root.emit("input");
    await vi.advanceTimersByTimeAsync(250);
    for (let n = 0; n < 100; n++) root.emit("input");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reset).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(250);
    expect(reset).toHaveBeenCalledTimes(2);
    root.emit("input");
    dispose();
    complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reset).toHaveBeenCalledTimes(2);
  });
  it("rechecks native enablement and card connection before sending", async () => {
    vi.useFakeTimers();
    const { root, state, reset, dispose } = setup();
    root.emit("input");
    state.enabled = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(reset).not.toHaveBeenCalled();
    state.enabled = true;
    root.emit("input");
    root.isConnected = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(reset).not.toHaveBeenCalled();
    dispose();
  });
});
