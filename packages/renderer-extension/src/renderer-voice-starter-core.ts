import { committedReactAncestors } from "@codexhost/desktop-control/renderer-react-ownership";
import { rememberVoiceProductExperience } from "./renderer-voice-gateway-wrap.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object";
type Start = (...args: unknown[]) => unknown;
type Binding = { dispose(): void; current(): boolean };
type Attempt = { binding?: Binding };

/** Explicit local starts use Chat's choice or Work's choice for Work/Codex. */
export function gatewayVoiceStartRequest(
  request: unknown,
  workGateway: boolean,
  chatGateway = false,
  externalHarness = false,
): boolean {
  if (
    !record(request) ||
    (request.productExperience !== "work" &&
      request.productExperience !== "codex" &&
      request.productExperience !== "chat")
  )
    return false;
  if (request.source === "composer_button_existing_thread") {
    if (!record(request.locator) || request.locator.hostId !== "local") return false;
  } else if (
    request.source !== "composer_button_new_thread" ||
    (request.hostId ?? "local") !== "local"
  )
    return false;
  if (request.productExperience === "chat") return chatGateway;
  const mode = request.activeCollaborationMode;
  const settings = record(mode) ? mode.settings : undefined;
  const model = record(settings) ? settings.model : undefined;
  if (typeof model === "string" && model.startsWith("codexhost/")) return externalHarness;
  return workGateway || externalHarness;
}

export function wrapGatewayVoiceStarter(
  start: Start,
  options: {
    qualifies(request: unknown): boolean;
    ready(): Promise<boolean>;
    prepare(allowed: () => boolean): Promise<Binding>;
    committed(binding: Binding): Promise<void>;
    configured?(request: unknown): boolean;
    unavailable?(request: unknown): string;
  },
) {
  let active: Attempt | undefined;
  return {
    async start(...args: unknown[]) {
      const request = args[0];
      const qualified = options.qualifies(request);
      const wantsGateway = options.configured?.(request) ?? qualified;
      if (!wantsGateway) return start(...args);
      if (!qualified) {
        throw new Error(
          options.unavailable?.(request) ?? "Work voice is not qualified on this Desktop.",
        );
      }
      if (active) {
        active.binding?.dispose();
        active = undefined;
      }
      const attempt: Attempt = {};
      active = attempt;
      const allowed = () => active === attempt && options.qualifies(args[0]);
      try {
        if (!(await options.ready())) throw new Error("Voice gateway is not ready");
        if (!allowed()) throw new Error("Voice gateway start was cancelled");
        attempt.binding = await options.prepare(allowed);
        await options.committed(attempt.binding);
        if (!allowed()) throw new Error("Voice gateway start was cancelled");
        if (!attempt.binding.current()) throw new Error("Voice starter subscription changed");
        // Desktop's useEffectEvent now sees the committed capability snapshot.
        // Its workspace, media, busy, treatment and account checks remain native.
        rememberVoiceProductExperience(args[0]);
        return await start(...args);
      } finally {
        attempt.binding?.dispose();
        if (active === attempt) active = undefined;
      }
    },
    cancel() {
      active?.binding?.dispose();
      active = undefined;
    },
  };
}

/** Native overlay ancestors below the exported page, with exactly one starter
 * capability subscription. Composer and unrelated AppScope owners are excluded.
 */
export function overlayVoiceStarterFibers(document: Document, page: unknown): Set<RecordValue> {
  const fibers = new Set<RecordValue>();
  for (const element of document.querySelectorAll("[data-avatar-overlay-native-surface-id]")) {
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    const ancestors = committedReactAncestors(
      key && Object.getOwnPropertyDescriptor(element, key)?.value,
    );
    const boundary = ancestors.findIndex((fiber) => record(fiber) && fiber.type === page);
    if (boundary < 0) continue;
    for (const fiber of ancestors.slice(0, boundary)) if (record(fiber)) fibers.add(fiber);
  }
  return fibers;
}

/** Hashed 26.1106 Compact Voice has no named AvatarOverlayNativePage export.
 * Instant Connect compositor subscriptions live on these overlay surfaces.
 */
export function hashedOverlayVoiceStarterFibers(document: Document): Set<RecordValue> {
  const fibers = new Set<RecordValue>();
  for (const element of document.querySelectorAll("[data-avatar-overlay-native-surface-id]")) {
    const key = Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber$"));
    const ancestors = committedReactAncestors(
      key && Object.getOwnPropertyDescriptor(element, key)?.value,
    );
    for (const fiber of ancestors) if (record(fiber)) fibers.add(fiber);
  }
  return fibers;
}
