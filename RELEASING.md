# Release guide

GitHub Actions publishes this package when the version in `package.json` changes on `main`. The release workflow reads the package name and version from `package.json`, validates the package, publishes to npm, creates a matching `vX.Y.Z` tag, and creates a GitHub Release with generated notes and a link to the npm package.

The published version must be unique on npm.

## Why the first public version is 0.2.0

`0.2.0` is the initial release of the public npm package `pi-herdr-agents`.

- Repository tags `v0.1.0`–`v0.1.5` belong to inherited upstream history and are not present in this clean repository.
- Product work is already on the 0.2 feature line (async subagents, approved review workflows, bundled orchestration skill).
- Starting the new package name at `0.1.0` would understate that feature line; reusing `0.1.x` would collide with inherited numbering.

Do not design a release that creates a GitHub Release without a successful npm publish for a new version. The workflow publishes first, then tags and creates the GitHub Release.

## Prerequisites

You need:

- Permission to manage this repository's GitHub Actions settings and npm package access for `pi-herdr-agents`
- A clean local `main` branch

Automated release gates (run by the workflow and required locally):

```bash
npm ci
npm run lint
npm test
npm pack --dry-run
```

Manual deterministic Herdr integration (required before you push a release commit; not run in GitHub Actions):

```bash
npm run test:integration
```

Run that suite from inside Herdr. It uses real Pi and Herdr processes with the local deterministic provider, so it needs no provider credentials or network access.

The optional live-provider smoke test is not a release gate:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 npm run test:integration:live
```

Do not release from skipped Herdr tests. Confirm the package preview includes `README.md`, `AGENTS.md`, `docs/`, `agents/`, `skills/orchestrate/SKILL.md`, and `pi-extension/subagents/workflow-worker.js`. Confirm it excludes plans, journals, sessions, prototypes, generated evidence, and local `config.json`, and that the worktree integration tests leave no test workspace behind.

## npm authentication

### Steady state: trusted publishing (tokenless)

After the package exists on npm, steady-state releases use npm trusted publishing (OIDC). No long-lived `NPM_TOKEN` is required.

1. Open the package settings for `pi-herdr-agents` on [npmjs.com](https://www.npmjs.com/).
2. Add a trusted publisher for GitHub Actions with:
   - Organization or user: `giuseppecrj`
   - Repository: `pi-herdr-agents`
   - Workflow filename: `publish.yml`
   - Allowed action: `npm publish`
3. Confirm the release job has `permissions.id-token: write` and runs on a GitHub-hosted runner (already set in `.github/workflows/publish.yml`).
4. Confirm the workflow uses Node `>=22.14` and npm `>=11.5.1` (the workflow installs that npm floor).
5. Publish stays tokenless: `npm publish --access public --provenance`.

When the repository secret `NPM_TOKEN` is absent, the publish step unsets `NODE_AUTH_TOKEN` and relies on OIDC. Once the package exists, the workflow fails if `NPM_TOKEN` is still configured, so steady-state releases cannot silently keep using the bootstrap credential.

### First-package bootstrap

Trusted publishers are configured on an existing npm package. The first publish of `pi-herdr-agents` therefore needs a short-lived granular npm token once, and must go through the Actions workflow so provenance is GitHub-backed:

1. Create a granular access token on npm with permission to publish a new package (allow automated publishing / bypass 2FA if npm requires it for CI).
2. Add it temporarily as a GitHub Actions repository secret named `NPM_TOKEN`.
3. The first push that creates `main` does not release: `github.event.before` is all zeroes, so the workflow sets `release=false` and prints a clear message. After the temporary secret is configured, run **Actions → Release → Run workflow** (`workflow_dispatch`) from the `main` branch to publish `pi-herdr-agents@0.2.0`; other refs are rejected.
4. When the package does not exist, the publish step requires the temporary `NPM_TOKEN` as `NODE_AUTH_TOKEN`. Once any version exists, the workflow rejects that token and requires OIDC trusted publishing.
5. Configure the trusted publisher as above (`giuseppecrj` / `pi-herdr-agents` / `publish.yml`).
6. Immediately revoke or delete the granular token on npm and remove the temporary `NPM_TOKEN` repository secret.

Do not publish the first version with a local `npm publish`. Local publish does not create the same GitHub Actions provenance the workflow expects, and it skips the workflow's tag/release path. Always bootstrap through Actions.

Later version bumps use trusted publishing only. A leftover bootstrap secret blocks publication until it is removed.

## Publish a release

Choose the semantic version increment:

- `patch`: compatible bug fixes, such as `0.2.0` to `0.2.1`
- `minor`: compatible features, such as `0.2.0` to `0.3.0`
- `major`: breaking changes, such as `0.2.0` to `1.0.0`

Create the version commit without a local tag:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v$(node -p \"require('./package.json').version\")"
git push origin main
```

Replace `patch` with `minor` or `major` when appropriate. The push triggers the **Release** workflow, which installs dependencies, runs lint and unit tests, previews package contents, publishes to npm with provenance, creates and pushes the version tag, and creates the GitHub Release.

You can rerun a failed or incomplete release from **Actions → Release → Run workflow**. If npm already has `PACKAGE_NAME@VERSION`, the workflow reads that version's `gitHead` and continues only when it matches `GITHUB_SHA` (exact-commit retry). A foreign publish fails before tag or GitHub Release creation. Existing tags are verified to point at the release commit. The workflow does not create a GitHub Release for a version that still needs publish and failed to publish.

## Verify the release

After the workflow succeeds, inspect the published package:

```bash
npm view pi-herdr-agents
```

Test installation through Pi:

```bash
pi install npm:pi-herdr-agents
```

The package should appear at <https://pi.dev/packages/pi-herdr-agents> after the gallery indexes the npm release.

## Troubleshooting

### Tag points to another commit

The workflow stops if the matching version tag already points to a different commit. Do not move or reuse release tags. Increment the package version and push a new release commit instead.

### npm rejects authentication

Confirm that the trusted publisher matches owner `giuseppecrj`, repository `pi-herdr-agents`, and workflow `publish.yml`, that the job has `id-token: write`, and that the runner is GitHub-hosted. For the one-time bootstrap only, confirm the temporary granular token still has publish rights and has not expired. If an existing package release reports that `NPM_TOKEN` is bootstrap-only, remove the secret and use the trusted publisher.

### npm reports that the version already exists

If the published `gitHead` does not match this commit, the workflow fails before tagging. npm versions are immutable: increment the package version and push a new release commit. If it is a retry of the exact same commit, the workflow skips publish and continues with tag/release.

### Initial branch creation did not release

A clean repository's first push has `github.event.before` all zeroes. The workflow treats that as `release=false`. Configure the temporary `NPM_TOKEN` if needed, then bootstrap with `workflow_dispatch`.

### The package is absent from pi.dev

Confirm that npm published the package publicly and that `package.json` contains the `pi-package` keyword. Gallery indexing may take some time.
