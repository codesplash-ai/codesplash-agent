import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { bytes, digest } from "../../../core/session/files.ts"
import type { ExecutionResult } from "./contracts.ts"
import { childEnvironment } from "./env-policy.ts"
import { runProcess } from "./process.ts"

export type MicroVMEnvironment = {
  id: string
  transport: "microvm"
  executable: string
  kernel: string
  kernelSha256: string
  initrd: string
  initrdSha256: string
  memoryMiB: number
  accelerator: "tcg" | "kvm"
  bootTimeoutMs: number
}
export function validateMicroVM(raw: MicroVMEnvironment): void {
  if (
    [raw.executable, raw.kernel, raw.initrd].some(
      (p) => typeof p !== "string" || !isAbsolute(p) || /[\p{Cc}\p{Cf}]/u.test(p),
    ) ||
    [raw.kernelSha256, raw.initrdSha256].some((h) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h)) ||
    !Number.isInteger(raw.memoryMiB) ||
    raw.memoryMiB < 64 ||
    raw.memoryMiB > 2048 ||
    !["tcg", "kvm"].includes(raw.accelerator) ||
    !Number.isInteger(raw.bootTimeoutMs) ||
    raw.bootTimeoutMs < 1000 ||
    raw.bootTimeoutMs > 120000 ||
    Object.keys(raw).some(
      (k) =>
        ![
          "id",
          "transport",
          "executable",
          "kernel",
          "kernelSha256",
          "initrd",
          "initrdSha256",
          "memoryMiB",
          "accelerator",
          "bootTimeoutMs",
        ].includes(k),
    )
  )
    throw new Error("Micro-VM requires fixed runtime, pinned boot assets, memory and boot deadline")
}
/** Linux newc archive. Names and modes are host constants, never supplied by a model. */
function overlay(command: string, nonce: string, timeoutMs: number): Buffer {
  const chunks: Buffer[] = []
  let inode = 1
  const add = (name: string, mode: number, data = Buffer.alloc(0)) => {
    const filename = Buffer.from(`${name}\0`)
    const fields = [inode++, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, filename.length, 0]
    const header = Buffer.from(`070701${fields.map((n) => n.toString(16).padStart(8, "0")).join("")}`)
    chunks.push(
      header,
      filename,
      Buffer.alloc((4 - ((header.length + filename.length) % 4)) % 4),
      data,
      Buffer.alloc((4 - (data.length % 4)) % 4),
    )
  }
  for (const path of ["proc", "sys", "dev", "tmp", "workspace"]) add(path, 0o40755)
  const init = `#!/bin/busybox sh
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
/bin/busybox --install -s /bin
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
cd /workspace || exit 125
printf '\\nCSVM-${nonce}-BEGIN\\n'
/bin/busybox timeout -s TERM -k 2 ${Math.ceil(timeoutMs / 1000)} /bin/busybox sh /codesplash-command.sh
result=$?
printf '\\nCSVM-${nonce}-END:%s\\n' "$result"
/bin/busybox reboot -f
while :; do /bin/busybox sleep 1; done
`
  add("init", 0o100700, Buffer.from(init))
  add("codesplash-command.sh", 0o100600, Buffer.from(command))
  add("TRAILER!!!", 0)
  return Buffer.concat(chunks)
}
/** One guest per command; no disk, host mounts, NIC, control socket or guest-to-host apply channel. */
export async function runMicroVM(
  env: MicroVMEnvironment,
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  validateMicroVM(env)
  if (process.platform !== "linux") throw new Error("Micro-VM runtime currently requires a Linux host")
  if (
    command.includes("\0") ||
    Buffer.byteLength(command) > 65536 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000
  )
    throw new Error("Invalid micro-VM command or deadline")
  const kernel = bytes(env.kernel, 64 * 1024 * 1024),
    initrd = bytes(env.initrd, 128 * 1024 * 1024)
  if (digest(kernel) !== env.kernelSha256 || digest(initrd) !== env.initrdSha256)
    throw new Error("Micro-VM boot asset checksum mismatch")
  const owner = await mkdtemp(join(tmpdir(), "codesplash-microvm-")),
    nonce = randomUUID()
  try {
    const kernelPath = join(owner, "kernel"),
      initrdPath = join(owner, "initrd")
    await writeFile(kernelPath, kernel, { mode: 0o600 })
    await writeFile(
      initrdPath,
      Buffer.concat([
        initrd,
        Buffer.alloc((4 - (initrd.length % 4)) % 4),
        overlay(command, nonce, timeoutMs),
      ]),
      { mode: 0o600 },
    )
    const result = await runProcess(
      [
        env.executable,
        "-M",
        "microvm",
        "-accel",
        env.accelerator,
        "-cpu",
        env.accelerator === "kvm" ? "host" : "max",
        "-m",
        String(env.memoryMiB),
        "-smp",
        "1",
        "-nodefaults",
        "-no-user-config",
        "-display",
        "none",
        "-monitor",
        "none",
        "-serial",
        "stdio",
        "-nic",
        "none",
        "-no-reboot",
        "-sandbox",
        "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
        "-kernel",
        kernelPath,
        "-initrd",
        initrdPath,
        "-append",
        "console=ttyS0 quiet panic=1 reboot=t rdinit=/init",
      ],
      {
        cwd: owner,
        env: childEnvironment(owner),
        signal,
        timeoutMs: env.bootTimeoutMs + timeoutMs + 5000,
        maxBytes: 50000,
      },
    )
    if (result.kind !== "success") return result
    const begin = `CSVM-${nonce}-BEGIN`,
      end = new RegExp(`CSVM-${nonce}-END:([0-9]{1,3})`)
    const match = end.exec(result.stdout),
      start = result.stdout.indexOf(begin)
    if (start < 0 || !match || match.index < start || Number(match[1]) > 255)
      return {
        ...result,
        kind: "command-failure",
        exitCode: 125,
        stderr: `Guest did not complete its command. ${result.stderr}`,
      }
    const exitCode = Number(match[1])
    return {
      kind: exitCode === 0 ? "success" : "command-failure",
      exitCode,
      stdout: result.stdout.slice(start + begin.length, match.index).trim(),
      stderr: result.stderr,
    }
  } finally {
    await rm(owner, { recursive: true, force: true })
  }
}
