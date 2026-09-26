import { basename } from "node:path"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { inspectProject } from "../core/preflight.ts"
import { SessionController } from "../core/session-controller.ts"
import { attachSession, type DaemonClient } from "../server/client.ts"
import { brandThemes } from "./brand.ts"
import { CodexSessionApp } from "./codex-session.tsx"

export async function runAttach(
  client: DaemonClient,
  threadId: string,
  cwd: string,
  mode: "reader" | "shared" | "exclusive",
  steal: boolean,
) {
  const session = await attachSession(client, threadId, mode, steal)
  const controller = new SessionController(session)
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
  try {
    const snapshot = (await client.rpc("thread/snapshot", { threadId })) as { cwd: string }
    const remoteCwd = snapshot.cwd ?? cwd
    const remoteProject = {
      cwd: remoteCwd,
      name: basename(remoteCwd),
      git: { available: false, repository: false, changedFiles: 0, detail: "Remote daemon workspace" },
    }
    const project = ["127.0.0.1", "[::1]"].includes(new URL(client.url).hostname)
      ? await inspectProject(remoteCwd).catch(() => remoteProject)
      : remoteProject
    controller.start()
    await new Promise<void>((resolve) =>
      createRoot(renderer).render(
        <CodexSessionApp
          controller={controller}
          project={project}
          palette={brandThemes.dark}
          engine="codesplash"
          onAction={() => resolve()}
        />,
      ),
    )
  } finally {
    renderer.destroy()
    await controller.close()
  }
}
