# Voice discovery

Maintainer analysis of an explicit Desktop voice candidate. It does not modify the installed official app, does not run during production startup, and never activates a profile.

```bash
npm run voice:discovery -- --inventory candidate.json
npm run voice:discovery -- --replay candidate.json --fingerprint <hex>
```

`candidate.json` may list `platform`, `desktopVersion`, `assets`, `moduleIds`, `sources` and optional `files` for source text. The command prints a candidate descriptor plus a fingerprint. Structural similarity is a candidate, not a connected-call guarantee.

Reusable interpretation lives in `@codexhost/renderer-extension/voice-discovery`. Source inventory helpers stay in this tool. Failed live module objects are not clean evidence. The command requires `packages/renderer-extension/dist/voice-discovery.js`; `npm run voice:discovery:test` fails if that build is missing. CI runs those tests after `npm run build:renderer` on Linux. That is structural/fixture coverage, not attended call qualification.

Pin drift alerts remain `npm run compat:daily`. Qualification evidence is separate (`@codexhost/renderer-extension/voice-evidence`).
