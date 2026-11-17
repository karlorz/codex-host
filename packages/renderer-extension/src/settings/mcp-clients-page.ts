import type {
  ExternalClientAccess,
  ExternalClientConnectionMode,
  ExternalClientDispatchGrant,
  ExternalClientPublicView,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import { createHelpTooltip, preferenceId } from "./preference-ui.js";
import type { RendererExternalClientsClient } from "../renderer-external-clients-client.js";
import { RendererExternalClientsUnavailableError } from "../renderer-external-clients-client.js";

export type { RendererExternalClientsClient } from "../renderer-external-clients-client.js";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof RendererExternalClientsUnavailableError) return fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

function accessLabel(
  view: ExternalClientPublicView,
  copy: RendererSettingsMessages["mcpClients"],
): string {
  if (view.access === "selected-workspaces") {
    return `${copy.accessSelected}: ${view.workspaces.join(", ") || "—"}`;
  }
  return copy.accessAll;
}

function connectionLabel(
  mode: ExternalClientConnectionMode,
  copy: RendererSettingsMessages["mcpClients"],
): string {
  if (mode === "local") return copy.connectionLocal;
  if (mode === "direct") return copy.connectionDirect;
  return copy.connectionPublic;
}

function grantLabel(
  grant: ExternalClientDispatchGrant,
  copy: RendererSettingsMessages["mcpClients"],
): string {
  return grant === "full-dispatch" ? copy.grantFull : copy.grantLegacy;
}

function option(document: Document, label: string, value: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node as HTMLOptionElement;
}

function labeledField(
  document: Document,
  input: {
    label: string;
    control: HTMLElement;
    hint?: string;
    wide?: boolean;
  },
): HTMLElement {
  const field = document.createElement("div");
  field.className = input.wide
    ? "settings-mcp-clients-field settings-mcp-clients-field--wide"
    : "settings-mcp-clients-field";
  const controlId = input.control.id || preferenceId("mcp-client");
  input.control.id = controlId;
  const label = document.createElement("label");
  label.htmlFor = controlId;
  label.textContent = input.label;
  field.append(label, input.control);
  if (input.hint) {
    const hint = document.createElement("p");
    hint.className = "settings-mcp-clients-hint";
    hint.id = preferenceId("mcp-client-hint");
    hint.textContent = input.hint;
    input.control.setAttribute("aria-describedby", hint.id);
    field.append(hint);
  }
  return field;
}

