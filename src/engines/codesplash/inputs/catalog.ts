import { basename, resolve } from "node:path"
import type { ContextInputConfig, Resource, ResourceCatalog } from "./contracts.ts"
import { RESOURCE_NAME } from "./contracts.ts"
import { frontmatter } from "./syntax.ts"

export function resourceCandidate(
  path: string,
  user: boolean,
  config: ContextInputConfig,
): Omit<Resource, "description"> | undefined {
  const source = user
    ? "user"
    : path.startsWith(".claude/")
      ? "claude"
      : path.startsWith(".cursor/")
        ? "cursor"
        : path.startsWith(".agents/")
          ? "shared"
          : "project"
  if (path === "AGENTS.md" || (!user && path === "CLAUDE.md" && config.claudeRules !== false))
    return { kind: "rule", name: path, path, source }
  if (!user && source === "cursor" && config.cursorRules && /^\.cursor\/rules\/[^/]+\.mdc$/.test(path))
    return { kind: "rule", name: basename(path), path, source }
  const commandRoot = user
    ? "commands"
    : source === "claude" && config.claudeCommands
      ? ".claude/commands"
      : ".codesplash/commands"
  if (
    path.startsWith(`${commandRoot}/`) &&
    path.endsWith(".md") &&
    !path.slice(commandRoot.length + 1).includes("/")
  )
    return { kind: "command", name: basename(path, ".md"), path, source }
  const skillRoot = user
    ? "skills"
    : source === "claude" && config.claudeSkills
      ? ".claude/skills"
      : source === "shared" && config.sharedSkills
        ? ".agents/skills"
        : ".codesplash/skills"
  if (path.startsWith(`${skillRoot}/`) && /^[^/]+\/SKILL\.md$/.test(path.slice(skillRoot.length + 1)))
    return { kind: "skill", name: path.slice(skillRoot.length + 1).split("/")[0] ?? "", path, source }
  return undefined
}

export function resourceMetadata(
  candidate: Omit<Resource, "description">,
  text: string,
): Resource | undefined {
  const { fields, body } = frontmatter(text)
  if (candidate.source === "cursor" && fields.alwaysApply !== true) return undefined
  if (candidate.kind === "rule") return { ...candidate, description: "Project instructions" }
  if (!RESOURCE_NAME.test(candidate.name)) throw new Error(`Invalid resource name: ${candidate.name}`)
  if (candidate.kind === "command" && Buffer.byteLength(body) > 16 * 1024)
    throw new Error("Command exceeds 16 KiB")
  if (candidate.kind === "skill") {
    if (fields.name !== undefined && fields.name !== candidate.name)
      throw new Error("Skill name must match its directory")
    if (
      typeof fields.description !== "string" ||
      !fields.description.trim() ||
      fields.description.length > 1024
    )
      throw new Error("Skill requires a description of 1–1024 characters")
    if (Buffer.byteLength(body) > 6 * 1024) throw new Error("Skill body exceeds 6 KiB")
    if (
      fields["disable-model-invocation"] !== undefined &&
      typeof fields["disable-model-invocation"] !== "boolean"
    )
      throw new Error("disable-model-invocation must be a boolean")
    if (fields.context !== undefined && fields.context !== "fork")
      throw new Error("Unsupported skill context")
  }
  return {
    ...candidate,
    description: typeof fields.description === "string" ? fields.description.slice(0, 1024) : candidate.name,
    disabled: fields["disable-model-invocation"] === true,
    fork: fields.context === "fork",
  }
}

export async function catalogSources(
  sources: Array<{ root: string; user: boolean; paths: string[] }>,
  config: ContextInputConfig,
  read: (root: string, path: string, user: boolean) => Promise<string>,
): Promise<ResourceCatalog> {
  const resources: Resource[] = [],
    diagnostics: string[] = []
  for (const { root, user, paths } of sources) {
    for (const path of paths) {
      if (path === "CLAUDE.md" && paths.includes("AGENTS.md")) continue
      const candidate = resourceCandidate(path, user, config)
      if (!candidate) continue
      // Reading is outside syntax recovery: a denied/failed read stops preparation.
      const text = await read(root, path, user)
      try {
        const resource = resourceMetadata(candidate, text)
        if (resource) resources.push({ ...resource, path: resolve(root, path) })
        else diagnostics.push(`Inactive resource: ${resolve(root, path)}`)
      } catch (error) {
        diagnostics.push(`${resolve(root, path)}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const priority = (r: Resource) => (r.source === "project" ? 0 : r.source === "user" ? 1 : 2)
  resources.sort(
    (a, b) =>
      priority(a) - priority(b) ||
      (a.kind === "rule" && b.kind === "rule"
        ? a.path.split("/").length - b.path.split("/").length
        : a.name.localeCompare(b.name)) ||
      a.path.localeCompare(b.path),
  )
  const winners: Resource[] = [],
    names = new Map<string, Resource>()
  for (const resource of resources) {
    const key = `${resource.kind}:${resource.name}`
    const previous = names.get(key)
    if (previous && resource.kind !== "rule")
      diagnostics.push(`${resource.path} shadowed by ${previous.path}`)
    else {
      winners.push(resource)
      names.set(key, resource)
    }
  }
  return { resources: winners, diagnostics }
}
