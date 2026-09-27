# Release checklist

Run top to bottom for every tagged release. A release ships only when every box is checked.

## Revalidation (policies and protocol drift move under us)

- [ ] Codex app-server docs reviewed; pinned protocol baseline (0.147.0) still matches
      `SUPPORTED_CODEX_CLI_VERSION` and the checked-in generated types. If Codex moved, decide:
      bump-and-regenerate (`codex app-server generate-ts --out src/engines/codex/generated`) or hold.
- [ ] Anthropic legal/usage policy pages re-read (code.claude.com/docs legal-and-compliance).
      Confirm the terminal-handoff model (official CLI owns auth; we never read `~/.claude`) is
      still compliant. Any native/stream-JSON ambition remains gated on a fresh decision (M6).
- [ ] OpenAI policy on third-party harnesses over ChatGPT subscriptions re-checked.
- [ ] Dependency license audit: `bun pm ls` review; OpenTUI/React and transitive licenses remain
      compatible with BUSL-1.1 distribution. LICENSE file parameters still correct.

## Quality gates (all quota-free in CI; manual items on a real machine)

- [ ] `bun run check` green on every CI target; Windows status reviewed even though experimental.
- [ ] Manual dogfood checklists from Milestones 2–4 (implementation-plan.md checkpoints) executed
      against a real authenticated session: restart+resume, Ctrl+Z/fg, external SIGTERM, resize,
      full-access confirmation, every slash command, `/model` switch, rate-limit display.
- [ ] M8 terminal walkthrough: palette/editor, settings provenance, docs/integrations, remap/Vim,
      inline/alternate mode, copy/images, side-question cancellation and reviewed dictation.
      Record actual terminal/microphone coverage; protocol fixtures do not prove device support.
- [ ] Claude handoff exercised with the real CLI: launch, slash command, quit, resume via picker.

## M11 distribution gates

- [ ] Compiled `m11-smoke.ts`: live feature revocation, hardening, custom kernel denies,
      offline supervisor, helper alias and actual PTY clipboard filtering.
- [ ] On a delegated Linux cgroup-v2 host, `m11-resource-smoke.ts` enforces OOM/process ceilings
      and leaves no active owned scope. Other hosts explicitly refuse configured limits.
- [ ] Signed manifest matches every packaged file; update interruption, migration conflict,
      signature/revision rejection and rollback tests pass. Retain signing keys outside artifacts.
- [ ] Real TLS, proxy CONNECT and cloud wire fixtures pass. Record live provider accounts and
      actual Windows/Termux hosts separately; fixtures cannot promote those support claims.
- [ ] Build the CI image and offline public docs; inspect package allowlists for private material.

## Artifacts

- [ ] Version bumped in `package.json` **and** `src/version.ts` (test enforces sync), CHANGELOG
      entry written, tag matches `v<version>`.
- [ ] `bun run release:build` locally: archive contains codesplash/LICENSE/README/THIRD_PARTY_NOTICES and sandbox-runtime, `.sha256` verifies,
      extracted binary passes `--version`, `--doctor`, and an open/quit TUI smoke.
- [ ] Reproducibility spot-check: rebuild with the pinned toolchain (Bun 1.3.14, frozen lockfile)
      and confirm the binary behaves identically; checksums published alongside artifacts.

## Clean-machine gate (VM or spare account)

- [ ] Install from each advertised channel (brew, npm, release tarball).
- [ ] `agent --doctor` reports sensible findings with no engines installed.
- [ ] Install provider CLIs, log in, launch both surfaces from the harness.
- [ ] Uninstall; verify nothing remains except the documented optional config/data directories.
      Verify credentials occur only in the native engine’s documented credential/secret stores,
      never in session events, exported bundles, logs or terminal integration output.

## Publishing prerequisites (one-time; see README + release.yml)

- [ ] Repo public; `codesplash-ai/homebrew-tap` exists (public).
- [ ] `NPM_TOKEN` and `TAP_GITHUB_TOKEN` actions secrets set; npm package name confirmed.

## Rollback

Previous releases stay downloadable; rollback = install the prior tag from any channel
(`npm i -g codesplash-agent@<prev>`, earlier release archive, or pinned brew formula commit in the
tap history). If a release is broken, mark it as a pre-release/yanked on GitHub, `npm deprecate`
the version, and revert the tap formula commit.


### M11 remaining-platform acceptance

- [ ] `m11-startup-smoke.ts` runs the compiled first-party agent and an approved tool inside its
      startup boundary; source tests also cover streaming/PTY transport and forged-profile refusal.
- [ ] Linux `m11-microvm-smoke.ts` boots reviewed hash-pinned assets and verifies ephemeral guest
      state, host/network denial, timeout and cancellation. Retain the boot hashes with the evidence.
- [ ] npm and Homebrew package-manager upgrade/recovery/rollback gates pass in isolated prefixes;
      run Scoop against a disposable Windows installation before advertising that adapter.
- [ ] Windows x64: native handle-relative storage tests, helper checksum, explicit setup, WFP
      verification, filesystem deny/write and job teardown gate. Retain the real runner output.
      Do not promote ARM64, Windows startup isolation or Windows standalone activation from these tests.
- [ ] Actual Android host: follow `docs/termux.md`, run `m11-termux-smoke.ts`, and retain the
      reported kernel, installed version, storage and local-sandbox/remote-client capability limit.
