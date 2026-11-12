import {
  CODEX_USAGE_BANNER_CHANGE_EVENT,
  readCodexUsageBannerPreference,
  writeCodexUsageBannerPreference,
} from "../renderer-codex-usage-banner-preference.js";
import {
  HARNESS_QUESTION_HISTORY_CHANGE_EVENT,
  readHarnessQuestionHistory,
  writeHarnessQuestionHistory,
} from "../renderer-question-history-preference.js";
import {
  HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT,
  readHarnessQuestionPlacement,
  writeHarnessQuestionPlacement,
} from "../renderer-question-placement-preference.js";
import {
  REASONING_SOFT_WRAP_CHANGE_EVENT,
  readReasoningTranscriptSoftWrap,
  setReasoningTranscriptSoftWrap,
} from "../renderer-transcript-dom.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { mountIdleReleaseControls } from "./idle-release-controls.js";
import type { LoadedSessionsClient } from "./loaded-sessions-table.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

export function createAppearanceSettingsPage(
  messages: RendererSettingsMessages,
  getLoadedSessionsClient: () => LoadedSessionsClient | null = () => null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "appearance",
    label: messages.pageLabels.appearance,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const ownerWindow = document.defaultView;
      if (!ownerWindow) return;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.appearance;

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.appearanceDescription;

      const { group, card } = createPreferenceGroup(document, messages.appearanceGroup);
      const usageBannerId = preferenceId("hide-codex-usage-banner");
      const usageBannerRow = createPreferenceItem(document, {
        title: messages.hideCodexUsageBannerTitle,
        description: messages.hideCodexUsageBannerDescription,
        controlId: usageBannerId,
        help: {
          label: messages.hideCodexUsageBannerHelpLabel,
          lines: messages.hideCodexUsageBannerHelp,
        },
      });
      const usageBanner = createPreferenceSwitch(
        document,
        usageBannerId,
        usageBannerRow.description.id,
      );
      usageBanner.checked = readCodexUsageBannerPreference(ownerWindow);
      usageBanner.addEventListener("change", () => {
        writeCodexUsageBannerPreference(ownerWindow, usageBanner.checked);
      });
      const syncUsageBanner = (): void => {
        usageBanner.checked = readCodexUsageBannerPreference(ownerWindow);
      };
      ownerWindow.addEventListener(CODEX_USAGE_BANNER_CHANGE_EVENT, syncUsageBanner);
      usageBannerRow.item.append(usageBanner);
      card.append(usageBannerRow.item);

      const inChatId = preferenceId("harness-question-in-chat");
      const inChatRow = createPreferenceItem(document, {
        title: messages.harnessQuestionInChatTitle,
        description: messages.harnessQuestionInChatDescription,
        controlId: inChatId,
        help: {
          label: messages.harnessQuestionInChatHelpLabel,
          lines: messages.harnessQuestionInChatHelp,
        },
      });
      const inChat = createPreferenceSwitch(document, inChatId, inChatRow.description.id);
      inChat.checked = readHarnessQuestionPlacement(ownerWindow) === "in-chat";
      inChat.addEventListener("change", () => {
        writeHarnessQuestionPlacement(ownerWindow, inChat.checked);
      });
      const syncInChat = (): void => {
        inChat.checked = readHarnessQuestionPlacement(ownerWindow) === "in-chat";
      };
      ownerWindow.addEventListener(HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT, syncInChat);
      inChatRow.item.append(inChat);
      card.append(inChatRow.item);

      const historyId = preferenceId("harness-question-history-selected");
      const historyRow = createPreferenceItem(document, {
        title: messages.harnessQuestionHistorySelectedTitle,
        description: messages.harnessQuestionHistorySelectedDescription,
        controlId: historyId,
        help: {
          label: messages.harnessQuestionHistorySelectedHelpLabel,
          lines: messages.harnessQuestionHistorySelectedHelp,
        },
      });
      const history = createPreferenceSwitch(document, historyId, historyRow.description.id);
      history.checked = readHarnessQuestionHistory(ownerWindow) === "selected";
      history.addEventListener("change", () => {
        writeHarnessQuestionHistory(ownerWindow, history.checked);
      });
      const syncHistory = (): void => {
        history.checked = readHarnessQuestionHistory(ownerWindow) === "selected";
      };
      ownerWindow.addEventListener(HARNESS_QUESTION_HISTORY_CHANGE_EVENT, syncHistory);
      historyRow.item.append(history);
      card.append(historyRow.item);

      const softWrapId = preferenceId("reasoning-soft-wrap");
      const row = createPreferenceItem(document, {
        title: messages.reasoningSoftWrapTitle,
        description: messages.reasoningSoftWrapDescription,
        controlId: softWrapId,
      });
      const toggle = createPreferenceSwitch(document, softWrapId, row.description.id);
      toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      toggle.addEventListener("change", () => {
        setReasoningTranscriptSoftWrap(ownerWindow, toggle.checked);
      });
      const sync = (): void => {
        toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      };
      ownerWindow.addEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
      row.item.append(toggle);
      card.append(row.item);

      context.content.append(heading, description, group);
      const disposeIdleRelease = mountIdleReleaseControls(
        context,
        messages,
        getLoadedSessionsClient,
      );
      return () => {
        ownerWindow.removeEventListener(CODEX_USAGE_BANNER_CHANGE_EVENT, syncUsageBanner);
        ownerWindow.removeEventListener(HARNESS_QUESTION_PLACEMENT_CHANGE_EVENT, syncInChat);
        ownerWindow.removeEventListener(HARNESS_QUESTION_HISTORY_CHANGE_EVENT, syncHistory);
        ownerWindow.removeEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
        disposeIdleRelease();
      };
    },
  });
}
