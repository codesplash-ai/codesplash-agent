/** Non-interactive diagnostics: the release smoke and the first thing support asks for. */
import { configFilePath, dataDirectory, type EngineProbe, inspectProject } from "./core/index.ts"
import { ClaudeDriver } from "./engines/claude/index.ts"
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
}

export async function collectDoctorReport(cwd = process.cwd()): Promise<DoctorReport> {
  const [codex, claude, project] = await Promise.all([
    new CodexDriver().probe(),
    new ClaudeDriver().probe(),
    inspectProject(cwd).catch(() => undefined),
  ])
  const configPath = configFilePath()

  return {
    version: APP_VERSION,
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform} ${process.arch}`,
    configPath,
    configPresent: await Bun.file(configPath).exists(),
    dataDirectory: dataDirectory(),
    git: project?.git.available ? "available" : "not available",
    codex,
    claude,
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `CodeSplash Agent ${report.version}`,
    `runtime  ${report.runtime} (${report.platform})`,
    `config   ${report.configPath}${report.configPresent ? "" : " (defaults; not created yet)"}`,
    `data     ${report.dataDirectory}`,
    `git      ${report.git}`,
    `codex    ${formatProbe(report.codex)}`,
    `claude   ${formatProbe(report.claude)}`,
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
