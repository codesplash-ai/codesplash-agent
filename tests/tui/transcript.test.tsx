import { describe, expect, test } from "bun:test"
import { Children, type ReactElement, type ReactNode } from "react"
import type { TranscriptItem } from "../../src/core/index.ts"
import { brandThemes } from "../../src/tui/brand.ts"
import {
  buildTranscriptOutline,
  createScrollbarOptions,
  formatContextRemaining,
  scrollToLatest,
  scrollToTranscriptSection,
  ToolEntry,
} from "../../src/tui/codex-session.tsx"

describe("Codex transcript", () => {
  test("stacks multiline tool output beneath its label at full width", () => {
    const item: TranscriptItem = {
      id: "tool-1",
      kind: "tool",
      label: "A deliberately long command label that used to consume half the row",
      text: "src/first.ts\nsrc/second.ts",
      status: "completed",
    }

    const entry = ToolEntry({ item, palette: brandThemes.light }) as ReactElement<{
      children?: ReactNode
      style?: Record<string, unknown>
    }>
    const children = Children.toArray(entry.props.children) as Array<
      ReactElement<{ children?: ReactNode; style?: Record<string, unknown> }>
    >
    const output = children.find((child) => child.props.style?.width === "100%")

    expect(entry.props.style).toMatchObject({ width: "100%" })
    expect(entry.props.style?.flexDirection).not.toBe("row")
    expect(output?.props.children).toBe("src/first.ts\nsrc/second.ts")
  })

  test("jumps to the bottom and re-enables transcript following", () => {
    const positions: Array<number | { x: number; y: number }> = []
    const scrollbox = {
      stickyScroll: false,
      stickyStart: undefined as "bottom" | "top" | "left" | "right" | undefined,
      scrollTo(position: number | { x: number; y: number }) {
        positions.push(position)
      },
    }

    scrollToLatest(scrollbox)

    expect(scrollbox.stickyScroll).toBe(true)
    expect(scrollbox.stickyStart).toBe("bottom")
    expect(positions).toEqual([{ x: 0, y: Number.MAX_SAFE_INTEGER }])
  })

  test("builds concise outline entries and jumps without sticky scrolling", () => {
    const transcript: TranscriptItem[] = [
      {
        id: "user-1",
        kind: "user",
        text: "Inspect the streaming transcript and explain the flashing",
        status: "completed",
      },
      { id: "reasoning-1", kind: "reasoning", text: "Inspecting", status: "completed" },
      { id: "tool-1", kind: "tool", label: "bun test", text: "", status: "completed" },
      { id: "reasoning-2", kind: "reasoning", text: "Checking output", status: "running" },
      { id: "tool-2", kind: "tool", label: "bun run build", text: "", status: "running" },
      { id: "message-1", kind: "message", text: "Tests pass.", status: "completed" },
      { id: "reasoning-3", kind: "reasoning", text: "Reviewing", status: "completed" },
      { id: "tool-3", kind: "tool", label: "git diff", text: "", status: "completed" },
      { id: "reasoning-4", kind: "reasoning", text: "Finishing", status: "completed" },
      { id: "tool-4", kind: "tool", label: "git status", text: "", status: "completed" },
      { id: "message-2", kind: "message", text: "Done.", status: "completed" },
    ]
    const outline = buildTranscriptOutline(transcript)
    const targets: string[] = []
    const scrollbox = {
      stickyScroll: true,
      scrollChildIntoView(id: string) {
        targets.push(id)
      },
    }

    scrollToTranscriptSection(scrollbox, outline[0]?.anchorId ?? "")

    expect(outline).toEqual([
      {
        id: "user-1",
        anchorId: "transcript:user-1",
        label: "Prompt",
        kind: "user",
        status: "completed",
      },
      {
        id: "reasoning-1",
        anchorId: "transcript:reasoning-1",
        label: "Thinking",
        kind: "reasoning",
        status: "running",
      },
      {
        id: "tool-1",
        anchorId: "transcript:tool-1",
        label: "Tools",
        kind: "tool",
        status: "running",
      },
      {
        id: "message-1",
        anchorId: "transcript:message-1",
        label: "Response",
        kind: "message",
        status: "completed",
      },
      {
        id: "reasoning-3",
        anchorId: "transcript:reasoning-3",
        label: "Thinking",
        kind: "reasoning",
        status: "completed",
      },
      {
        id: "tool-3",
        anchorId: "transcript:tool-3",
        label: "Tools",
        kind: "tool",
        status: "completed",
      },
      {
        id: "message-2",
        anchorId: "transcript:message-2",
        label: "Response",
        kind: "message",
        status: "completed",
      },
    ])
    expect(scrollbox.stickyScroll).toBe(false)
    expect(targets).toEqual(["transcript:user-1"])
  })

  test("themes scrollbar tracks and position indicators", () => {
    expect(createScrollbarOptions(brandThemes.light)).toEqual({
      showArrows: false,
      trackOptions: {
        backgroundColor: brandThemes.light.background,
        foregroundColor: brandThemes.light.accent,
      },
    })
  })

  test("shows only current-context percentage instead of cumulative thread usage", () => {
    expect(
      formatContextRemaining({
        sessionStatus: "ready",
        turnStatus: "idle",
        transcript: [],
        plan: [],
        usage: {
          contextTokens: 25_000,
          totalTokens: 900_000,
          modelContextWindow: 100_000,
        },
        warnings: [],
        lastSequence: 0,
      }),
    ).toBe("75% context left")
  })
})
