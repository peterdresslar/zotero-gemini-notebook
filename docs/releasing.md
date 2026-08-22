# Stable Release Checklist

The Zotero plugin and Chrome companion are released together. Only the Zotero
`.xpi` uses the automatic updater.

Two GitHub releases have distinct jobs:

- A versioned release such as `v0.3.3` holds the installable `.xpi`, Chrome
  extension `.zip`, and a version-specific `update.json` snapshot for that exact
  XPI.
- The prerelease tagged `release` provides Zotero's permanent stable updater
  URL. It contains the active `update.json` and one rolling
  `update.backup.json` for immediate rollback.

The project does not currently publish a beta channel. The build keeps only the
manifest selected by the package version, so a stable build contains
`update.json` but not scaffold's duplicate `update-beta.json`.

The Zotero add-on ID is permanently
`zotero-notebooklm@peterdresslar.com`. Renaming it would create a different
plugin and strand existing installations.

Published `v0.2.0` installations contain an updater URL under the former
`peterdresslar/zotero-notebooklm` repository name. GitHub's repository-rename
redirect keeps those installations connected to the current `update.json`.
Never recreate a different repository at the old name, and retain the automated
legacy-URL check.

## 1. Prepare the Release PR

1. Create a release-preparation branch from current `main`.
2. Update the version in both `package.json` and
   `chrome-extension/manifest.json`. Update
   `companionCompatibility.validVersions` in `package.json`; retain an older
   companion only when its endpoint and browser behavior remain compatible.
   The allowlist is directional: retaining the immediately previous companion
   lets the Zotero plugin update first, while excluding an older companion when
   it lacks required browser permissions or transport behavior.
3. Update release-facing documentation and add
   `docs/releases/v<version>.md`.
4. Confirm that `addon/manifest.json` reflects the Zotero versions actually
   tested. Zotero recommends limiting `strict_max_version` to the latest minor
   version tested.
5. Build and validate the release artifacts:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run package:release
   pnpm run lint:check
   ```

   `package:release` checks the paired versions, stable add-on identity,
   repository and update URLs, compatibility ranges, archive contents, and the
   XPI hash declared by `update.json`.

6. Manually test the behavior changed by the release. Use the broader gates in
   [Risk-based manual testing](#risk-based-manual-testing) only when relevant.
7. Open and squash-merge the PR after CI and the applicable manual test pass.

## 2. Rebuild From Clean `main`

After merging the release-preparation PR:

```bash
git switch main
git pull --ff-only
git status --short
pnpm install --frozen-lockfile
pnpm run package:release
pnpm run lint:check
```

Stop if the worktree is not clean or validation fails. Release only artifacts
from this clean build.

## 3. Publish Versioned Assets Without Enabling Updates

Set the release version once for the commands below:

```bash
RELEASE_VERSION=0.3.3
```

Create and push an annotated tag for the exact merged commit:

```bash
git tag -a "v${RELEASE_VERSION}" -m "Release v${RELEASE_VERSION}"
git push origin "v${RELEASE_VERSION}"
```

Create the versioned release without marking it latest:

```bash
gh release create "v${RELEASE_VERSION}" \
  .scaffold/build/zotero-gemini-notebook.xpi \
  .scaffold/build/zotero-gemini-notebook-chrome-extension.zip \
  .scaffold/build/update.json \
  --repo peterdresslar/zotero-gemini-notebook \
  --verify-tag \
  --draft \
  --latest=false \
  --title "Zotero Gemini Notebook v${RELEASE_VERSION}" \
  --notes-file "docs/releases/v${RELEASE_VERSION}.md"
```

Review the tag, notes, and these three filenames before publishing:

```text
zotero-gemini-notebook.xpi
zotero-gemini-notebook-chrome-extension.zip
update.json
```

Then publish without changing the Latest release:

```bash
gh release edit "v${RELEASE_VERSION}" \
  --repo peterdresslar/zotero-gemini-notebook \
  --draft=false \
  --latest=false
```

The versioned manifest is not Zotero's live endpoint. It is the exact,
anonymously downloadable candidate used for promotion and later auditing.
Validate it before touching the stable updater:

```bash
pnpm run release:verify-published \
  --manifest-url "https://github.com/peterdresslar/zotero-gemini-notebook/releases/download/v${RELEASE_VERSION}/update.json"
