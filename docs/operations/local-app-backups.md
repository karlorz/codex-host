# Local macOS app backups

Full app copies made during local build/install or repair work have count-based retention: keep the two newest receipt-confirmed rollback bundles. Agents must invoke cleanup as the final installation step under `AGENTS.md`; there is no background collector or automatic hook in `install:local`. The native updater separately removes its temporary swap backup on success; `npm run install:local` installs npm packages and does not create these app copies.

Store new app backups in `~/Library/Application Support/codexhost/app-backups/local-app-build-YYYYMMDDTHHMMSSZ/codexhost.app`. After the replacement is installed and its signature verifies, write the adjacent `install-receipt.json` with absolute `app` and `backup` paths and `full_local_build: true`. The target `app` must be `/Applications/codexhost.app`. Do not mark failed/unverified installations complete. Serialize local installations and their cleanup.

Finish each successful local app installation with:

```sh
npm run backups:gc
npm run backups:gc -- --apply
```

Preview lists the two retained bundles and older candidates. Eligibility relies on the completed-install receipt, rather than a fresh signature check of every backup. Apply verifies the installed app signature, rechecks each candidate receipt, and deletes only the older app directories. Receipts and other files in those directories remain. The command does not quit, restart or reload Desktop. Run with installations and other backup-directory mutations stopped; the GC lock does not coordinate an unrelated installer or defend against concurrent directory replacement by another process.

Discovery includes the managed backup root and historical `~/Downloads/codexhost-*/local-app-build-YYYYMMDDTHHMMSSZ/` directories. Only real directories with matching completed-install receipts are eligible; ordering uses the UTC slot timestamp, since copying an app can preserve its old modification time. Symlinked roots, slots, receipts and bundles are excluded. A lock serializes GC invocations; a lock left after a crash requires checking for an active owner before manual removal.

Native chat/session checkpoints, failed or incomplete installation recovery copies, unrelated app candidates, and unrecognized legacy names are excluded. Review those separately rather than broad deletion of `*.app`. An installation whose layout does not match this contract must add a verified supported layout or perform a narrowly scoped reviewed cleanup; a successful GC of recognized backups does not mean every historical app artifact was found.
