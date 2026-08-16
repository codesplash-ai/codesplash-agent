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
- [ ] Claude handoff exercised with the real CLI: launch, slash command, quit, resume via picker.

## Artifacts

- [ ] Version bumped in `package.json` **and** `src/version.ts` (test enforces sync), CHANGELOG
      entry written, tag matches `v<version>`.
- [ ] `bun run release:build` locally: archive contains agent/LICENSE/README, `.sha256` verifies,
      extracted binary passes `--version`, `--doctor`, and an open/quit TUI smoke.
- [ ] Reproducibility spot-check: rebuild with the pinned toolchain (Bun 1.3.14, frozen lockfile)
      and confirm the binary behaves identically; checksums published alongside artifacts.

## Clean-machine gate (VM or spare account)

- [ ] Install from each advertised channel (brew, npm, release tarball).
- [ ] `agent --doctor` reports sensible findings with no engines installed.
- [ ] Install provider CLIs, log in, launch both surfaces from the cockpit.
- [ ] Uninstall; verify nothing remains except (optionally) config/data dirs and that **no
      credential material exists anywhere the app wrote** (grep config/data dirs).

## Publishing prerequisites (one-time; see README + release.yml)

- [ ] Repo public; `codesplash-ai/homebrew-tap` exists (public).
- [ ] `NPM_TOKEN` and `TAP_GITHUB_TOKEN` actions secrets set; npm package name confirmed.

## Rollback

Previous releases stay downloadable; rollback = install the prior tag from any channel
(`npm i -g codesplash-agent@<prev>`, earlier release archive, or pinned brew formula commit in the
tap history). If a release is broken, mark it as a pre-release/yanked on GitHub, `npm deprecate`
the version, and revert the tap formula commit.
