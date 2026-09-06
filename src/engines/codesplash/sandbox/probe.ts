import { createProfile } from "./profile.ts"
import { NativeSandbox } from "./runtime.ts"

export async function probeSandbox(cwd = process.cwd()): Promise<string> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return "unavailable: native command isolation requires macOS or Linux"
  const runtime = new NativeSandbox(createProfile(cwd, "read-only"))
  try {
    const result = await runtime.execute(
      ["/bin/echo", "codesplash-sandbox-probe"],
      AbortSignal.timeout(10_000),
    )
    return result.kind === "success" && result.stdout.trim() === "codesplash-sandbox-probe"
      ? `${process.platform === "darwin" ? "Seatbelt" : "bwrap/seccomp"} available · execution probe passed · network grants required`
      : "unavailable: execution probe failed; install sandbox dependencies and run outside an incompatible outer sandbox"
  } catch {
    return "unavailable: sandbox probe failed"
  } finally {
    await runtime.close()
  }
}
