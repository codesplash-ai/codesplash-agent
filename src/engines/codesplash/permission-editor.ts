import { chmod, mkdir, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isValidPermissionRule, loadConfig, type PermissionsConfig, saveConfig } from "../../core/config.ts"
import { stringifyToml } from "../../core/toml.ts"
import type { ParsedPermissionRule } from "./permissions.ts"

export type PermissionEdit = {
  operation: "add" | "delete" | "replace"
  source: "user" | "project" | "grants"
  action: "allow" | "ask" | "deny"
  rule: string
  replacement?: string
}
export function parsePermissionEdit(text: string): PermissionEdit {
  const match = /^(add|delete|replace)\s+(user|project|grants)\s+(allow|ask|deny)\s+(.+)$/.exec(text.trim())
  if (!match)
    throw new Error(
      "Use /permissions add|delete|replace user|project|grants allow|ask|deny tool(pattern); replace uses old => new",
    )
  const [rule, replacement, ...extra] = (match[4] ?? "").split(" => ")
  const edit: PermissionEdit = {
    operation: match[1] as PermissionEdit["operation"],
    source: match[2] as PermissionEdit["source"],
    action: match[3] as PermissionEdit["action"],
    rule: rule ?? "",
    replacement,
  }
  if (
    !isValidPermissionRule(edit.rule) ||
    extra.length ||
    (edit.operation === "replace"
      ? !edit.replacement || !isValidPermissionRule(edit.replacement)
      : replacement !== undefined) ||
    (edit.source === "grants" && edit.action !== "allow")
  )
    throw new Error("Invalid permission edit; remembered grants support allow rules only")
  return edit
}

export async function editPermissionRule(
  edit: PermissionEdit,
  options: { cwd: string; trusted: boolean; grantsPath?: string; userConfigPath?: string },
): Promise<PermissionsConfig | undefined> {
  // Revalidate structured callers, not just slash-command parsing.
  parsePermissionEdit(
    `${edit.operation} ${edit.source} ${edit.action} ${edit.rule}${edit.replacement ? ` => ${edit.replacement}` : ""}`,
  )
  if (edit.source === "project" && !options.trusted)
    throw new Error("Trust this workspace before editing its project rules")
  function apply(rules: string[]): string[] {
    if (edit.operation !== "add" && !rules.includes(edit.rule))
      throw new Error("Rule does not exist in the selected source/action")
    return [
      ...new Set(
        edit.operation === "add"
          ? [...rules, edit.rule]
          : rules.flatMap((r) =>
              r === edit.rule
                ? edit.operation === "replace" && edit.replacement
                  ? [edit.replacement]
                  : []
                : [r],
            ),
      ),
    ]
  }
  if (edit.source === "user") {
    const config = await loadConfig(options.userConfigPath)
    config.permissions[edit.action] = apply(config.permissions[edit.action])
    await saveConfig(config, options.userConfigPath)
    return config.permissions
  }
  const path =
    edit.source === "project" ? join(options.cwd, ".codesplash", "permissions.toml") : options.grantsPath
  if (!path) throw new Error("No remembered-grants file is configured")
  let table: Record<string, unknown> = {}
  try {
    table = Bun.TOML.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch (e) {
    if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ENOENT")
      throw new Error("Cannot edit an unreadable or invalid permission file")
  }
  const rules: { allow: string[]; ask: string[]; deny: string[] } = { allow: [], ask: [], deny: [] }
  for (const key of ["allow", "ask", "deny"] as const) {
    if (
      table[key] !== undefined &&
      (!Array.isArray(table[key]) ||
        (table[key] as unknown[]).some((s) => typeof s !== "string" || !isValidPermissionRule(s)))
    )
      throw new Error("Cannot edit invalid permission rules")
    rules[key] = (table[key] as string[] | undefined) ?? []
  }
  if (Object.keys(table).some((k) => !["allow", "ask", "deny"].includes(k)))
    throw new Error("Permission file has unsupported fields; edit it manually to preserve them")
  rules[edit.action] = apply(rules[edit.action])
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  await Bun.write(tmp, stringifyToml(edit.source === "grants" ? { allow: rules.allow } : rules))
  await chmod(tmp, 0o600)
  await rename(tmp, path)
  return undefined
}

/** Only report provable syntactic shadowing, not speculative shell/glob subsumption. */
export function ruleConflict(
  rule: ParsedPermissionRule,
  all: readonly ParsedPermissionRule[],
): string | undefined {
  const strength = { allow: 0, ask: 1, deny: 2 }
  const higher = all.find(
    (other) =>
      other.source !== "builtin" &&
      other.tool === rule.tool &&
      strength[other.action] > strength[rule.action] &&
      (other.pattern === undefined || other.pattern === rule.pattern),
  )
  return higher ? `${higher.action} ${higher.raw} (${higher.source}) takes precedence` : undefined
}
