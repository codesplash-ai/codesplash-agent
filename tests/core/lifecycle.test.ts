import { afterEach, describe, expect, test } from "bun:test"
import {
  deferSignalExit,
  registerChildProcess,
  registerCleanup,
  resetLifecycleForTests,
  runCleanups,
  suspendToShell,
} from "../../src/core/lifecycle.ts"

afterEach(() => {
  resetLifecycleForTests()
})

describe("lifecycle", () => {
  test("runs cleanups newest-first and tolerates failures", async () => {
    const order: string[] = []
    registerCleanup(() => {
      order.push("first")
    })
    registerCleanup(() => {
      throw new Error("cleanup exploded")
    })
    registerCleanup(async () => {
      order.push("third")
    })

    await runCleanups()
    expect(order).toEqual(["third", "first"])
  })

  test("unregistered cleanups do not run", async () => {
    const order: string[] = []
    const unregister = registerCleanup(() => {
      order.push("removed")
    })
    registerCleanup(() => {
      order.push("kept")
    })
    unregister()
    unregister()

    await runCleanups()
    expect(order).toEqual(["kept"])
  })

  test("cleanups run at most once even when triggered twice", async () => {
    let runs = 0
    registerCleanup(() => {
      runs += 1
    })

    await runCleanups()
    await runCleanups()
    expect(runs).toBe(1)
  })

  test("registered children can be released before shutdown", () => {
    const kills: string[] = []
    const unregister = registerChildProcess({
      kill: (signal) => kills.push(String(signal)),
    })
    unregister()
    expect(kills).toEqual([])
  })

  test("deferSignalExit releases exactly once", () => {
    const release = deferSignalExit()
    release()
    release()
    const releaseAgain = deferSignalExit()
    releaseAgain()
  })

  test("a parent that exits without cleanup SIGKILLs its registered children", async () => {
    const fixture = new URL("../fixtures/orphan-parent.ts", import.meta.url)
    const parent = Bun.spawn([process.execPath, fixture.pathname], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, exitCode] = await Promise.all([new Response(parent.stdout).text(), parent.exited])
    expect(exitCode).toBe(0)
    const childPid = Number(output.trim())
    expect(Number.isInteger(childPid)).toBe(true)

    // Signal 0 probes liveness; ESRCH means the child is gone. Zombie reaping can lag
    // a moment, so poll briefly.
    let alive = true
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(childPid, 0)
        await Bun.sleep(25)
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  })

  test("suspendToShell suspends the renderer, delivers SIGTSTP, and resumes on SIGCONT", () => {
    const calls: string[] = []
    const renderer = {
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    }
    const kills: Array<{ pid: number; signal: string }> = []
    const originalKill = process.kill.bind(process)
    process.kill = ((pid: number, signal: string) => {
      kills.push({ pid, signal })
      return true
    }) as typeof process.kill

    try {
      suspendToShell(renderer)
      expect(calls).toEqual(["suspend"])
      expect(kills).toEqual([{ pid: process.pid, signal: "SIGTSTP" }])

      process.emit("SIGCONT")
      expect(calls).toEqual(["suspend", "resume"])
      process.emit("SIGCONT")
      expect(calls).toEqual(["suspend", "resume"])
    } finally {
      process.kill = originalKill
    }
  })
})
