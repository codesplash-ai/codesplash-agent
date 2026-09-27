import { copyFile, mkdir, writeFile } from "node:fs/promises"

await mkdir(new URL("../dist/core/session/", import.meta.url), { recursive: true })
await copyFile(
  new URL("../src/core/session/secure-path.c", import.meta.url),
  new URL("../dist/core/session/secure-path.c", import.meta.url),
)

// Dependency packages may be hoisted; SDK consumers must resolve the pinned package normally.
// Standalone builds instead compile the source module's static, embedded file imports.
await writeFile(
  new URL("../dist/core/search-assets.js", import.meta.url),
  `import { binPathFor } from "@vscode/ripgrep-universal";
export const searchAssets = Object.fromEntries(
  ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].map(target => {
    const [os, arch] = target.split("-");
    return [target, binPathFor({os, arch})];
  })
);
`,
)
