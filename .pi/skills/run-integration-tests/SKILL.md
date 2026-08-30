---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to run integration or e2e tests, test before release, or check everything works.
---

# Run integration tests

Run this workflow from inside herdr. This project supports no other terminal backend.

## Preflight

```bash
echo "HERDR_ENV=$HERDR_ENV"
command -v herdr
npm test
npm pack --dry-run
```

Stop and ask the user to start pi inside herdr if `HERDR_ENV` is not `1` or the CLI is missing.

## Integration suite

From the repository root, run the deterministic required suite:

```bash
npm run test:integration
```

The harness loads the extension directly from the working tree, creates isolated test agents, and routes every parent and child Pi session to a local scripted provider. The shipped runner starts a separate headless Herdr server with a private socket, config, state directory, and worktree directory. Normal completion and `SIGINT`/`SIGTERM`/`SIGHUP` use one idempotent shutdown: it confirms the child and server process groups have exited, escalates to `SIGKILL` after bounded grace, and removes owned paths only afterward. It clears inherited subagent and Herdr identity variables, so a missing endpoint cannot fall back to the persistent user server. It still exercises real Pi and Herdr lifecycle behavior without provider credentials, network calls, or model-output assertions. Concurrent runs use separate endpoints, so they do not need a manually coordinated shared Herdr slot.

For a focused run, pass the test file after `--`:

```bash
npm run test:integration -- test/integration/mux-surface.test.ts
```

Integration tests must own and tear down their Herdr workspaces, processes, temporary repositories, and worktrees, including on failure. Wait for observable journal, pane, process, file, or screen conditions. Do not use a fixed sleep to synchronize a transition; deliberate elapsed-time scenarios are the exception.

Use this optional live-provider smoke test only when checking provider compatibility:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 npm run test:integration:live
```

Report passing, failing, and skipped tests. Do not claim full verification when Herdr-dependent tests were skipped. For package changes, explicitly inspect the dry-run contents for `skills/orchestrate/SKILL.md` and `pi-extension/subagents/workflow-worker.js`, and confirm that plans, journals, sessions, prototypes, generated evidence, and local config are absent.

## Postflight

```bash
git status --short
```

The runner owns its private server and state directory, and removes them after the child test process exits. Confirm the runner reports no failure and that no `herdr server` child from the runner remains. Do not scan or remove global `pi-integ-*` paths: a concurrent foreign root is not this run's resource. If a failed run leaves an artifact, identify ownership from the runner's private socket/state path before removing it. Do not remove unrelated user workspaces, processes, files, or worktrees.
