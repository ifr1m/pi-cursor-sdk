# Crabbox Local Platform Testing Guide for pi Extensions

## Purpose

This is the reusable field guide for adding **local Crabbox platform testing** to pi extension repositories.

Current scope:

- pi extension packages only;
- local maintainer machine is macOS;
- required target matrix is macOS, Ubuntu Linux, and native Windows;
- Windows runs through the local Parallels template `pi-extension-windows-template` and snapshot `crabbox-ready` unless a project documents a different source of truth.

This guide is generic on purpose. Do not copy another project's model IDs, package names, API keys, VM clones, artifact folders, prompts, or release decisions. Copy the architecture and conventions, then make the target project own its config, docs, assertions, and release gate.

Official references:

- [Crabbox docs](https://crabbox.sh/)
- [openclaw/crabbox](https://github.com/openclaw/crabbox)
- Crabbox source docs worth reading before changing a harness: `docs/commands/run.md`, `docs/commands/warmup.md`, `docs/commands/stop.md`, `docs/features/doctor.md`, `docs/features/sync.md`, `docs/features/env-forwarding.md`, `docs/providers/ssh.md`, `docs/providers/local-container.md`, and `docs/providers/parallels.md`.

Local reference implementations reviewed for this guide:

- `~/Projects/AI/pi-cursor-sdk` — full provider/runtime gate with live model, visual TUI, JSONL, bridge, usage/cache, and abort-cleanup assertions.
- `~/Projects/AI/pi-oracle` — package/build platform gate plus project-specific real smoke, with a project-specific env prefix.
- `~/Projects/AI/pi-codex-goal` — compact reusable harness with platform build plus real pi runtime smoke on all targets.

## Standard local matrix

| Harness target | Crabbox provider | Local purpose | Shell contract | Default work root |
| --- | --- | --- | --- | --- |
| `macos` | `ssh` static localhost | Current host macOS | POSIX shell over SSH | `/Users/$USER/crabbox/<project>` |
| `ubuntu` | `local-container` | Linux smoke without cloud | POSIX shell in a Docker-compatible container | provider default `/work/crabbox` |
| `windows-native` | `parallels` | Real native Windows behavior | PowerShell/OpenSSH, `--windows-mode normal` | `C:\crabbox\<project>` |

Use this matrix by default for pi extensions. If a project does not need all three targets, that project's docs must say which target is non-required and why. A missing required target is a blocked local setup, not a skipped pass.

## What Crabbox owns vs. what the project owns

Crabbox owns the lease/sync/run loop:

1. lease or claim a target;
2. sync tracked plus nonignored local files;
3. run a command remotely;
4. stream output;
5. expose timing, logs, failure bundles, and cleanup commands;
6. stop or expire the lease.

The project owns the test contract:

- which targets and suites are required;
- target setup and runtime versions;
- package install semantics;
- pi commands and prompts;
- assertions over stdout, JSONL, visual evidence, artifacts, cleanup, and redaction;
- docs and release criteria.

Do not treat Crabbox as a runtime installer. If a target needs Node, npm, Git, `tar`, `rsync`, `zstd`, `ffmpeg`, a browser renderer, or another reusable tool, put that setup in the target image/template or in a documented project setup step.

## Recommended repository shape

Use names that fit the project, but keep this shape unless the project already has a better source of truth.

```text
platform-smoke.config.mjs
scripts/platform-smoke.mjs
scripts/platform-smoke/doctor.mjs
scripts/platform-smoke/crabbox-runner.mjs
scripts/platform-smoke/targets.mjs
scripts/platform-smoke/artifacts.mjs
scripts/platform-smoke/platform-build-windows.ps1
scripts/platform-smoke/<runtime-suite>.mjs        # optional real pi/model smoke
scripts/platform-smoke/pty-capture.mjs           # optional TUI/PTY suites
scripts/platform-smoke/render-ansi.mjs           # optional host-side visual renderer
docs/platform-smoke.md                           # project source of truth
```

Gitignored local state:

```text
.artifacts/
.crabbox/
.debug/
.platform-smoke-runs/
```

Package scripts:

```json
{
  "scripts": {
    "check:platform-smoke": "node --check scripts/platform-smoke.mjs && node --check scripts/platform-smoke/doctor.mjs && node --check scripts/platform-smoke/crabbox-runner.mjs && node --check scripts/platform-smoke/targets.mjs",
    "smoke:platform": "node scripts/platform-smoke.mjs",
    "smoke:platform:doctor": "node scripts/platform-smoke.mjs doctor",
    "smoke:platform:macos": "node scripts/platform-smoke.mjs run --target macos",
    "smoke:platform:ubuntu": "node scripts/platform-smoke.mjs run --target ubuntu",
    "smoke:platform:windows-native": "node scripts/platform-smoke.mjs run --target windows-native",
    "smoke:platform:all": "node scripts/platform-smoke.mjs run --target macos,ubuntu,windows-native"
  }
}
```

Add tests for cheap harness invariants: syntax, help text, target/suite validation, package-file inclusion or exclusion, packed-install command rendering, artifact-manifest failure behavior, cleanup-failure behavior, path traversal rejection, and secret redaction.

## Host Crabbox install

Install the Crabbox CLI on the macOS host and keep the harness explicit about the binary it uses:

```sh
brew install openclaw/tap/crabbox
crabbox --version
crabbox providers
```

If Homebrew already has the OpenClaw tap configured, `brew install crabbox` may resolve to the same formula. Use `PLATFORM_SMOKE_CRABBOX=/path/to/crabbox` only when testing a non-default binary or a locally built Crabbox.

## Configuration conventions

Keep project-specific defaults in `platform-smoke.config.mjs`:

```js
export default {
  packageName: "pi-example-extension",
  artifactRoot: ".artifacts/platform-smoke",
  requiredTargets: ["macos", "ubuntu", "windows-native"],
  requiredSuites: ["platform-build"],
  requiredCrabbox: { minVersion: "0.24.0" },
  ubuntuContainerImage: "cimg/node:24.16",
  nodeValidationMajor: 24,
};
```

Use the config as the harness source of truth. Crabbox itself resolves config as `flags > env > repo .crabbox.yaml/crabbox.yaml > user config > defaults`; local smoke harnesses should still pass critical provider/work-root flags explicitly so the gate does not depend on hidden user config.

Environment conventions:

- Prefer defaults derived from `config.packageName` for project-specific work roots and slugs.
- Do not export project-specific work-root overrides globally.
- Use `PLATFORM_SMOKE_*` for reusable harness knobs when scripts are shared across projects.
- Use a project-specific prefix such as `PI_ORACLE_SMOKE_*` only when a repo needs to coexist with another harness or already has established project-specific environment names.
- Keep auth variable names in config, not auth values.

Useful standard variables:

```text
PLATFORM_SMOKE_CRABBOX=/opt/homebrew/bin/crabbox
PLATFORM_SMOKE_MAC_HOST=localhost
PLATFORM_SMOKE_MAC_USER=$USER
PLATFORM_SMOKE_MAC_WORK_ROOT=/Users/$USER/crabbox/<project>
PLATFORM_SMOKE_UBUNTU_IMAGE=cimg/node:24.16
PLATFORM_SMOKE_WINDOWS_VM=pi-extension-windows-template
PLATFORM_SMOKE_WINDOWS_SNAPSHOT=crabbox-ready
PLATFORM_SMOKE_WINDOWS_USER=<windows-ssh-user>
PLATFORM_SMOKE_WINDOWS_WORK_ROOT=C:\crabbox\<project>
```

Pin Crabbox deliberately. Exact pins are best for release-critical harnesses whose parsing depends on CLI output. Minimum version checks are fine for simpler gates. Current local baseline is Crabbox `0.24.0` or newer from the Homebrew package.

## Target setup best practices

### macOS: static SSH to the current host

Use the `ssh` provider for current macOS. It is a static provider: Crabbox does not create or clean up the host.

Required setup:

- macOS Remote Login enabled.
- Noninteractive SSH works: `ssh -o BatchMode=yes $USER@localhost 'whoami'`.
- Target user has a writable work root such as `/Users/$USER/crabbox/<project>`.
- `node`, `npm`, `git`, `rsync`, `tar`, and project-specific native tools are on the remote SSH path.

Base args:

```text
--provider ssh
--target macos
--static-host localhost
--static-user $USER
--static-port 22
--static-work-root /Users/$USER/crabbox/<project>
```

Notes:

- Static `stop` removes Crabbox's local claim only; it does not clean the Mac.
- Use `--reclaim` intentionally when multiple repos reuse localhost and a previous claim blocks the run.
- Because this is the real host, avoid tests that mutate global user state unless the project explicitly owns cleanup.

### Ubuntu: local-container provider

Use `local-container` for the Linux target. It runs through Docker Desktop, OrbStack, Colima, or another Docker-compatible runtime on the local machine. There is no broker or cloud dependency.

Required setup:

- `docker info` passes.
- The chosen image supports the project's Node/npm baseline or can bootstrap quickly.
- Default image for current pi extension smokes: `cimg/node:24.16`.

Base args:

```text
--provider local-container
--target linux
--local-container-image cimg/node:24.16
```

Notes:

- Use a prebuilt image when first-start package bootstrapping becomes a bottleneck.
- Do not mount the host Docker socket unless the suite actually needs nested Docker; that grants the container access to the host daemon.
- Treat container cache volumes as local mutable state. Name them per project and clean obsolete keys manually.

### Windows: Parallels native Windows template

Use the `parallels` provider for native Windows. The default reusable template is:

```text
source VM: pi-extension-windows-template
snapshot:  crabbox-ready
mode:      windows normal
```

Base args:

```text
--provider parallels
--target windows
--windows-mode normal
--parallels-source pi-extension-windows-template
--parallels-source-snapshot crabbox-ready
--parallels-user <windows-ssh-user>
--parallels-work-root C:\crabbox\<project>
```

Template requirements:

- Parallels Tools installed.
- A stable SSH user.
- OpenSSH Server enabled and reachable on port `22`.
- PowerShell available.
- Git for Windows installed.
- `tar` available for archive sync.
- Node/npm at the project validation baseline.
- Writable `C:\crabbox` work root.
- The source VM is not used as a normal work machine.
- `crabbox-ready` is a known-good power-off snapshot. Linked clones depend on that snapshot, so do not delete or replace it casually.

PowerShell rules:

- Use a checked-in `.ps1` script for long Windows suites.
- Run with `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\platform-smoke\platform-build-windows.ps1`.
- Avoid one giant quoted `--shell` string for Windows unless it is a small probe.
- If installing Git or tools changes PATH, restart `sshd` or validate in a fresh SSH session.

### Windows template image policy

Agents should reuse `pi-extension-windows-template` instead of creating one-off Windows VMs for each project.

Add a tool to the template when all are true:

- more than one pi extension is likely to need it;
- installing it every run is slow, flaky, or network-dependent;
- it is safe to have globally on Windows test machines;
- it has no project secrets, local user auth, or repo-specific config.

Keep project-specific tools in repo scripts when they are truly one-off.

Template update runbook:

1. Prefer updating `pi-extension-windows-template` over adding per-project/per-run installers when a tool is reusable across pi extensions.
2. Boot the source VM, not a Crabbox clone.
3. Install or update the globally useful tool.
4. Verify from a fresh SSH session: `node --version`, `npm --version`, `git --version`, `tar --version`, and the new tool's `--version` or equivalent.
5. Remove caches, downloads, auth files, local checkouts, `.pi` state, `.artifacts`, `.debug`, and secrets.
6. Shut down the VM cleanly.
7. Create a new known-good power-off snapshot. Prefer a dated snapshot for trial adoption; promote it to `crabbox-ready` only after at least one project passes the Windows smoke.
8. Update project docs/config if the snapshot name changes.
9. Stop or clean stale clones after the template update so future runs do not reuse pre-update state.

Never bake API keys, browser sessions, user project checkouts, generated artifacts, or repo-specific `.env` files into the template.

## Doctor is mandatory

`npm run smoke:platform:doctor` should fail before any expensive, token-spending, or long-running suite starts. The release entrypoint should enforce this, either by making `smoke:platform:all` run doctor first or by making the canonical release command run `smoke:platform:doctor && smoke:platform:all`.

Doctor should check:

- Crabbox binary path and version/minimum version.
- `crabbox providers` includes `ssh`, `local-container`, and `parallels`.
- `crabbox doctor --provider local-container --json` passes for the configured image.
- `crabbox doctor --provider ssh --target macos --json` passes or reports a concrete host setup failure.
- Docker is running for Ubuntu.
- macOS SSH probe reaches the host and sees Node/npm/Git.
- `prlctl` exists.
- The Windows source VM and snapshot exist.
- The Windows snapshot is forkable/power-off; if the template has no live IP because it is stopped, a disposable Crabbox clone probe is acceptable.
- Host `node`, `npm`, `git`, `tar`, and any host-side renderer tools exist.
- Required auth variables for live suites are present, reported as redacted presence only.
- Artifact root is writable.
- Repo status is visible.
- Forbidden files such as `.env`, `.env.*`, local package tarballs, `.artifacts`, `.crabbox`, and `.debug` are not in the package or source archive.

Do not downgrade a missing required target to a warning. A release gate with missing Windows, Docker, SSH, auth, or Crabbox setup is blocked.

## Lease and run strategy

Use target sessions, not one fresh lease per suite.

Recommended shape:

```text
for each target in parallel:
  warmup once with slug <project>-<target>
  run suites serially on that lease
  stop lease in finally
```

Targets can run concurrently when the host can handle Docker, localhost SSH, and Parallels together. Suites should stay serial within a target unless the project has proven its ports, sessions, workspaces, and artifacts are isolated.

Use stable slugs:

```text
<project>-macos
<project>-ubuntu
<project>-windows-native
```

Sync rules:

- Start with `crabbox sync-plan` when first onboarding a repo or when sync is unexpectedly large.
- Use `.gitignore`, `.crabboxignore`, or Crabbox `sync.exclude` for generated state.
- Use `--fresh-sync` when a target workspace may be stale or a previous suite mutated the checkout.
- Use `--no-sync` only after a deliberate shared prep step on the same lease.
- If a private/local repo cannot use remote Git seeding reliably, set `CRABBOX_SYNC_GIT_SEED=false` in the harness and document why.
- Do not use `--force-sync-large` unless the large transfer is understood and intentional.

Always record:

```text
crabbox.stdout.txt
crabbox.stderr.txt
crabbox.timing.json
crabbox.stop.stdout.txt
crabbox.stop.stderr.txt
crabbox.stop.exit-code.txt
```

A `stop` failure is a test result. Preserve the original suite result and add a failing `lease-cleanup` result or mark the owning suite failed.

## pi extension release contract

For pi extensions, the baseline `platform-build` suite should prove package installation, not only source-tree execution.

On every required target:

1. Check Node major version against `nodeValidationMajor`.
2. Run `npm ci`.
3. Run the repo's local verification command, usually `npm run verify` or the repo-specific equivalent.
4. Run `npm pack`.
5. Create a fresh target-local pi project/workspace.
6. Run `npm install --no-save <packed tarball>`.
7. Run `pi install -l ./node_modules/<package>`.
8. Run `pi list`.
9. Assert the installed package came from the packed install path.
10. Assert the release proof did not use `pi -e .` or `pi --extension .`.

`pi -e .` is inner-loop debug only. It is not release proof because it bypasses package contents, `files`, install layout, and publish-time mistakes.

Add a real pi runtime suite when the extension's user contract depends on runtime behavior that unit tests cannot prove. Keep it deterministic:

- install the packed package into a clean project;
- use a fixed model/provider unless the project config overrides it;
- forward only named auth env vars;
- write session JSONL and target-local result files;
- assert final assistant text, tool calls/results, extension state, and persisted files structurally, not by broad substring scans.

Add visual/TUI suites only when the extension has user-facing terminal UI. The portable visual contract is:

```text
target captures PTY/ConPTY ANSI
host renders ANSI through one xterm/Playwright renderer
host writes HTML + PNG evidence
assert rendered output, not prompt text
```

Do not make tmux the cross-platform visual source of truth when native Windows is required. Use PTY on POSIX targets and ConPTY on Windows.

## Artifact contract

Every suite should write a self-contained directory:

```text
.artifacts/platform-smoke/<run-id>/<target>/<suite>/
  summary.json
  artifact-manifest.json
  target.json
  suite.json
  command.txt
  exit-code.txt
  crabbox.stdout.txt
  crabbox.stderr.txt
  crabbox.timing.json
  assertions.json
  failures.md                  # only when assertions fail
```

Add suite-specific evidence, for example:

```text
node-version.txt
npm-ci.stdout.txt
npm-ci.stderr.txt
npm-test.stdout.txt
npm-test.stderr.txt
packed-tarball.txt
packed-node-install.stdout.txt
packed-node-install.stderr.txt
pi-install.stdout.txt
pi-install.stderr.txt
pi-list.stdout.txt
pi-list.stderr.txt
session.jsonl
terminal.ansi
terminal.html
terminal.png
redaction-scan.json
```

Pass/fail invariant:

```text
summary.ok === assertions.ok
artifact-manifest.missing.length === 0 for any passing suite
missing required artifact => assertion failure + summary.ok=false
```

Do not rely on Crabbox `--artifact-glob` for this matrix. Crabbox's SSH artifact collector is useful on Linux, but native Windows and macOS targets reject that collector. A portable harness should write host-side artifact files from captured stdout/stderr, explicit target output markers, session paths, or a safe target-produced bundle whose paths are validated before unpacking.

## Secrets and environment forwarding

Crabbox intentionally does not forward your whole environment to the remote target. By default it forwards only narrow built-ins such as `CI` and `NODE_OPTIONS`. Live pi suites must opt in to exactly the variables they need.

Local forwarding of secrets is acceptable for these maintainer-owned smoke gates when the suite needs real provider/model auth. The hard line is persistence and sharing: secrets must never be committed, baked into templates, written to artifacts, printed in docs/PRs, or posted in chat.

Best practices:

- Keep auth values out of docs, configs, shell commands, artifact names, and template images.
- Store auth variable names in config, e.g. `defaultAuthEnv: ["ZAI_API_KEY"]`.
- Forward only named auth variables with `--allow-env NAME` or `--env-from-profile <file> --allow-env NAME`.
- Do not pass API keys as command-line arguments.
- Preserve normal local process environment such as `PATH`, `HOME`, and tool configuration, but do not dump the full environment into artifacts.
- Redact stdout, stderr, JSONL, HTML, ANSI, debug files, and failure bundles before committing, publishing, posting, or sharing them.
- Fail if a redaction scan finds API keys, bearer tokens, cookies, auth headers, or raw `.env` contents in persisted artifacts.

Docs may say `CURSOR_API_KEY=(present, redacted)` or `ZAI_API_KEY=(present, redacted)`. They must never include values.

## Make false green states impossible

The main guardrails:

- `doctor` is required before `all`.
- Required targets do not skip green.
- Release proof uses packed install, not `pi -e .`.
- A suite cannot pass with missing required artifacts.
- Cleanup failures fail the target result.
- Visual assertions inspect rendered output, not only prompt text.
- JSONL assertions inspect specific message fields, not all-file substrings.
- Auth is forwarded to targets by explicit allowlist only.
- Secrets can be used locally, but artifacts/docs/comments never expose them.
- Target-specific assumptions live in `docs/platform-smoke.md`, not in chat.

## Adoption procedure for a new pi extension

1. Identify the package name and pi install path.
2. Define required targets: default to `macos`, `ubuntu`, and `windows-native`.
3. Define required suites: always start with `platform-build`; add runtime or visual suites only for real user contracts.
4. Add `platform-smoke.config.mjs` with package name, targets, suites, Crabbox version, Ubuntu image, and Node baseline.
5. Add `scripts/platform-smoke.mjs` with `doctor`, per-target, and `all` commands.
6. Add a thin `crabbox-runner.mjs` that owns target base args, warmup, run, timeout, env allowlist, and stop.
7. Add target command builders in `targets.mjs`; keep POSIX and PowerShell paths explicit.
8. Add `platform-build-windows.ps1` for the Windows suite body.
9. Add `artifacts.mjs` and make missing artifacts fail.
10. Add `doctor.mjs`; all required local prerequisites fail hard.
11. Add cheap tests for harness syntax, help, target selection, packed-install command rendering, manifest failure, cleanup failure, and package inclusion/exclusion.
12. Add `docs/platform-smoke.md` as the project-specific source of truth.
13. Add a short pointer in `AGENTS.md` and README if the platform gate is release-blocking.
14. Run `npm run check:platform-smoke`, then `npm run smoke:platform:doctor`, then a single target, then `npm run smoke:platform:all`.

## Project adoption checklist

Before declaring a project integrated, answer these in that project's docs:

1. What package/install path must release prove?
2. Which OS targets are release-blocking?
3. What exact Crabbox version or minimum version is supported?
4. Which Ubuntu image is used?
5. Which Parallels template and snapshot are used?
6. What target tools are expected globally, especially on Windows?
7. What suite proves packed pi install?
8. What suite, if any, proves real pi runtime behavior?
9. What visual evidence, if any, is required?
10. What auth env names are allowed to cross into targets?
11. What artifacts must exist for a pass?
12. What redaction scans run before sharing evidence?
13. How are lease cleanup failures surfaced?
14. Which docs, package scripts, and tests are the source of truth?

The standard is not "copy every file from pi-cursor-sdk." The standard is: define the platform failure modes that matter for the extension, then make the local Crabbox gate produce durable evidence for them on macOS, Ubuntu, and native Windows without sharing state between repositories.
