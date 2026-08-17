/** Runs from npm's `version` lifecycle: regenerates src/version.ts from package.json. */
import { fileURLToPath } from "node:url"

const projectRoot = fileURLToPath(new URL("..", import.meta.url))
const packageJson = (await Bun.file(`${projectRoot}/package.json`).json()) as { version: string }

await Bun.write(
  `${projectRoot}/src/version.ts`,
  `/** Kept in sync with package.json by tests/cli.test.ts; the compiled binary has no package.json. */
export const APP_VERSION = "${packageJson.version}"
`,
)

process.stdout.write(`src/version.ts -> ${packageJson.version}\n`)
