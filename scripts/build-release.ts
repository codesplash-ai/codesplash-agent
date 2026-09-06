/**
 * Builds the host platform's release artifact: a Bun-compiled executable (ADR 0003's
 * proven format), archived with LICENSE and README, plus a SHA-256 checksum file.
 * Cross-compilation is deliberately absent — OpenTUI ships native libraries, so each
 * CI runner builds its own target and only smoke-passing targets are advertised.
 */

import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { verifiedSeccompHelper } from "../src/engines/codesplash/sandbox/supervisor.ts"
import { APP_VERSION } from "../src/version.ts"

const projectRoot = fileURLToPath(new URL("..", import.meta.url))
const outDirectory = join(projectRoot, "out")
const isWindows = process.platform === "win32"
const binaryName = isWindows ? "codesplash.exe" : "codesplash"
const target = `${process.platform}-${process.arch}`
const archiveName = `codesplash-agent-${APP_VERSION}-${target}.${isWindows ? "zip" : "tar.gz"}`

async function run(command: string[], cwd = projectRoot): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with status ${exitCode}`)
}

/**
 * Developer ID signing + notarization, env-gated so local/unconfigured builds still work
 * (Bun leaves an ad-hoc signature). Bare executables cannot be stapled — Gatekeeper
 * verifies the notarization ticket online — so notarizing the binary before archiving
 * is sufficient. Bun-compiled binaries JIT, hence the entitlements (see the plist).
 */
async function signAndNotarizeMacBinary(binaryPath: string): Promise<void> {
  const identity = process.env.APPLE_SIGNING_IDENTITY
  if (!identity) {
    process.stdout.write("APPLE_SIGNING_IDENTITY not set — leaving Bun's ad-hoc signature\n")
    return
  }

  const entitlementsPath = join(projectRoot, "packaging", "macos", "entitlements.plist")
  await run([
    "codesign",
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    entitlementsPath,
    "--sign",
    identity,
    binaryPath,
  ])
  await run(["codesign", "--verify", "--strict", "--verbose=2", binaryPath])

  const { APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_PASSWORD || !APPLE_TEAM_ID) {
    process.stdout.write("APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID not set — skipping notarization\n")
    return
  }

  const zipPath = `${binaryPath}.notarize.zip`
  await run(["ditto", "-c", "-k", binaryPath, zipPath])
  // notarytool's exit code does not reliably reflect an Invalid verdict; assert on output.
  const submit = Bun.spawn(
    [
      "xcrun",
      "notarytool",
      "submit",
      zipPath,
      "--apple-id",
      APPLE_ID,
      "--password",
      APPLE_PASSWORD,
      "--team-id",
      APPLE_TEAM_ID,
      "--wait",
    ],
    { cwd: projectRoot, stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  )
  const [submitOutput, submitExit] = await Promise.all([new Response(submit.stdout).text(), submit.exited])
  process.stdout.write(submitOutput)
  await rm(zipPath, { force: true })
  if (submitExit !== 0 || !/status: Accepted/.test(submitOutput)) {
    throw new Error(`Notarization did not report "status: Accepted" (exit ${submitExit})`)
  }
}

async function main(): Promise<void> {
  await rm(outDirectory, { recursive: true, force: true })
  await mkdir(outDirectory, { recursive: true })

  const binaryPath = join(outDirectory, binaryName)
  // Keep Bun's temporary compile files inside the ignored build directory.
  await run(
    ["bun", "build", join(projectRoot, "src", "cli.ts"), "--compile", "--outfile", binaryPath],
    outDirectory,
  )
  if (!isWindows) await chmod(binaryPath, 0o755)
  if (process.platform === "darwin" && !process.argv.includes("--unsigned"))
    await signAndNotarizeMacBinary(binaryPath)

  const runtimeAssets = join(outDirectory, "sandbox-runtime")
  await mkdir(runtimeAssets)
  const upstream = fileURLToPath(
    new URL("../node_modules/@anthropic-ai/sandbox-runtime/LICENSE", import.meta.url),
  )
  await copyFile(upstream, join(runtimeAssets, "LICENSE"))
  if (process.platform === "linux") {
    const helper = join(runtimeAssets, "apply-seccomp")
    await copyFile(await verifiedSeccompHelper(), helper)
    await chmod(helper, 0o755)
  }

  // Launch smoke: the compiled artifact must report the expected version before packaging.
  const smoke = Bun.spawn([binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" })
  const [smokeOutput, smokeExit] = await Promise.all([new Response(smoke.stdout).text(), smoke.exited])
  if (smokeExit !== 0 || smokeOutput.trim() !== APP_VERSION) {
    throw new Error(
      `Compiled binary smoke failed: exit ${smokeExit}, version "${smokeOutput.trim()}" (expected ${APP_VERSION})`,
    )
  }
  if (!isWindows) {
    await run([process.execPath, "scripts/sandbox-smoke.ts", binaryPath])
    await run([process.execPath, "scripts/context-smoke.ts", binaryPath])
  }

  await Bun.write(join(outDirectory, "LICENSE"), Bun.file(join(projectRoot, "LICENSE")))
  await Bun.write(join(outDirectory, "README.md"), Bun.file(join(projectRoot, "README.md")))

  const archivePath = join(outDirectory, archiveName)
  if (isWindows) {
    await run(
      [
        "powershell",
        "-Command",
        `Compress-Archive -Path ${binaryName},LICENSE,README.md,sandbox-runtime -DestinationPath ${archiveName}`,
      ],
      outDirectory,
    )
  } else {
    await run(
      ["tar", "-czf", archiveName, binaryName, "LICENSE", "README.md", "sandbox-runtime"],
      outDirectory,
    )
  }

  const digest = createHash("sha256")
    .update(new Uint8Array(await Bun.file(archivePath).arrayBuffer()))
    .digest("hex")
  await Bun.write(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`)

  process.stdout.write(`built ${archiveName}\nsha256 ${digest}\n`)
}

await main()
