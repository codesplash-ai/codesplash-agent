import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { FixtureApp } from "./app.tsx"

export async function runFixture(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60 })
  createRoot(renderer).render(<FixtureApp />)
}
