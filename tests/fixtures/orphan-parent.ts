/** Spawns a long-lived child, registers it for orphan cleanup, prints its pid, and exits. */
import { installSignalHandlers, registerChildProcess } from "../../src/core/lifecycle.ts"

installSignalHandlers()

const child = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
registerChildProcess(child)
console.log(child.pid)

// Exiting without closing the child: the exit handler must SIGKILL it.
process.exit(0)
