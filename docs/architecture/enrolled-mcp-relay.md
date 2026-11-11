# Outbound enrolled MCP relay

This document is the contract for the outbound enrolled MCP relay. Mac `enroll relay-link` and the sg01 hop process (`@codexhost/enrolled-mcp-relay`) implement the four-tool tailnet slice, split listen (MCP loopback vs tailnet link), and public OAuth (401 with `resource_metadata`, DCR, PKCE S256, operator-password consent). Cloudflare Origin CA plus sg01 Caddy terminate `https://codexhost.karldigi.dev`; unauthenticated `POST /mcp` returns 401 with `resource_metadata`. Muse Settings Connected lists Codex Host for that URL; `tools/list` is the four tools. Current enrollment also remains local CLI plus optional Tailscale `enroll serve` ([client enrollment](client-enrollment.md)).

Attended product scope covers **this outbound shape only**: Mac `enroll relay-link` connects out over the tailnet; sg01 `codexhost-relay` terminates Muse OAuth; client `muse`; four tools. General Web/Relay, inbound Mac Runtime, Tailscale Funnel, a public `:4397`, cancel-through-relay, `delegate start`, and multi-client relay stay out of product scope.

The relay lets a Muse custom connector call Codex Host as enrolled collaborator `muse` without putting the enrollment token on a public hop and without opening an inbound route to Mac Runtime. Fail-closed enrolled send is unchanged: idle new-Turn start, or `THREAD_BUSY` (`authorized: true`, `notStarted: true`). No queue, steer, or cancel-to-clear-busy.

## Placement

| Piece | Home | Why |
| --- | --- | --- |
| Mac relay link CLI | `packages/host-runtime` next to `enroll serve` | Reads the local muse enrollment store, follows the live loopback bootstrap, and is the only process that holds the enrollment token |
| Link and MCP tool types that a browser or connector may see | `packages/shared-contracts` | Browser-safe public schemas; no Node or enrollment secrets |
| sg01 `codexhost-relay` | `@codexhost/enrolled-mcp-relay` at `packages/enrolled-mcp-relay` | Private workspace package. Workspace dependency is `@codexhost/shared-contracts` only. Must not import Host Runtime, Harness adapters, Desktop, `protocol-core`, `mapping-store`, or `harness-broker`. `tools/check-boundaries.mjs` applies. Third-party MCP and OAuth libraries are allowed. Excluded from the Desktop app payload and the npm `codexhost` tarball; deployed to sg01 on its own |
| Public HTTPS + OAuth | Hop process on loopback; Cloudflare (karldigi.dev account) → sg01 Caddy in front | RFC 9728 / RFC 8414 metadata, DCR, PKCE S256, operator-password consent (scrypt), resource-bound tokens. Hostname `codexhost.karldigi.dev`; issuer and resource distinct from SkillWiki and grok-search. Caddy and Origin CA are operator |

v1 serves one enrollment client: `muse`. Copying another client's store or handoff does not authorize this relay.

The hop is sg01 (`100.118.12.90` tailnet). The public hostname is `codexhost.karldigi.dev` (connector `https://codexhost.karldigi.dev/mcp`). DNS is operator-manual in the karldigi.dev Cloudflare account, not `termolo.com` (that zone is a different account and is used for cursor-box tunnels). The relay runs as its own system user, systemd unit, state directory, and Caddy site. It shares no secrets, ports, or OAuth issuer with `skillwiki-mcp`. If that co-tenancy is refused, the hop is kr01 or a dedicated VM. It is never the Mac.

## Topology

```
Muse connector
  HTTPS MCP + OAuth
        │
        ▼
Cloudflare (karldigi.dev) → sg01 Caddy → codexhost-relay (127.0.0.1)
  https://codexhost.karldigi.dev/mcp
                              ▲
                              │ tailnet link only
                              │
karlmac-mini  `codexhost enroll relay-link`
  muse store + outbound connect
        │ enrollment bearer, loopback only
        ▼
Codex Host Runtime  127.0.0.1:<bootstrap-port>
```

The Mac connects **out**. The hop must not accept a public inbound connection to the link listener. The enrollment token never leaves the Mac. Muse holds a short-lived, resource-bound OAuth access token for the relay resource only.

## MCP tools

Streamable-HTTP MCP at `https://codexhost.karldigi.dev/mcp`. `tools/list` is exactly this set. There is no cancel, watch, list, `delegate`, or Harness tool.

Caller identity on every Runtime read/wait/send is the muse enrollment's own Thread. The Mac link sets `callerThreadId` to that Thread on `/v1/thread/read`, `/v1/thread/wait`, and `/v1/thread/send`. `hostId` is rejected on all three. Path 2 `enroll serve` stamps `callerThreadId` on read only and does not expose wait. Runtime remains the authorization authority; the tool set is defense in depth.

