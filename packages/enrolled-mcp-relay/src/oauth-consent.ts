const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (ch) => ESCAPE[ch] ?? ch);
}

const HIDDEN_KEYS = [
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "response_type",
  "state",
  "scope",
  "resource",
] as const;

export function consentHtml(params: Record<string, string>, error?: string): string {
  const client = escapeHtml(params.client_name || "this client");
  const hiddens = HIDDEN_KEYS.flatMap((key) => {
    const value = params[key];
    return value ? [`<input type="hidden" name="${key}" value="${escapeHtml(value)}">`] : [];
  }).join("");
  const alert = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codexhost-relay consent</title>
</head>
<body>
<h1>codexhost-relay</h1>
<p>Allow ${client} to use a Host operational client on karlmac-mini. OAuth registration alone does not grant Host authority.</p>
${alert}
<form method="post" action="/authorize">
${hiddens}
<p><label>Operational client <input name="operational_client" value="muse" required autocomplete="off"></label></p>
<p><label><input type="checkbox" name="dispatch_grant" value="full-dispatch"> Allow full Host dispatch (delegate_start and thread listing)</label></p>
<p><label>Operator password <input type="password" name="password" required autocomplete="current-password"></label></p>
<p><button type="submit">Allow</button></p>
</form>
</body>
</html>`;
}
