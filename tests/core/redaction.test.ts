import { describe, expect, test } from "bun:test"
import { redactSensitiveText } from "../../src/core/redaction.ts"

describe("redactSensitiveText", () => {
  test("removes authorization headers, credential assignments, keys, and sensitive env values", () => {
    const result = redactSensitiveText(
      "Authorization: Bearer abc.def.ghi token=my-token sk-example123456789 env-secret-value",
      { SERVICE_TOKEN: "env-secret-value" },
    )

    expect(result).toContain("Authorization: [REDACTED]")
    expect(result).toContain("token=[REDACTED]")
    expect(result).not.toContain("abc.def.ghi")
    expect(result).not.toContain("my-token")
    expect(result).not.toContain("sk-example123456789")
    expect(result).not.toContain("env-secret-value")
  })
})