### `enroll_status`

Forwards to loopback `/v1/enroll/status` plus link liveness that only the Mac link can see.

Input schema:

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

Result (no token fields):

| Field | Source |
| --- | --- |
| `clientId` | Public enrollment view (`muse`) |
| `pairing` | Public enrollment view (`machine` or `session`) |
| `expiresAt` | Public enrollment view |
| `allowlist` | Public enrollment view (`threadId` + verbs) |
| `threadId` | Enrolled client's own Thread |
| `link` | `online` or `offline` |
| `runtime` | `reachable` or `unreachable` |

### `thread_read`

Forwards to `/v1/thread/read`.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "threadId": { "type": "string", "minLength": 1 },
    "view": { "type": "string", "enum": ["result", "messages"] },
    "cursor": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
  },
  "required": ["threadId"],
  "additionalProperties": false
}
```

| Argument | Rule |
| --- | --- |
| `threadId` | Required. Must be allowlisted for `read` (Runtime 403 `UNAUTHORIZED_TARGET` otherwise) |
| `view` | `result` (default) or `messages` |
| `cursor` | Messages view only |
| `limit` | Messages view only; same CLI caps (default 25, max 100) |
| `hostId` | Forbidden. Absent from the schema. Relay and Mac link reject it before upstream |

The Mac link overwrites any client-supplied `callerThreadId`.

### `thread_wait`

Forwards to `/v1/thread/wait`.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "threadId": { "type": "string", "minLength": 1 },
    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 25000 },
    "view": { "type": "string", "enum": ["result", "messages"] },
    "cursor": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
  },
  "required": ["threadId"],
  "additionalProperties": false
}
```

| Argument | Rule |
| --- | --- |
| `threadId` | Required; `read` grant |
| `timeoutMs` | Optional. Omitted → 25000. Max 25000. The client re-calls. Distinct from loopback CLI wait, whose default is 29 minutes |
| `view`, `cursor`, `limit` | Same as `thread_read` |
| `hostId` | Forbidden |

This route is not on Path 2 `enroll serve`. The Mac link still stamps `callerThreadId`.

`timedOut: true` is a running checkpoint. The child keeps running. The relay does not hold the wait across a dropped link. Muse tool-call timeout is unproven; 25 s stays under Cloudflare's 100-second proxy 524.

### `thread_send`

