import { redactSensitiveText } from "../../../core/redaction.ts"
import type { ToolContext } from "../contracts.ts"
import { createPermissionRuntime } from "../permissions.ts"
import { builtinTools } from "../tools/registry.ts"
import { SecretSanitizer } from "./env-policy.ts"

export type WorkerInput = {
  tool: string
  input: unknown
  cwd: string
  policy: ToolContext["policy"]
  rules: { allow: string[]; ask: string[]; deny: string[] }
  redactions?: string[]
}

/** This entry point is executed only inside the OS boundary by the supervisor. */
export async function workerMain(): Promise<void> {
  const bytes = await new Response(Bun.stdin.stream()).arrayBuffer()
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Tool request exceeds 8 MiB")
  const request = JSON.parse(Buffer.from(bytes).toString()) as WorkerInput
  const tool = builtinTools().find((t) => t.name === request.tool)
  if (!tool || ["ask_user", "enter_plan_mode", "exit_plan_mode", "request_permissions"].includes(tool.name))
    throw new Error("Unknown sandbox worker tool")
  const permissions = await createPermissionRuntime({
    cwd: request.cwd,
    mode: request.policy.permissionMode ?? "default",
    workspaceTrusted: false,
    configRules: request.rules,
  })
  const sanitizer = new SecretSanitizer(request.redactions ?? [])
  const clean = (text: string) => redactSensitiveText(sanitizer.redact(text))
  try {
    const outcome = await tool.run(request.input, {
      cwd: request.cwd,
      policy: request.policy,
      permissions,
      signal: new AbortController().signal,
      sanitizeOutput: clean,
    })
    outcome.text = clean(outcome.text)
    outcome.label = clean(outcome.label)
    process.stdout.write(JSON.stringify(outcome))
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        text: clean(error instanceof Error ? error.message : "Tool failed"),
        label: tool.name,
        isError: true,
      }),
    )
  }
}
