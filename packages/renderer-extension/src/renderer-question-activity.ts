/** Coalesce real card activity; opening, hover and synthetic events never reset a native timer. */
export function installQuestionActivity(
  window: Window,
  root: HTMLElement,
  enabled: () => boolean,
  reset: () => Promise<void>,
) {
  let disposed = false;
  let inFlight = false;
  let queued = false;
  let blurred = false;
  let timer: number | undefined;
  const available = () => !disposed && root.isConnected && enabled();
  const schedule = () => {
    if (timer !== undefined || inFlight || !queued || !available()) return;
    timer = window.setTimeout(() => {
      void flush();
    }, 250);
  };
  const flush = async () => {
    timer = undefined;
    if (!available()) {
      queued = false;
      return;
    }
    queued = false;
    inFlight = true;
    try {
      await reset();
    } catch {
      /* Native timeout remains authoritative on a failed ping. */
    } finally {
      inFlight = false;
      schedule();
    }
  };
  const activity = (event: Event) => {
    if (!event.isTrusted || !available()) return;
    queued = true;
    schedule();
  };
  const blur = (event: Event) => {
    if (event.isTrusted) blurred = true;
  };
  const focus = (event: Event) => {
    if (!blurred) return;
    blurred = false;
    activity(event);
  };
  const events = ["pointerdown", "keydown", "input", "wheel"];
  for (const event of events) root.addEventListener(event, activity, { passive: true });
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  return () => {
    disposed = true;
    queued = false;
    if (timer !== undefined) window.clearTimeout(timer);
    for (const event of events) root.removeEventListener(event, activity);
    window.removeEventListener("blur", blur);
    window.removeEventListener("focus", focus);
  };
}
