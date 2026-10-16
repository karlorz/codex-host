# Fork versioning (`karlorz/codex-host`)

This checkout tracks [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) as `upstream` and publishes only to the fork [karlorz/codex-host](https://github.com/karlorz/codex-host). It does not define upstream BytePioneer release policy.

## Tag rule

Fork versions stay on the **upstream version that is currently held**, plus a numeric fork counter.

| Upstream holds | First fork tag | Next fork tags |
| --- | --- | --- |
| `0.13.2` | `v0.13.2-0` | `v0.13.2-1`, `v0.13.2-2`, … |
| later `0.13.3` | `v0.13.3-0` | `v0.13.3-1`, … |

- Read upstream from `upstream/main` `package.json` and the upstream GitHub latest release. If they disagree, stop and report; do not guess.
- `n` is the next unused non-negative integer for that upstream version on the fork (`0` if none exist).
- Do **not** invent a newer minor or patch than upstream (for example `0.13.3-cpa.1` while upstream still holds `0.13.2`).
- `v0.13.2-0` is valid SemVer (prerelease `0` of `0.13.2`). Prepare it with `npm run release:prepare -- 0.13.2-0`.
- Numeric prerelease `0.13.2-0` compares **below** upstream `0.13.2`. The packaged updater still reads BytePioneer-AI `releases/latest`. A fork install may therefore offer that same-base upstream release as an update; accepting it replaces the fork (and drops the CPA live-voice hook). Keep the tag policy; decline that offer or reinstall the fork after an upstream bump.

The four prepared files (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`) must equal that version. Packaged `app/codexhost-distribution.json` is written later by `release:package` / `release:npm`, not by `release:prepare`. The Web console overview **codexhost 版本** reads that distribution file (installer/npm) or workspace `package.json` (source). After prepare, rebuild or recopy the installed `codexhost-distribution.json` so the live console matches the tag.

## Release channel on this fork

- Never `git push` to `upstream`.
- Keep GitHub Actions workflow `Release packages` **disabled** on `karlorz/codex-host` so a `v*` tag cannot npm-publish.
- Do not `npm publish` or dispatch release workflows from this fork.
- Do not move, delete, or re-push an existing tag (including historical `v0.13.3-cpa.1`).
- If a GitHub Release is created, it is a **prerelease and not latest**, from the existing annotated tag, with `-R karlorz/codex-host`. `gh release create --notes-from-tag` does not work with `--repo`; write the tag annotation to a notes file instead. A `gh` invocation without `-R` may resolve to BytePioneer and must abort.

## Next unused counter

```bash
git fetch upstream --tags --prune
git fetch origin --tags --prune
# example when upstream holds 0.13.2:
git ls-remote --tags origin 'refs/tags/v0.13.2-*'
```

Pick the smallest `n` that is not already a fork tag. Then `npm run release:prepare -- 0.13.2-<n>` on a branch, with the usual release-skill checks before any tag push.
