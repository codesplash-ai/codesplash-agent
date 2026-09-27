import { existsSync } from "node:fs"
import type { SandboxProfile } from "./contracts.ts"

export function resourceScope(
  profile: SandboxProfile,
): { wrap(argv: string[]): string[]; cleanup(): void } | undefined {
  if (!profile.limits) return
  if (
    process.platform !== "linux" ||
    !existsSync("/sys/fs/cgroup/cgroup.controllers") ||
    !Bun.which("systemd-run") ||
    !Bun.which("systemctl")
  )
    throw new Error("Resource limits require Linux cgroup v2 and a delegated user systemd manager")
  const runtime = `/run/user/${process.getuid?.()}`
  const bus = `unix:path=${runtime}/bus`
  const managerEnv = { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: bus }
  const unit = `codesplash-${crypto.randomUUID()}.scope`
  return {
    wrap: (argv) => [
      "/usr/bin/env",
      `XDG_RUNTIME_DIR=${runtime}`,
      `DBUS_SESSION_BUS_ADDRESS=${bus}`,
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--description=CodeSplash sandbox command",
      `--unit=${unit}`,
      `--property=MemoryMax=${profile.limits!.memoryMiB}M`,
      "--property=MemorySwapMax=0",
      `--property=TasksMax=${profile.limits!.processes}`,
      "--property=OOMPolicy=kill",
      "--property=KillMode=control-group",
      "--",
      ...argv,
    ],
    cleanup: () => {
      const result = Bun.spawnSync(["systemctl", "--user", "stop", unit], {
        env: managerEnv,
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5000,
      })
      // A collected scope no longer exists. A live scope must not remain after teardown.
      if (result.exitCode !== 0) {
        const alive = Bun.spawnSync(["systemctl", "--user", "is-active", "--quiet", unit], {
          env: managerEnv,
          stdout: "ignore",
          stderr: "ignore",
          timeout: 5000,
        })
        if (alive.exitCode === 0) throw new Error("Resource scope teardown failed")
      }
    },
  }
}
export function validateResourceLimits(value: unknown): { memoryMiB: number; processes: number } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sandbox resource limits")
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).some((k) => !["memoryMiB", "processes"].includes(k)) ||
    !Number.isInteger(v.memoryMiB) ||
    Number(v.memoryMiB) < 64 ||
    Number(v.memoryMiB) > 65536 ||
    !Number.isInteger(v.processes) ||
    Number(v.processes) < 1 ||
    Number(v.processes) > 4096
  )
    throw new Error("Resource limits require 64–65536 MiB and 1–4096 processes")
  return { memoryMiB: Number(v.memoryMiB), processes: Number(v.processes) }
}
