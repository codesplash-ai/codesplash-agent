/** Non-interactive diagnostics: the release smoke and the first thing support asks for. */
import {
  type AgentConfig,
  type CustomProviderConfig,
  configFilePath,
  dataDirectory,
  defaultConfig,
  type EngineProbe,
  inspectProject,
  listProjectSessions,
  loadConfig,
  projectIdFor,
  readTrustDecision,
  sessionDirectory,
  sessionsRootDirectory,
  transcriptPathFor,
} from "./core/index.ts"
import { ClaudeDriver } from "./engines/claude/index.ts"
import { CodesplashDriver } from "./engines/codesplash/index.ts"
import { probeSandbox } from "./engines/codesplash/sandbox/probe.ts"
import { CodexDriver } from "./engines/codex/index.ts"
import { APP_VERSION } from "./version.ts"

export type DoctorReport = {
  version: string
  runtime: string
  platform: string
  configPath: string
  configPresent: boolean
  dataDirectory: string
  git: string
  codex: EngineProbe
  claude: EngineProbe
  codesplash: EngineProbe
  /** One line per configured custom [providers.*] entry — key env var names only, never values. */
  customProviders?: string[]
  /** Permission mode, rule counts per action, and cwd trust — never rule contents or paths. */
  permissions?: string
  sandbox?: string
  /** Native-transcript state for the newest codesplash session of this project (best effort). */
  transcript?: string
}

export async function collectDoctorReport(cwd = process.cwd()): Promise<DoctorReport> {
  const [codex, claude, codesplash, project, config] = await Promise.all([
    new CodexDriver().probe(),
    new ClaudeDriver().probe(),
    new CodesplashDriver().probe(),
    inspectProject(cwd).catch(() => undefined),
    // A broken config file must not break diagnostics; the probe line already reports engines.
    loadConfig().catch(() => structuredClone(defaultConfig)),
  ])
  const configPath = configFilePath()

  return {
    version: APP_VERSION,
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform} ${process.arch}`,
    configPath,
    configPresent: await Bun.file(configPath).exists(),
    sandbox: await probeSandbox(cwd),
    dataDirectory: dataDirectory(),
    git: project?.git.available ? "available" : "not available",
    codex,
    claude,
    codesplash,
    customProviders: config.providers.map((provider) => describeCustomProvider(provider)),
    permissions: await describePermissionsState(config, project?.cwd ?? cwd),
    transcript: project ? await describeNewestTranscript(project.cwd) : undefined,
  }
}

/**
 * One summary line for the permission layer: the configured mode, rule counts per action, and
 * whether this workspace is trusted. Never rule contents, never paths beyond the cwd itself.
 */
async function describePermissionsState(config: AgentConfig, cwd: string): Promise<string> {
  const counts = (["allow", "ask", "deny"] as const)
    .map((action) => ({ action, count: config.permissions[action].length }))
    .filter(({ count }) => count > 0)
    .map(({ action, count }) => `${count} ${action}`)
  const trusted = await readTrustDecision(cwd)
    .then((decision) => decision?.trusted === true)
    .catch(() => false)
  return [
    `mode ${config.permissions.mode}`,
    counts.length > 0 ? counts.join(" / ") : "no rules",
    `workspace ${trusted ? "trusted" : "not trusted"}`,
  ].join(" · ")
}

/** Names the key env var and whether it is set — the key value itself is never read here. */
function describeCustomProvider(provider: CustomProviderConfig, env = process.env): string {
  const keyState = env[provider.keyEnvVar]
    ? `${provider.keyEnvVar} set`
    : provider.requiresKey
      ? `${provider.keyEnvVar} missing`
      : "no key needed"
  return `${provider.displayName} (custom, ${provider.protocol} protocol) · ${provider.baseUrl} · ${keyState}`
}

/** Transcript presence for the project's newest codesplash session; failures degrade to nothing. */
async function describeNewestTranscript(cwd: string): Promise<string | undefined> {
  try {
    const root = sessionsRootDirectory()
    const projectId = projectIdFor(cwd)
    const newest = (await listProjectSessions(projectId, root)).find((meta) => meta.engine === "codesplash")
    if (!newest) return "no codesplash sessions for this project"
    const path = transcriptPathFor({
      directory: sessionDirectory(root, projectId, newest.localSessionId),
    })
    return `${path}${(await Bun.file(path).exists()) ? "" : " (missing)"}`
  } catch {
    return undefined
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const rows: Array<[string, string]> = [
    ["runtime", `${report.runtime} (${report.platform})`],
    ["config", `${report.configPath}${report.configPresent ? "" : " (defaults; not created yet)"}`],
    ["data", report.dataDirectory],
    ["git", report.git],
    ["codex", formatProbe(report.codex)],
    ["claude", formatProbe(report.claude)],
    ["codesplash", formatProbe(report.codesplash)],
    ...(report.sandbox ? [["sandbox", report.sandbox] as [string, string]] : []),
    ...(report.customProviders ?? []).map((line): [string, string] => ["provider", line]),
    ...(report.permissions !== undefined ? [["permissions", report.permissions] as [string, string]] : []),
    ...(report.transcript !== undefined ? [["transcript", report.transcript] as [string, string]] : []),
  ]
  // padEnd(12): one space after the longest label, "permissions".
  const lines = [
    `CodeSplash Agent ${report.version}`,
    ...rows.map(([label, value]) => `${label.padEnd(12)}${value}`),
  ]
  return `${lines.join("\n")}\n`
}

function formatProbe(probe: EngineProbe): string {
  if (!probe.available) return `○ ${probe.detail ?? "Not installed"}`
  const marker = probe.authenticated !== false && probe.compatible !== false ? "●" : "○"
  const parts = [
    probe.version ? `v${probe.version.replace(/^v/, "")}` : undefined,
    probe.authenticated === false ? "login required" : probe.detail,
    probe.compatible === false ? "unsupported version" : undefined,
  ].filter(Boolean)
  return `${marker} ${parts.join(" · ")}`
}

export async function runDoctor(): Promise<void> {
  const report = await collectDoctorReport()
  process.stdout.write(formatDoctorReport(report))
}
