import { expect, test } from "bun:test"
import { completeMentionDraft, type MentionDraft, trailingMention } from "../../src/tui/file-mentions.ts"

test("completion encodes spaces and refuses literal emails or a cursor in the middle", async () => {
  let draft: MentionDraft = { text: "Read @src", revision: 1, cursor: 9 }
  await completeMentionDraft(
    () => draft,
    async () => ["src/a b.ts"],
    (text) => {
      draft = { ...draft, text }
    },
    () => true,
  )
  expect(draft.text).toBe('Read @"src/a b.ts" ')
  expect(trailingMention({ text: "email a@b", revision: 0, cursor: 9 })).toBeUndefined()
  expect(trailingMention({ text: "Read @src", revision: 0, cursor: 2 })).toBeUndefined()
})

test("late completion cannot overwrite an edited, undone, moved or submitted draft", async () => {
  for (const change of ["edited", "undone", "moved", "submitted"]) {
    let draft: MentionDraft = { text: "@src", revision: 1, cursor: 4 },
      idle = true,
      writes = 0
    let finish: (paths: string[]) => void = () => {}
    const pending = completeMentionDraft(
      () => draft,
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      () => {
        writes++
      },
      () => idle,
    )
    if (change === "edited") draft = { text: "@other", revision: 2, cursor: 6 }
    if (change === "undone") draft = { ...draft, revision: 3 }
    if (change === "moved") draft = { ...draft, cursor: 0 }
    if (change === "submitted") idle = false
    finish(["src/a.ts"])
    await pending
    expect(writes).toBe(0)
  }
})
