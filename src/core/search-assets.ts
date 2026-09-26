// Static imports embed all supported targets in the standalone Bun executable.
// build-assets.ts emits a package-resolved equivalent for unbundled SDK installs.
import asset0 from "../../node_modules/@vscode/ripgrep-universal/bin/darwin-arm64/rg" with { type: "file" }
import asset1 from "../../node_modules/@vscode/ripgrep-universal/bin/darwin-x64/rg" with { type: "file" }
import asset2 from "../../node_modules/@vscode/ripgrep-universal/bin/linux-arm64/rg" with { type: "file" }
import asset3 from "../../node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg" with { type: "file" }

export const searchAssets: Record<string, string> = {
  "darwin-arm64": asset0,
  "darwin-x64": asset1,
  "linux-arm64": asset2,
  "linux-x64": asset3,
}
