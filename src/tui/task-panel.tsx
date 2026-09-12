import { useKeyboard } from "@opentui/react"
import { useEffect, useState } from "react"
import type { TaskRecord } from "../core/orchestration/tasks.ts"
import type { SessionController } from "../core/session-controller.ts"
import type { BrandPalette } from "./brand.ts"

export function TaskPanel({
  controller,
  palette,
  onClose,
}: {
  controller: SessionController
  palette: BrandPalette
  onClose: () => void
}) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]),
    [selected, setSelected] = useState(0),
    [output, setOutput] = useState(""),
    [error, setError] = useState("")
  useEffect(() => {
    let closed = false,
      busy = false
    const update = async () => {
      if (closed || busy) return
      busy = true
      try {
        const rows = (await controller.tasks({ action: "list" })) as TaskRecord[]
        if (closed) return
        setTasks(rows)
        const current = rows[Math.min(selected, rows.length - 1)]
        if (current) {
          const value = (await controller.tasks({ action: "output", id: current.id, limit: 16384 })) as {
            output: { text: string; end: number }
          }
          const tail =
            value.output.end > 16384
              ? ((await controller.tasks({
                  action: "output",
                  id: current.id,
                  cursor: value.output.end - 16384,
                  limit: 16384,
                })) as { output: { text: string } })
              : value
          if (!closed) setOutput(tail.output.text)
        } else setOutput("No tasks yet. Run !command to start one.")
      } catch (e) {
        if (!closed) setError(e instanceof Error ? e.message : "Task controls failed")
      } finally {
        busy = false
      }
    }
    void update()
    const timer = setInterval(() => {
      void update()
    }, 300)
    return () => {
      closed = true
      clearInterval(timer)
    }
  }, [controller, selected])
  useKeyboard((key) => {
    if (key.ctrl && ["c", "q", "b"].includes(key.name)) return
    key.preventDefault()
    if (key.name === "escape") {
      onClose()
      return
    }
    if (key.name === "up") setSelected((value) => Math.max(0, value - 1))
    if (key.name === "down") setSelected((value) => Math.min(Math.max(0, tasks.length - 1), value + 1))
    if (key.name === "k" && tasks[selected])
      void controller.tasks({ action: "kill", id: tasks[selected]!.id }).catch((e) => setError(String(e)))
  })
  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: 3,
        right: 3,
        bottom: 2,
        backgroundColor: palette.background,
        border: true,
        padding: 1,
        flexDirection: "column",
      }}
    >
      <text fg={palette.accent}>
        <b>Tasks</b>
      </text>
      <text fg={palette.muted}>↑↓ select · K interrupt · Esc close · /tasks stdin ID "text\n"</text>
      <scrollbox style={{ height: "35%" }}>
        {tasks.map((task, index) => (
          <text key={task.id} fg={index === selected ? palette.accent : palette.foreground}>
            {index === selected ? "› " : "  "}
            {task.status} · {task.label.slice(0, 80)} · {task.id}
          </text>
        ))}
      </scrollbox>
      {error && <text fg={palette.destructive}>{error}</text>}
      <scrollbox style={{ flexGrow: 1 }}>
        <text fg={palette.foreground}>{output}</text>
      </scrollbox>
    </box>
  )
}
