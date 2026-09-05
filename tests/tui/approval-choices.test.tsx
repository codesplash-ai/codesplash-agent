import { describe, expect, test } from "bun:test"
import type { PendingRequest } from "../../src/core/index.ts"
import { approvalChoiceForKey, approvalKeyHint, approvalTagLine } from "../../src/tui/codex-session.tsx"

function approval(choices: string[], alwaysAsk?: boolean): PendingRequest {
  return {
    id: "req-1",
    requestKind: "approval",
    title: "Run bash?",
    detail: "git status",
    choices,
    ...(alwaysAsk === undefined ? {} : { alwaysAsk }),
  }
}

function userInput(choices: string[]): PendingRequest {
  return { id: "req-2", requestKind: "user-input", title: "Pick one", detail: "", choices }
}

describe("approval choice keys", () => {
  test("maps A/S/D/C onto the standard approval choices", () => {
    const request = approval(["accept", "acceptForSession", "decline", "cancel"])
    expect(approvalChoiceForKey("a", request)).toBe("accept")
    expect(approvalChoiceForKey("s", request)).toBe("acceptForSession")
    expect(approvalChoiceForKey("d", request)).toBe("decline")
    expect(approvalChoiceForKey("c", request)).toBe("cancel")
    expect(approvalChoiceForKey("x", request)).toBeUndefined()
  })

  test("P resolves acceptAlways only when the request offers it", () => {
    expect(approvalChoiceForKey("p", approval(["accept", "acceptAlways", "decline", "cancel"]))).toBe(
      "acceptAlways",
    )
    // The dangerous floor never offers acceptAlways; the key must do nothing then.
    expect(approvalChoiceForKey("p", approval(["accept", "decline", "cancel"], true))).toBeUndefined()
  })

  test("keys resolve only choices the request actually offers", () => {
    const bare = approval(["accept", "decline", "cancel"])
    expect(approvalChoiceForKey("s", bare)).toBeUndefined()
    expect(approvalChoiceForKey("k", bare)).toBeUndefined()
  })

  test("plan review maps A to approve and K to keepPlanning", () => {
    const plan = approval(["approve", "keepPlanning", "cancel"])
    expect(approvalChoiceForKey("a", plan)).toBe("approve")
    expect(approvalChoiceForKey("k", plan)).toBe("keepPlanning")
    expect(approvalChoiceForKey("escape", plan)).toBe("cancel")
    // Approval-only keys stay dead on a plan review.
    expect(approvalChoiceForKey("s", plan)).toBeUndefined()
    expect(approvalChoiceForKey("p", plan)).toBeUndefined()
    expect(approvalChoiceForKey("d", plan)).toBeUndefined()
  })

  test("Esc always resolves as cancel, whatever the choices list", () => {
    expect(approvalChoiceForKey("escape", approval(["accept", "decline"]))).toBe("cancel")
    expect(approvalChoiceForKey("escape", userInput(["yes", "no"]))).toBe("cancel")
  })

  test("user-input requests keep the numeric answer keys", () => {
    const request = userInput(["red", "green", "blue"])
    expect(approvalChoiceForKey("2", request)).toBe("green")
    expect(approvalChoiceForKey("c", request)).toBe("cancel")
    expect(approvalChoiceForKey("a", request)).toBeUndefined()
  })
})

describe("approval key hint", () => {
  test("renders the choice list dynamically in request order", () => {
    expect(approvalKeyHint(approval(["accept", "acceptForSession", "decline", "cancel"]))).toBe(
      "A Accept · S Session · D Decline · C Cancel · Esc dismiss",
    )
  })

  test("labels acceptAlways as persisting, only when offered", () => {
    const withAlways = approvalKeyHint(approval(["accept", "acceptAlways", "decline", "cancel"]))
    expect(withAlways).toContain("P Always allow (persists)")
    const dangerous = approvalKeyHint(approval(["accept", "decline", "cancel"], true))
    expect(dangerous).not.toContain("Always allow")
  })

  test("plan review renders approve/keep-planning keys", () => {
    expect(approvalKeyHint(approval(["approve", "keepPlanning", "cancel"]))).toBe(
      "A Approve · K Keep planning · C Cancel · Esc dismiss",
    )
  })

  test("unknown choices fall back to their raw name instead of disappearing", () => {
    expect(approvalKeyHint(approval(["accept", "retryWithSudo"]))).toContain("retryWithSudo")
  })
})

describe("always-ask tag", () => {
  test("dangerous-floor requests carry the tag; ordinary ones do not", () => {
    expect(approvalTagLine(approval(["accept", "decline", "cancel"], true))).toContain("always asks")
    expect(approvalTagLine(approval(["accept", "decline", "cancel"], false))).toBeUndefined()
    expect(approvalTagLine(approval(["accept", "decline", "cancel"]))).toBeUndefined()
  })

  test("the tag explains that the request can never be remembered", () => {
    expect(approvalTagLine(approval(["accept"], true))).toContain("cannot be remembered")
  })
})
