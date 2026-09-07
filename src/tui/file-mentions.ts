export type MentionDraft = { text: string; revision: number; cursor: number }

export function trailingMention(draft: MentionDraft): { query: string; start: number } | undefined {
  if (draft.cursor !== draft.text.length) return undefined
  const match = /(?:^|\s)@(?:"([^"\n]*)|([^\s"`]*))$/.exec(draft.text)
  if (!match) return undefined
  return { query: match[1] ?? match[2] ?? "", start: draft.text.lastIndexOf("@") }
}

/** Recheck draft identity after asynchronous lookup, including edits that were undone. */
export async function completeMentionDraft(
  read: () => MentionDraft,
  lookup: (query: string) => Promise<string[]>,
  apply: (text: string) => void,
  idle: () => boolean,
): Promise<void> {
  const before = read(),
    mention = trailingMention(before)
  if (!mention || !idle()) return
  const [path] = await lookup(mention.query)
  const after = read()
  if (
    !path ||
    !idle() ||
    before.text !== after.text ||
    before.revision !== after.revision ||
    before.cursor !== after.cursor
  )
    return
  apply(`${before.text.slice(0, mention.start)}@${JSON.stringify(path)} `)
}
