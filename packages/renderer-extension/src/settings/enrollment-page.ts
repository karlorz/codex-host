import type { EnrollmentPublicView } from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createHelpTooltip } from "./preference-ui.js";
import type { RendererEnrollmentClient } from "../renderer-enrollment-client.js";
import { RendererEnrollmentUnavailableError } from "../renderer-enrollment-client.js";

export type { RendererEnrollmentClient } from "../renderer-enrollment-client.js";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof RendererEnrollmentUnavailableError) return fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatExpiry(view: EnrollmentPublicView, messages: RendererSettingsMessages): string {
  if (view.pairing === "machine") return messages.enrollment.untilRevoked;
  const parsed = Date.parse(view.expiresAt);
  if (!Number.isFinite(parsed)) return view.expiresAt;
  return new Date(parsed).toLocaleString(messages.locale);
}

function formatAllowlist(view: EnrollmentPublicView): string {
  if (view.allowlist.length === 0) return "—";
  return view.allowlist.map((entry) => `${entry.threadId}: ${entry.verbs.join(", ")}`).join("; ");
}

export function createEnrollmentSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererEnrollmentClient | null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "enrollment",
    label: messages.pageLabels.enrollment,
    icon: "enrollment",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const copy = messages.enrollment;
      const header = document.createElement("div");
      header.className = "settings-enrollment-header";
      const copyBlock = document.createElement("div");
      copyBlock.className = "settings-enrollment-copy";
      const title = document.createElement("div");
      title.className = "settings-enrollment-title";
      const heading = document.createElement("h1");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.enrollment;
      title.append(heading, createHelpTooltip(document, copy.helpLabel, copy.help));
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = copy.description;
      copyBlock.append(title, description);
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "settings-icon-button";
      refresh.title = copy.refresh;
      refresh.setAttribute("aria-label", copy.refresh);
      refresh.append(createRendererSettingsIcon("refresh", 16));
      header.append(copyBlock, refresh);

      const status = document.createElement("p");
      status.className = "settings-enrollment-status";
      status.setAttribute("aria-live", "polite");
      const setStatus = (message: string, kind: "idle" | "error"): void => {
        status.className =
          kind === "error" ? "settings-enrollment-status is-error" : "settings-enrollment-status";
        status.textContent = message;
      };

      const tableWrap = document.createElement("div");
      tableWrap.className = "settings-enrollment-table-wrap";
      const table = document.createElement("table");
      table.className = "settings-enrollment-table";
      table.setAttribute("aria-label", messages.pageLabels.enrollment);
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const label of copy.columns) {
        const cell = document.createElement("th");
        cell.textContent = label;
        headerRow.append(cell);
      }
      thead.append(headerRow);
      const tbody = document.createElement("tbody");
      table.append(thead, tbody);
      tableWrap.append(table);

      context.content.append(header, status, tableWrap);

      const client = getClient();
      const renderEmpty = (message: string): void => {
        tbody.replaceChildren();
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.setAttribute("colspan", String(copy.columns.length));
        cell.className = "settings-enrollment-empty";
        cell.textContent = message;
        row.append(cell);
        tbody.append(row);
      };

      const renderRows = (enrollments: readonly EnrollmentPublicView[]): void => {
        tbody.replaceChildren();
        if (enrollments.length === 0) {
          renderEmpty(copy.empty);
          return;
        }
        for (const enrollment of enrollments) {
          const row = document.createElement("tr");
          row.className = "settings-enrollment-row";
          const clientCell = document.createElement("td");
          const clientId = document.createElement("strong");
          clientId.textContent = enrollment.clientId;
          const executable = document.createElement("div");
          executable.className = "settings-enrollment-executable";
          executable.textContent = enrollment.executablePath;
          clientCell.append(clientId, executable);

          const pairing = document.createElement("td");
          pairing.textContent =
            enrollment.pairing === "machine" ? copy.pairingMachine : copy.pairingSession;

          const expiry = document.createElement("td");
          expiry.textContent = formatExpiry(enrollment, messages);

          const allowlist = document.createElement("td");
          allowlist.className = "settings-enrollment-allowlist";
          allowlist.textContent = formatAllowlist(enrollment);

          const actions = document.createElement("td");
          actions.className = "settings-enrollment-actions";
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.className = "settings-command-button settings-command-button--secondary";
          revoke.dataset.enrollmentId = enrollment.enrollmentId;
          revoke.setAttribute("aria-label", `${copy.revoke} ${enrollment.clientId}`);
          const revokeLabel = document.createElement("span");
          revokeLabel.textContent = copy.revoke;
          revoke.append(createRendererSettingsIcon("trash", 14), revokeLabel);
          revoke.addEventListener("click", () => {
            if (!client || revoke.disabled) return;
            if (revoke.dataset.armed !== "true") {
              revoke.dataset.armed = "true";
              revokeLabel.textContent = copy.confirmRevoke;
              return;
            }
            revoke.disabled = true;
            revokeLabel.textContent = copy.revoking;
            void context.runLatest(
              () =>
                client
                  .revokeEnrollment(enrollment.enrollmentId)
                  .then(() => client.listEnrollments()),
              {
                success(result) {
                  setStatus("", "idle");
                  renderRows(result.enrollments);
                },
                failure(error) {
                  revoke.disabled = false;
                  revoke.dataset.armed = "true";
                  revokeLabel.textContent = copy.confirmRevoke;
                  setStatus(errorMessage(error, copy.failed), "error");
                },
              },
            );
          });
          actions.append(revoke);
          row.append(clientCell, pairing, expiry, allowlist, actions);
          tbody.append(row);
        }
      };

      const load = (): void => {
        if (!client) {
          renderEmpty(copy.unavailable);
          return;
        }
        setStatus(copy.loading, "idle");
        void context.runLatest(() => client.listEnrollments(), {
          success(result) {
            setStatus("", "idle");
            renderRows(result.enrollments);
          },
          failure(error) {
            setStatus("", "idle");
            renderEmpty(
              error instanceof RendererEnrollmentUnavailableError
                ? copy.unavailable
                : errorMessage(error, copy.failed),
            );
          },
        });
      };

      refresh.addEventListener("click", load);
      load();
      return undefined;
    },
  });
}
