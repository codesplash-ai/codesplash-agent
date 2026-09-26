import { useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { SessionController } from "../core/index.ts"
import { redactSensitiveText } from "../core/redaction.ts"
import type { BrandPalette } from "./brand.ts"

const tabs = ["MCP", "Plugins", "Hooks", "Skills", "Extensions"]
export function IntegrationsPanel({
  controller,
  palette,
  onStage,
  onClose,
}: {
  controller: SessionController
  palette: BrandPalette
  onStage(text: string): void
  onClose(): void
}) {
  const [tab, setTab] = useState(0),
    [command, setCommand] = useState(""),
    [output, setOutput] = useState("Loading…"),
    [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const execute = useCallback(
    async (argument = "status") => {
      const current = ++generation.current
      setBusy(true)
      try {
        const result =
          tab === 0
            ? await controller.mcpCommand(argument)
            : tab === 1
              ? await controller.pluginsCommand(argument)
              : tab === 2
                ? await controller.hooksCommand(argument)
                : tab === 4
                  ? await controller.extensionsCommand(argument)
                  : await controller.contextResources("skill")
        if (current === generation.current)
          setOutput(redactSensitiveText(JSON.stringify(result, null, 2)).slice(0, 65536))
      } catch (error) {
        if (current === generation.current) setOutput(redactSensitiveText(String(error)))
      } finally {
        if (current === generation.current) setBusy(false)
      }
    },
    [controller, tab],
  )
  useEffect(() => {
    void execute()
    return () => {
      generation.current++
    }
  }, [execute])
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === "escape") {
      key.preventDefault()
      onClose()
    } else if (key.name === "tab") {
      key.preventDefault()
      setTab((tab + (key.shift ? tabs.length - 1 : 1)) % tabs.length)
      setCommand("")
    } else if (key.name === "return" && !busy) {
      key.preventDefault()
      if (tab === 3 && command.trim()) onStage(`/skill ${command.trim()} `)
      else {
        void execute(command.trim() || "status")
        setCommand("")
      }
    }
  })
  const hint =
    tab === 0
      ? "status | enable ID | disable ID | reconnect ID"
      : tab === 1
        ? "status | reload"
        : tab === 2
          ? "status | show ID | reload | disable ID | receipts"
          : tab === 3
            ? "Skill name stages /skill into the composer"
            : "status | reload | disable ID | run ID/COMMAND ARGUMENT"
  return (
    <box
      style={{
        position: "absolute",
        left: "4%",
        top: 1,
        width: "92%",
        height: "90%",
        zIndex: 40,
        border: true,
        borderColor: palette.accent,
        backgroundColor: palette.popover,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text style={{ flexShrink: 0 }} fg={palette.accent}>
        Integrations · {tabs.map((name, i) => (i === tab ? `[${name}]` : name)).join("  ")}
      </text>
      <scrollbox style={{ flexGrow: 1, minHeight: 1 }}>
        <text fg={palette.foreground}>{output}</text>
      </scrollbox>
      <text style={{ flexShrink: 0 }} fg={palette.muted}>
        {busy ? "Working…" : hint}
      </text>
      <input
        style={{ flexShrink: 0 }}
        focused
        value={command}
        onInput={setCommand}
        textColor={palette.foreground}
        backgroundColor={palette.panel}
      />
      <text style={{ flexShrink: 0 }} fg={palette.muted}>
        Tab changes integration · Enter runs the explicit action · Esc closes · source trust still applies
      </text>
    </box>
  )
}
