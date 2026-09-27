import type { ChatMessage } from "./contracts.ts"

/** Deliberate session policy; changing submitted images or replacing streamed output is opt-in. */
export type StreamPolicy = {
  stripImagesOn413?: boolean
  partialFallback?: boolean
  detectStreamLoops?: boolean
  retryEmptyResponse?: boolean
  incrementalTools?: boolean
}
export class RepeatedStreamError extends Error {
  constructor() {
    super("Provider stream repeated the same substantial output; stopped by stream policy")
  }
}
/** Detect only exact long suffix loops. No semantic guess about legitimate prose or code. */
export class StreamLoopGuard {
  #tail = ""
  push(text: string): void {
    this.#tail = (this.#tail + text).slice(-32768)
    for (let size = 128; size <= Math.min(4096, this.#tail.length / 8); size++) {
      const suffix = this.#tail.slice(-size)
      if (this.#tail.endsWith(suffix.repeat(8))) throw new RepeatedStreamError()
    }
  }
}
/** Copies wire input; original session attachment history remains intact. */
export function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) =>
      block.type === "image"
        ? {
            type: "text" as const,
            text: "[Image omitted from this provider retry by the explicit stripImagesOn413 policy.]",
          }
        : block,
    ),
  }))
}
