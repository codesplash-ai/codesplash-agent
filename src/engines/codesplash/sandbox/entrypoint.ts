import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Works in source, tsc output, and Bun's compiled virtual filesystem. */
export function internalCommand(role: "supervisor" | "worker"): string[] {
  if (import.meta.url.includes("/$bunfs/")) return [process.execPath, `--internal-sandbox-${role}`]
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), `../../..`, `cli.${extension}`)
  return [process.execPath, cli, `--internal-sandbox-${role}`]
}
export function installationRoot(): string {
  if (import.meta.url.includes("/$bunfs/")) return process.execPath
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
}
