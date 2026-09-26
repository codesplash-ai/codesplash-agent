import { spawn } from "node:child_process"
import { writeSync } from "node:fs"
import { useRenderer } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import type { TuiConfig } from "../core/config/tui.ts"
import type { AppViewState } from "../core/index.ts"
import { registerChildProcess, registerCleanup } from "../core/lifecycle.ts"
import type { BrandPalette } from "./brand.ts"
import { reviewTerminalIntegrations, runTerminalCommand, terminalText } from "./terminal-integrations.ts"

export function inhibitSleep(onFailure: (message: string) => void = () => {}): {
  stop(): void
  diagnostic?: string
} {
  const argv =
    process.platform === "darwin"
      ? ["caffeinate", "-i"]
      : process.platform === "linux"
        ? [
            "systemd-inhibit",
            "--what=idle:sleep",
            "--why=CodeSplash active turn",
            "--mode=block",
            "sleep",
            "infinity",
          ]
        : []
  if (!argv[0] || !Bun.which(argv[0]))
    return { stop() {}, diagnostic: "Sleep inhibition is unavailable on this host" }
  const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: process.platform !== "win32" })
  let stopped = false
  const stop = () => {
    stopped = true
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
      else child.kill("SIGKILL")
    } catch {}
  }
  const untrack = registerChildProcess({ kill: stop }),
    unregister = registerCleanup(stop)
  const cleanup = () => {
    stop()
    untrack()
    unregister()
  }
  child.once("error", () => {
    if (!stopped) onFailure("Sleep inhibitor could not start")
    cleanup()
  })
  child.once("close", (code) => {
    if (!stopped && code !== 0) onFailure("Sleep inhibition unavailable; check host permissions")
    cleanup()
  })
  return { stop: cleanup }
}
export function statusSegments(
  settings: TuiConfig,
  state: AppViewState,
  project: string,
  clock = new Date(),
): string {
  const values: Record<string, string> = {
    model: state.model ?? "default model",
    state: state.turnStatus ?? state.sessionStatus,
    project,
    context: state.usage.contextTokens === undefined ? "" : `${state.usage.contextTokens} context tokens`,
    tokens: `${(state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0)} tokens`,
    cost:
      state.usage.estimatedCostUsd === undefined
        ? "cost unknown"
        : `$${state.usage.estimatedCostUsd.toFixed(4)}${state.usage.hasUnpricedUsage ? "+" : ""}`,
    clock: clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }
  return settings.statusSegments
    .map((key) => terminalText(values[key] ?? "", 120))
    .filter(Boolean)
    .join(" · ")
}

