import { type CliRenderer, TextRenderable } from "@opentui/core"
import type { TranscriptItem } from "../core/index.ts"

/** One owner per rendered session; mode changes do not resend completed transcript rows. */
export class TranscriptScrollback {
  readonly emitted = new Set<string>()
  append(renderer: CliRenderer, transcript: readonly TranscriptItem[], thinking: string): void {
    for (const item of transcript) {
      if (item.status === "running" || this.emitted.has(item.id)) continue
      if (item.kind === "reasoning" && thinking === "hide") {
        this.emitted.add(item.id)
        continue
      }
      const content = `[${item.kind}${item.label ? `: ${item.label}` : ""}]\n${item.kind === "reasoning" && thinking === "collapse" ? "Thinking collapsed" : item.text.slice(0, 65536) + (item.text.length > 65536 ? "\n[Truncated in scrollback; use alternate screen to inspect]" : "")}\n`
      renderer.writeToScrollback(({ renderContext, width }) => {
        const height = Math.min(
          4096,
          content
            .split("\n")
            .reduce(
              (sum, line) => sum + Math.max(1, Math.ceil(Bun.stringWidth(line) / Math.max(1, width))),
              0,
            ),
        )
        const root = new TextRenderable(renderContext, { content, width, height, wrapMode: "word" })
        return { root, width, height, trailingNewline: true, teardown: () => root.destroy() }
      })
      this.emitted.add(item.id)
    }
  }
}
