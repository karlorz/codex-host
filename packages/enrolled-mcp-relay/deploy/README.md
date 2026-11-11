# sg01 hop layout

`codexhost-relay.service` runs as user `codexhost-relay`. MCP is loopback `127.0.0.1:4400`; the tailnet link is `100.118.12.90:4401`. Caddy terminates `codexhost.karldigi.dev` with the Origin CA pair under `/etc/caddy/origin-ca/` and reverse-proxies to loopback. The wiki site stays a separate Caddy block.

`/etc/codexhost-relay` must be `750 root:codexhost-relay`. Hash files inside are mode `600` owned by `codexhost-relay`. A root-only directory makes `stat` fail under `ProtectSystem=strict` (`EACCES` on the hash files). OAuth state is `/var/lib/codexhost-relay`. Do not put the operator password or the raw link secret on sg01; only the scrypt password hash and the SHA-256 of the link secret.

Templates: `Caddyfile.site`, `codexhost-relay.service`. Sync hop `dist/` with `rsync --checksum`; size-only rsync can leave a stale `whois.js` on sg01.
