import type { VoiceSettings } from "@codexhost/shared-contracts";
import { chatVoiceQualifiedOnOwner, workVoiceLaneEnabled } from "../renderer-voice-evidence.js";

export type VoiceSettingsEffectiveStatus = {
  chatAvailable: boolean;
  workAvailable: boolean;
  chatDesktopDefault: boolean;
  workDesktopDefault: boolean;
  chatLabel: string;
  workLabel: string;
};

function chatLabel(settings: Pick<VoiceSettings, "chatExperience" | "chatConnection">): string {
  if (settings.chatExperience === "chatgpt") return "ChatGPT Chat";
  return settings.chatConnection === "gateway"
    ? "Codex Chat gateway"
    : "Codex Chat Desktop default";
}

function workLabel(settings: Pick<VoiceSettings, "workConnection">): string {
  return settings.workConnection === "gateway" ? "Work gateway" : "Work Desktop default";
}

/** Effective selected-path availability. Saved routes stay the requested product. */
export function voiceSettingsEffectiveStatus(
  owner: object,
  settings: Pick<VoiceSettings, "chatExperience" | "chatConnection" | "workConnection">,
): VoiceSettingsEffectiveStatus {
  const chatDesktopDefault =
    settings.chatExperience === "codex" && settings.chatConnection === "desktop";
  const workDesktopDefault = settings.workConnection === "desktop";
  const chatAvailable = chatDesktopDefault ? true : chatVoiceQualifiedOnOwner(owner);
  const workAvailable = workDesktopDefault ? true : workVoiceLaneEnabled(owner, "work-codex");
  return {
    chatAvailable,
    workAvailable,
    chatDesktopDefault,
    workDesktopDefault,
    chatLabel: chatLabel(settings),
    workLabel: workLabel(settings),
  };
}

/** Poll key for selected-path availability. RPC-identical snapshots can still change this. */
export function voiceSettingsEffectiveStatusKey(
  owner: object,
  settings: Pick<VoiceSettings, "chatExperience" | "chatConnection" | "workConnection">,
): string {
  return JSON.stringify(voiceSettingsEffectiveStatus(owner, settings));
}

export function voiceSettingsRouteStatus(
  available: boolean,
  desktopDefault: boolean,
  copy: { desktopSelected: string; routeAllowed: string; pathUnavailable: string },
): string {
  if (desktopDefault) return copy.desktopSelected;
  return available ? copy.routeAllowed : copy.pathUnavailable;
}

export function voiceSettingsAvailabilityFooter(
  settings: Pick<VoiceSettings, "chatExperience" | "chatConnection" | "workConnection">,
  effective: VoiceSettingsEffectiveStatus,
): string | undefined {
  if (settings.chatExperience === "chatgpt" && !effective.chatAvailable)
    return "Chat voice is not available on this Desktop.";
  if (
    settings.chatExperience === "codex" &&
    settings.chatConnection === "gateway" &&
    !effective.chatAvailable
  )
    return "Chat voice is not available on this Desktop.";
  if (settings.workConnection === "gateway" && !effective.workAvailable)
    return "Work voice is not available on this Desktop.";
}
