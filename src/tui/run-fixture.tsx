import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { FixtureApp } from "./app.tsx"

export async function runFixture(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  })
  createRoot(renderer).render(<FixtureApp />)
}
