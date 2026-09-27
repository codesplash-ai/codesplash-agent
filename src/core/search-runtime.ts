import { chmodSync } from "node:fs"
import { join } from "node:path"
import { dataDirectory } from "./config.ts"
import { searchAssets } from "./search-assets.ts"
import { atomic, bytes, digest } from "./session/files.ts"

const assets: Record<string, { asset: string; sha256: string }> = {
  "win32-x64": {
    asset: searchAssets["win32-x64"]!,
    sha256: "f9dde63498b3193f098355dbec97af99dc4f6b8fa0df5ed04114a03012c042cb",
  },
  "win32-arm64": {
    asset: searchAssets["win32-arm64"]!,
    sha256: "0015ba7dfb2d8b62c39332d64e50c6e85f75230125e10c50a950ed14995c79bf",
  },
  "darwin-arm64": {
    asset: searchAssets["darwin-arm64"]!,
    sha256: "6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1",
  },
  "darwin-x64": {
    asset: searchAssets["darwin-x64"]!,
    sha256: "f999495980a5e6f1e7d26461ef5768b4013a62df610ed7d77a8b2de247a5b228",
  },
  "linux-arm64": {
    asset: searchAssets["linux-arm64"]!,
    sha256: "e152ea689d6e8420357e592f0d8253b96476c164118ca3e6e13074fa1705ddda",
  },
  "linux-x64": {
    asset: searchAssets["linux-x64"]!,
    sha256: "193906679498de4d939345b937fa24e0e69a03c244bd70c859f5e41232713f21",
  },
}
export const searchVersion = "ripgrep-universal@1.18.0"
/** Only the pinned package payload can repair a damaged cache; never PATH or a remote download. */
export async function searchRuntime(root = join(dataDirectory(), "runtime", "search")) {
  const target = `${process.platform}-${process.arch}`,
    spec = assets[target]
  if (!spec) throw new Error("Vendored search is unavailable on this target")
  const payload = Buffer.from(await Bun.file(spec.asset).arrayBuffer())
  if (digest(payload) !== spec.sha256) throw new Error("Bundled search checksum mismatch")
  const path = join(root, `${target}-rg${process.platform === "win32" ? ".exe" : ""}`)
  let repaired = false
  try {
    if (digest(bytes(path, 32 * 1024 * 1024)) !== spec.sha256) throw new Error("Damaged cache")
  } catch {
    atomic(path, payload)
    repaired = true
  }
  chmodSync(path, 0o500)
  return { path, payload, version: searchVersion, sha256: spec.sha256, repaired }
}