export function createMcpClientsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererExternalClientsClient | null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "mcp-clients",
    label: messages.pageLabels["mcp-clients"],
    icon: "mcp-clients",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const copy = messages.mcpClients;
      const header = document.createElement("div");
      header.className = "settings-enrollment-header";
      const copyBlock = document.createElement("div");
      copyBlock.className = "settings-enrollment-copy";
      const title = document.createElement("div");
      title.className = "settings-enrollment-title";
      const heading = document.createElement("h1");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels["mcp-clients"];
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

      const form = document.createElement("form");
      form.className = "settings-mcp-clients-form";
      form.setAttribute("aria-label", copy.add);
      const nameInput = document.createElement("input") as HTMLInputElement;
      nameInput.type = "text";
      nameInput.required = true;
      nameInput.autocomplete = "off";
      nameInput.placeholder = copy.name;
      nameInput.setAttribute("aria-label", copy.name);
      const accessSelect = document.createElement("select");
      accessSelect.setAttribute("aria-label", copy.access);
      accessSelect.append(
        option(document, copy.accessAll, "all-threads"),
        option(document, copy.accessSelected, "selected-workspaces"),
      );
      const workspaces = document.createElement("textarea");
      workspaces.rows = 3;
      workspaces.setAttribute("aria-label", copy.workspaces);
      const connectionSelect = document.createElement("select");
      connectionSelect.setAttribute("aria-label", copy.connection);
      connectionSelect.append(
        option(document, copy.connectionPublic, "public-relay"),
        option(document, copy.connectionLocal, "local"),
        option(document, copy.connectionDirect, "direct"),
      );
      const grantSelect = document.createElement("select");
      grantSelect.setAttribute("aria-label", copy.grant);
      grantSelect.append(
        option(document, copy.grantFull, "full-dispatch"),
        option(document, copy.grantLegacy, "legacy-four"),
      );
      const directUrlInput = document.createElement("input") as HTMLInputElement;
      directUrlInput.type = "url";
      directUrlInput.setAttribute("aria-label", copy.directUrl);
      const oauthInput = document.createElement("input") as HTMLInputElement;
      oauthInput.type = "text";
      oauthInput.autocomplete = "off";
      oauthInput.setAttribute("aria-label", copy.oauthClientId);
      const add = document.createElement("button");
      add.type = "submit";
      add.className = "settings-command-button";
      add.textContent = copy.add;
      const workspacesField = labeledField(document, {
        label: copy.workspaces,
        control: workspaces,
        hint: copy.workspacesHint,
        wide: true,
      });
      const directUrlField = labeledField(document, {
        label: copy.directUrl,
        control: directUrlInput,
        hint: copy.directUrlHint,
        wide: true,
      });
      const actions = document.createElement("div");
      actions.className = "settings-mcp-clients-actions";
      actions.append(add);
      const syncOptionalFields = (): void => {
        workspacesField.hidden = accessSelect.value !== "selected-workspaces";
        directUrlField.hidden = connectionSelect.value !== "direct";
      };
      accessSelect.addEventListener("change", syncOptionalFields);
      connectionSelect.addEventListener("change", syncOptionalFields);
      syncOptionalFields();
      form.append(
        labeledField(document, { label: copy.name, control: nameInput }),
        labeledField(document, { label: copy.access, control: accessSelect }),
        workspacesField,
        labeledField(document, { label: copy.connection, control: connectionSelect }),
        labeledField(document, { label: copy.grant, control: grantSelect }),
        directUrlField,
        labeledField(document, { label: copy.oauthClientId, control: oauthInput }),
        actions,
      );

      const tableWrap = document.createElement("div");
      tableWrap.className = "settings-enrollment-table-wrap";
      const table = document.createElement("table");
      table.className = "settings-enrollment-table";
      table.setAttribute("aria-label", messages.pageLabels["mcp-clients"]);
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
      context.content.append(header, status, form, tableWrap);

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

      const copyUrl = async (url: string | undefined): Promise<void> => {
        if (!url) return;
        try {
          await navigator.clipboard.writeText(url);
          setStatus(copy.copied, "idle");
        } catch {
          setStatus(copy.failed, "error");
        }
      };

      const renderRows = (clients: readonly ExternalClientPublicView[]): void => {
        tbody.replaceChildren();
        if (clients.length === 0) {
          renderEmpty(copy.empty);
          return;
        }
        for (const view of clients) {
          const row = document.createElement("tr");
          row.className = "settings-enrollment-row";
          const nameCell = document.createElement("td");
          const strong = document.createElement("strong");
          strong.textContent = view.name;
          nameCell.append(strong);
          const accessCell = document.createElement("td");
          accessCell.textContent = accessLabel(view, copy);
          const connectionCell = document.createElement("td");
          connectionCell.textContent = connectionLabel(view.connectionMode, copy);
          const grantCell = document.createElement("td");
          grantCell.textContent = grantLabel(view.dispatchGrant, copy);
          const urlCell = document.createElement("td");
          urlCell.textContent = view.mcpUrl ?? view.mcpUrlNote ?? "—";
          const actions = document.createElement("td");
          actions.className = "settings-enrollment-actions";
          if (view.mcpUrl) {
            const copyButton = document.createElement("button");
            copyButton.type = "button";
            copyButton.className = "settings-command-button settings-command-button--secondary";
            copyButton.textContent = copy.copyUrl;
            copyButton.addEventListener("click", () => void copyUrl(view.mcpUrl));
            actions.append(copyButton);
          }
          const full = document.createElement("button");
          full.type = "button";
          full.className = "settings-command-button settings-command-button--secondary";
          full.textContent = copy.grantFull;
          full.disabled = view.dispatchGrant === "full-dispatch" || !client;
          full.addEventListener("click", () => {
            if (!client) return;
            full.disabled = true;
            void context.runLatest(
              () =>
                client
                  .updateClient({ name: view.name, dispatchGrant: "full-dispatch" })
                  .then(() => client.listClients()),
              {
                success(result) {
                  setStatus("", "idle");
                  renderRows(result.clients);
                },
                failure(error) {
                  full.disabled = false;
                  setStatus(errorMessage(error, copy.failed), "error");
                },
              },
            );
          });
          const revoke = document.createElement("button");
          revoke.type = "button";
          revoke.className = "settings-command-button settings-command-button--secondary";
          revoke.setAttribute("aria-label", `${copy.revoke} ${view.name}`);
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
              () => client.revokeClient(view.name).then(() => client.listClients()),
              {
                success(result) {
                  setStatus("", "idle");
                  renderRows(result.clients);
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
          actions.append(full, revoke);
          row.append(nameCell, accessCell, connectionCell, grantCell, urlCell, actions);
          tbody.append(row);
        }
      };

      const load = (): void => {
        if (!client) {
          renderEmpty(copy.unavailable);
          return;
        }
        setStatus(copy.loading, "idle");
        void context.runLatest(() => client.listClients(), {
          success(result) {
            setStatus("", "idle");
            renderRows(result.clients);
          },
          failure(error) {
            setStatus("", "idle");
            renderEmpty(
              error instanceof RendererExternalClientsUnavailableError
                ? copy.unavailable
                : errorMessage(error, copy.failed),
            );
          },
        });
      };

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!client || add.disabled) return;
        const name = nameInput.value.trim();
        const access = accessSelect.value as ExternalClientAccess;
        const connectionMode = connectionSelect.value as ExternalClientConnectionMode;
        const dispatchGrant = grantSelect.value as ExternalClientDispatchGrant;
        const roots = workspaces.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const directUrl = directUrlInput.value.trim();
        const oauthClientId = oauthInput.value.trim();
        add.disabled = true;
        add.textContent = copy.adding;
        void context.runLatest(
          () =>
            client
              .createClient({
                name,
                access,
                connectionMode,
                dispatchGrant,
                ...(access === "selected-workspaces" ? { workspaces: roots } : {}),
                ...(directUrl ? { directUrl } : {}),
                ...(oauthClientId ? { oauthClientId } : {}),
              })
              .then(async (created) => {
                const listed = await client.listClients();
                return { created, listed };
              }),
          {
            success({ created, listed }) {
              add.disabled = false;
              add.textContent = copy.add;
              nameInput.value = "";
              directUrlInput.value = "";
              oauthInput.value = "";
              renderRows(listed.clients);
              setStatus(
                created.token ? `${copy.tokenOnce} ${created.token}` : copy.connectOAuth,
                "idle",
              );
            },
            failure(error) {
              add.disabled = false;
              add.textContent = copy.add;
              setStatus(errorMessage(error, copy.failed), "error");
            },
          },
        );
      });

      refresh.addEventListener("click", load);
      load();
      return undefined;
    },
  });
}
