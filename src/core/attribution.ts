/** Formatting only. Never commits, pushes, publishes, changes Git identity, or invents human authors. */
export type AttributionPolicy = {
  version: 1
  commit: "off" | "trailer"
  pullRequest: "off" | "footer"
  agent: string
}
export function attributionPolicy(raw: unknown): AttributionPolicy {
  const p = raw as AttributionPolicy
  if (
    p?.version !== 1 ||
    !["off", "trailer"].includes(p.commit) ||
    !["off", "footer"].includes(p.pullRequest) ||
    typeof p.agent !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9 ._/-]{0,79}$/.test(p.agent)
  )
    throw new Error("Invalid attribution policy")
  return { version: 1, commit: p.commit, pullRequest: p.pullRequest, agent: p.agent }
}
export function attributeText(text: string, kind: "commit" | "pr", policy: AttributionPolicy): string {
  const p = attributionPolicy(policy)
  if (Buffer.byteLength(text) > 256 * 1024 || text.includes("\0"))
    throw new Error("Attribution input exceeds bounds")
  const line = kind === "commit" ? `Assisted-by: ${p.agent}` : `AI assistance: ${p.agent}`
  if ((kind === "commit" ? p.commit : p.pullRequest) === "off" || text.split(/\r?\n/).includes(line))
    return text
  return `${text.trimEnd()}\n\n${line}\n`
}