Forwards to `/v1/thread/send`.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "threadId": { "type": "string", "minLength": 1 },
    "message": { "type": "string", "minLength": 1, "maxLength": 2097152 }
  },
  "required": ["threadId", "message"],
  "additionalProperties": false
}
```

| Argument | Rule |
| --- | --- |
| `threadId` | Required; `send` grant |
| `message` | Required nonempty text; size cap 2 MiB to match Runtime control, tighter connector caps allowed |
| `hostId` | Forbidden |

The Mac link stamps `callerThreadId` on this route (Path 2 `enroll serve` does not).

Idle allowlisted target: HTTP 200 with the existing send result (`status: running` and Turn id). Busy target: `THREAD_BUSY` with `authorized: true` and `notStarted: true`. No new Turn. The relay does not retry, queue, steer, or cancel.

## Error codes

Existing Runtime codes pass through unchanged when the Mac link received a complete HTTP response:

| Code | Meaning |
| --- | --- |
| `THREAD_BUSY` | Allowlisted send reached Host; target already has an active Turn; `notStarted: true`; enrolled principal also gets `authorized: true` |
| `UNAUTHORIZED_TARGET` | Unknown Thread, missing verb, rejected `hostId`, or a route the relay does not expose |
| `ENROLLMENT_INVALID` | Missing/revoked/expired muse enrollment on the Mac, or a Mac-side token the Runtime rejects |
| `INVALID_ARGUMENT` | Bad JSON, oversized body, or out-of-range wait/limit |
| `RUNTIME_UNREACHABLE` | Loopback Runtime is down after the link is up |

Relay-owned outcomes. They are not stored as later work:

| Code / reason | When | Client action |
| --- | --- | --- |
| `RUNTIME_UNREACHABLE` reason `mac_link_offline` | No Mac link is connected, or the link failed before the Mac posted upstream | Retry later; nothing was started |
| `outcome_unknown` | Deadline hit or the link dropped **after** the Mac posted `/v1/thread/send` (or after a mutating wait is impossible; wait/read use this only if a response cannot be proven) | `thread_read` before any further send. The relay must not retry |

`mac_link_offline` returns within 2 seconds. The relay keeps no request body, no queue row, and no replay buffer after the call ends.

OAuth and MCP transport:

| HTTP | When |
| --- | --- |
| 401 with `resource_metadata` | Missing/wrong/expired OAuth access token, or a token whose audience is SkillWiki or grok-search |
| 401 | Revoked grant |

## Link protocol

The Mac CLI command is `codexhost enroll relay-link`. It is a foreground process, like `enroll serve`.

1. Load `$CODEXHOST_DATA_DIR/enroll/clients/muse.json` (mode 600). Fail closed on missing, wrong client, insecure mode, or expiry. Do not fall back to Host Runtime env.
2. Connect **out** over the tailnet to the hop's link listener (`100.118.12.90:<link-port>` when the hop is sg01). Bind nothing inbound on the Mac for this feature.
3. Authenticate the link with **both** checks below. Either failure closes the link. The hop stores only the link credential hash, never the enrollment token.
4. Accept framed requests from the relay: `{ requestId, deadlineMs, route, body }`.
5. Allowlisted routes only:

   - `/v1/enroll/status`
   - `/v1/thread/read`
   - `/v1/thread/wait`
   - `/v1/thread/send`

   `/v1/enroll/revoke` is not in this set (Path 2 `enroll serve` does expose it). Anything else is `UNAUTHORIZED_TARGET` without contacting Runtime.
6. Resolve the live loopback origin from the enroll bootstrap (same follow-the-new-port rule as `enroll serve`). POST with `Authorization: Bearer <muse enrollment token>`. Redirects disabled. Body cap 2 MiB. Upstream deadline 30 s, and never longer than `deadlineMs` from the relay.
7. Return `{ requestId, status, body }` or `{ requestId, error }`. If the upstream POST has started and the link or deadline fails before a complete response, the Mac reports `outcome_unknown` to the relay; the relay reports the same to Muse.

The hop uses two sockets. MCP (`--mcp-listen`, default `127.0.0.1`, port 4400) is loopback-only so Caddy is the public path. The link listener (`--link-listen`, default `100.118.12.90`, port 4401) binds only that tailnet IPv4. Loopback is allowed for both in tests. `--listen` is loopback-only and sets both addresses; a shared non-loopback listen is rejected. The link listener is not published on the public IP or hostname.

No-queue rule: a disconnected link drops in-flight frames. A later reconnect does not replay them. Muse re-issues `thread_read` / `thread_wait` / `thread_send`. Automatic retry of `thread_send` is forbidden in the relay and in the Mac link.

### Link authentication

Both of the following must succeed. Rotating the link secret does not rotate the muse enrollment.

| Check | Rule |
| --- | --- |
| Tailscale WhoIs | Hop asks local tailscaled over `/var/run/tailscale/tailscaled.sock` with HTTP Host `local-tailscaled.sock` (localhost is 403). Source must be karlmac-mini's **stable node ID**, not its CGNAT IPv4. The relay system user must call that local API without running as root |
| Link secret | Operator-generated. Mac CLI reads it from a mode-600 file (not Host Runtime env). Hop stores only a hash. Compare is fail-closed |

## OAuth

The hop serves public metadata and token endpoints on the MCP loopback server (the same process Caddy reverse-proxies):

- `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728)
- `GET /.well-known/oauth-authorization-server` (RFC 8414)
- `POST /register` (RFC 7591 DCR; https or loopback redirect URIs)
- `GET|POST /authorize` with operator-password consent (scrypt hash). Consent text names "muse enrollment on karlmac-mini"
- `POST /token` (authorization_code + PKCE S256, rotating refresh tokens, 1-hour access tokens)
- `POST /revoke` (RFC 7009). A revoked access token gets HTTP 401 without `resource_metadata`

Unauthenticated or wrong/expired/`aud` mismatch (including a SkillWiki or grok-search token this hop does not hold) on `/mcp` returns 401 with `WWW-Authenticate` `resource_metadata`. Tokens are bound to this relay's resource (`https://codexhost.karldigi.dev/mcp` in production). A token request whose `resource` is another service is `invalid_target`.

Production CLI requires `--public-origin`, `--password-hash-file` (mode 600 scrypt hash), and `--oauth-state-dir` when `--link-listen` is not loopback. `codexhost-relay hash-password` reads the operator password from stdin and writes the hash. Operator cutover uses `list-clients` and `revoke-client --client-id <id>` or `revoke-client --all` with `--oauth-state-dir` (JSON client ids and names only; no tokens). The running hop loads OAuth state at start, so file revoke takes effect on the next hop process start. Loopback-only `--listen 127.0.0.1` may omit OAuth for local tailnet-slice tests.