export function Attention({
  settings,
  state,
  project,
  cwd,
  directory,
  palette,
  enabled,
}: {
  settings: TuiConfig
  state: AppViewState
  project: string
  cwd: string
  directory: string
  palette: BrandPalette
  enabled: boolean
}) {
  const renderer = useRenderer(),
    focused = useRef(true),
    blurredAt = useRef(0)
  const previous = useRef({ running: state.turnStatus === "running", request: state.pendingRequest?.id })
  const [tick, setTick] = useState(0),
    [scriptStatus, setScriptStatus] = useState(""),
    [diagnostic, setDiagnostic] = useState("")
  const latest = useRef(state)
  latest.current = state
  useEffect(() => {
    const focus = () => {
        focused.current = true
      },
      blur = () => {
        focused.current = false
        blurredAt.current = Date.now()
      }
    renderer.on("focus", focus)
    renderer.on("blur", blur)
    return () => {
      renderer.off("focus", focus)
      renderer.off("blur", blur)
    }
  }, [renderer])
  useEffect(() => {
    const running = state.turnStatus === "running",
      request = state.pendingRequest?.id
    if (
      settings.notifications &&
      !focused.current &&
      Date.now() - blurredAt.current >= settings.notificationIdleMs
    ) {
      if (request && request !== previous.current.request)
        renderer.triggerNotification("CodeSplash needs your input", "CodeSplash")
      else if (previous.current.running && !running)
        renderer.triggerNotification("CodeSplash turn finished", "CodeSplash")
    }
    previous.current = { running, request }
  }, [
    renderer,
    settings.notifications,
    settings.notificationIdleMs,
    state.turnStatus,
    state.pendingRequest?.id,
  ])
  useEffect(() => {
    if (!enabled || !settings.title || !process.stdout.isTTY) return
    writeSync(process.stdout.fd, "\x1b[22;0t")
    return () => {
      writeSync(process.stdout.fd, "\x1b[23;0t")
    }
  }, [enabled, settings.title])
  useEffect(() => {
    if (enabled && settings.title)
      renderer.setTerminalTitle(
        terminalText(
          `CodeSplash · ${project} · ${state.pendingRequest ? "Action required" : state.turnStatus === "running" && settings.spinner ? `${settings.reducedMotion ? "●" : ["⠋", "⠙", "⠹", "⠸"][tick % 4]} Working` : (state.turnStatus ?? state.sessionStatus)}`,
          100,
        ),
      )
  }, [
    enabled,
    settings.title,
    settings.spinner,
    settings.reducedMotion,
    tick,
    renderer,
    project,
    state.turnStatus,
    state.sessionStatus,
    state.pendingRequest,
  ])
  useEffect(() => {
    if (!enabled || !settings.sleepInhibitor || state.turnStatus !== "running") return
    const inhibitor = inhibitSleep(setDiagnostic)
    setDiagnostic(inhibitor.diagnostic ?? "")
    return inhibitor.stop
  }, [enabled, settings.sleepInhibitor, state.turnStatus])
  useEffect(() => {
    if (
      settings.reducedMotion ||
      state.turnStatus !== "running" ||
      (!settings.spinner && settings.pet === "none")
    )
      return
    const timer = setInterval(() => setTick((value) => value + 1), 200)
    return () => clearInterval(timer)
  }, [settings.reducedMotion, settings.spinner, settings.pet, state.turnStatus])
  useEffect(() => {
    if (!enabled) return
    const owner = new AbortController()
    let running = false
    const run = async () => {
      if (running || owner.signal.aborted) return
      running = true
      try {
        const review = reviewTerminalIntegrations(directory)
        if (!review.config.statusLine) {
          setScriptStatus("")
          return
        }
        if (!review.trusted) {
          setScriptStatus("Status script awaits /terminal review")
          return
        }
        const snapshot = latest.current
        const result = await runTerminalCommand(review.config.statusLine, {
          cwd,
          signal: owner.signal,
          input: JSON.stringify({
            version: 1,
            project: terminalText(project),
            model: terminalText(snapshot.model ?? ""),
            state: snapshot.turnStatus,
            usage: snapshot.usage,
          }),
        })
        if (!owner.signal.aborted) setScriptStatus(terminalText(result, 240))
      } catch (error) {
        if (!owner.signal.aborted)
          setScriptStatus(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? ""
              : terminalText(`Status script: ${String(error)}`, 160),
          )
      } finally {
        running = false
      }
    }
    void run()
    const timer = setInterval(() => void run(), 5000)
    return () => {
      clearInterval(timer)
      owner.abort()
    }
  }, [enabled, directory, cwd, project])
  const moving = state.turnStatus === "running" && !settings.reducedMotion
  const spinner =
    settings.spinner && state.turnStatus === "running" ? (moving ? ["⠋", "⠙", "⠹", "⠸"][tick % 4] : "●") : ""
  const pet = settings.pet === "cat" ? (moving && tick % 2 ? " /ᐠ•ᴥ•ᐟ\\ " : " /ᐠ-ᴥ-ᐟ\\ ") : ""
  return (
    <text fg={palette.muted} style={{ height: 1, flexShrink: 0 }}>
      {spinner}
      {pet}
      {statusSegments(settings, state, project)}
      {scriptStatus ? ` · ${scriptStatus}` : ""}
      {diagnostic ? ` · ${diagnostic}` : ""}
    </text>
  )
}