```

Install or exercise the public packages only to the extent required by the
release's changed behavior. Do not announce the release yet.

## 4. Promote the Stable Updater

Set the version currently served by the stable updater:

```bash
PREVIOUS_VERSION=0.3.2
```

Run its read-only preflight, then the checked-in promoter:

```bash
pnpm run release:promote --from-version "${PREVIOUS_VERSION}" --dry-run
pnpm run release:promote --from-version "${PREVIOUS_VERSION}"
```

The command refuses an unexpected current version or a non-increasing target.
It compares GitHub's asset digests with the versioned manifests, so rerunning it
after an interrupted rename or stale CDN response resumes from the actual asset
state instead of overwriting the rollback copy. It then:

1. Validates the already-public versioned `update.json` and XPI anonymously.
2. Uploads and validates a temporary versioned candidate.
3. Renames the existing stable manifest to `update.backup.json`.
4. Renames the validated candidate to `update.json`.
5. Verifies the permanent stable and legacy-repository URLs, retrying briefly
   for GitHub's download cache.
6. Removes the retired beta manifest and older versioned backup assets only
   after stable verification passes.

After a normal successful promotion, the final `release` asset policy is one
active manifest and one rolling rollback manifest. Backups do not accumulate
across releases; a failed manifest is retained only when diagnosing a rollback.

Stop if promotion reports any failure. Do not announce or mark the version
Latest until this command succeeds. The command is resumable, so rerun the same
command after resolving a transient GitHub failure.

## 5. Risk-based Manual Testing

Do not repeat the full updater-migration exercise for every patch. Match manual
testing to what changed:

| Change                                                           | Additional manual gate                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Any release                                                      | Public manifest/XPI validation in the promotion command                                  |
| Zotero or Chrome runtime behavior                                | Smoke-test the affected workflow with the public package                                 |
| Gemini Notebook host, permission, or DOM automation              | Exercise the affected page and confirm sources actually appear                           |
| Chunking or transfer protocol                                    | Include a combined batch larger than Chrome's 64 MiB message limit                       |
| Add-on ID, updater URL, manifest format, or Zotero compatibility | Perform an actual previous-version Zotero update, restart, and preference-retention test |

For a routine patch with unchanged updater identity and compatibility, a prior
successful updater migration plus the automated public verification is enough.
Record any release-specific manual environment in the release notes.

## 6. Roll Back a Bad Manifest

If promotion completes its renames but stable verification or subsequent testing
finds a problem, `update.backup.json` contains the immediately previous stable
manifest. Inspect the assets first, then resolve their API endpoints:

```bash
stable_update_endpoint="$(gh release view release \
  --repo peterdresslar/zotero-gemini-notebook \
  --json assets \
  --jq '.assets[] | select(.name == "update.json") | .apiUrl | sub("^https://api.github.com/"; "")')"
backup_update_endpoint="$(gh release view release \
  --repo peterdresslar/zotero-gemini-notebook \
  --json assets \
  --jq '.assets[] | select(.name == "update.backup.json") | .apiUrl | sub("^https://api.github.com/"; "")')"
```

Stop unless each variable contains exactly one GitHub API endpoint. Preserve the
failed manifest and restore the rolling backup:

```bash
gh api --method PATCH "${stable_update_endpoint}" \
  -f "name=update-v${RELEASE_VERSION}.failed.json"
gh api --method PATCH "${backup_update_endpoint}" \
  -f name=update.json
pnpm run release:verify-published \
  --expected-version "${PREVIOUS_VERSION}"
```

If the second rename fails, immediately rename the preserved failed asset back
to `update.json` while investigating:

```bash
gh api --method PATCH "${stable_update_endpoint}" -f name=update.json
```

Never leave the permanent updater URL without an asset.

Restoring the previous manifest prevents additional automatic upgrades. It does
not downgrade users who already received the bad version; preserve the failed
release and prepare a higher-version fix.

## 7. Mark Latest and Announce

After promotion and the applicable manual gate succeed:

```bash
gh release edit "v${RELEASE_VERSION}" \
  --repo peterdresslar/zotero-gemini-notebook \
  --latest
```

Then announce the release and update any community-directory entry as needed.
Keep every versioned XPI available while an update manifest may refer to it.