Issuer and resource are distinct from SkillWiki and grok-search. Revoking the grant on the hop cuts Muse off. Revoking the Mac enrollment cuts every tool (`ENROLLMENT_INVALID`). The hop holds no Host Runtime token and no enrollment token. Muse DCR for this hostname is unproven; SkillWiki and grok-search connectors on Muse are precedent only. First public Muse install is the live check.

## Public hostname

`https://codexhost.karldigi.dev/mcp`. The proxied A record exists (`codexhost` → `161.118.205.111`). Cloudflare Origin CA for this hostname is issued (SAN `codexhost.karldigi.dev` only; not the wiki cert). sg01 Caddy presents that certificate; Cloudflare Full (strict) TLS works. Unauthenticated `POST /mcp` returns 401 with `WWW-Authenticate` `resource_metadata`. `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server` return 200. `GET /health` returns `sg01-codexhost-ok`. The hop MCP listen is `127.0.0.1:4400`; the link listen is `100.118.12.90:4401`.

| Field | Value |
| --- | --- |
| Zone | `karldigi.dev` (NS `surina`/`alfred`) |
| Type | A |
| Name | `codexhost` |
| IPv4 | `161.118.205.111` |
| Proxy | Proxied |
| Access | Off |
| TLS | Full (strict) with a Cloudflare Origin CA whose SAN is `codexhost.karldigi.dev` |

Do not use `termolo.com` for this hop. Do not install `cloudflared` on sg01.

### Origin CA (this hostname only)

Cloudflare Origin CA for `codexhost.karldigi.dev` is issued in the **karldigi.dev** account (NS `surina`/`alfred`): `origin-rsa`, SAN that name only, valid through 2041-11-07. sg01 Caddy uses `/etc/caddy/origin-ca/codexhost.karldigi.dev.{crt,key}` (`root:caddy`, key mode 640), same layout as the wiki site. Access apps for the account are empty. SSL/TLS is Full (strict). DNS is the proxied A record above. The wiki certificate (SAN `wiki.karldigi.dev` only) is not used. Do not install `cloudflared`. Hop hashes live in `/etc/codexhost-relay` (directory `750 root:codexhost-relay`, files mode 600 owned by `codexhost-relay`). OAuth state is `/var/lib/codexhost-relay`. The systemd unit is `codexhost-relay.service`.

## Live path

The four-tool hop is deployed on sg01. Mac `enroll relay-link` connects out to `100.118.12.90:4401`. Hop MCP is loopback `127.0.0.1:4400`; Caddy is the public path. Public OAuth, Origin CA, and the Caddy site are in place. Fork prod `v0.17.4-6` is GitHub latest and npm `@karlorz/codexhost-cli@latest`. Next unused fork tag is `0.17.4-7`.

Muse adds the custom connector from a Muse chat (`custom-connector-setup`). Settings Connected then lists Codex Host for `https://codexhost.karldigi.dev/mcp`. A connected Muse chat sees `tools/list` of the four tools; `enroll_status` reports `clientId=muse`, `pairing=machine`, `link=online`, and `runtime=reachable` while the Mac link is up.

Live checks that stay true:

- Outbound-only Mac; enrollment token absent from hop state/env/logs (digest compare, true/false only).
- `mac_link_offline` with an empty relay store when the link is down.
- Desktop restart (Runtime port change) reconnects without hop config changes.
- Unauthenticated public `POST /mcp` is 401 with `resource_metadata`.
- Allowlisted `thread_read` and unauthorized UUID `UNAUTHORIZED_TARGET` from Muse.
- Idle `thread_send` starts a Turn. `--view messages` pages oldest-first (default 25, max 100); `nextCursor` reaches the user text for those Turns.
- Enrolled `THREAD_BUSY` on an already-running grok Thread returns `authorized`/`notStarted` and starts no Turn. Bounded `thread_wait` returns `timedOut` while that Turn is still running.
- Hop operator `list-clients` / `revoke-client` cut the Muse OAuth grant. File revoke plus one hop restart loads the revoked store. Unauthenticated `POST /mcp` stays 401 with `resource_metadata`; a revoked bearer is 401 without it. Mac enrollment is unchanged. Karl reconnects the Muse connector after cutover.

Open live checks:

- Mac `enroll revoke` stays planned-only, because it rotates the key.
- Annotated tag `v0.17.4-7` is held until Release Notes confirmation. GitHub latest would prompt Desktop; hop deploy does not require that tag.

## Product boundary

This file does not ship a public inbound Mac listener, a Tailscale Funnel, a public `:4397`, cancel-through-relay, enroll revoke through the relay, `delegate start`, multi-client tenancy, a Muse Harness plugin, or ChatGPT / `api.openai.com` conversation lookup.

Path 2 `enroll serve` stays the contract for real tailnet peers. Path 1 SkillWiki-as-bus stays a parked backup and is not this relay.
