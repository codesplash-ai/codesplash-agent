import { join } from "node:path"
import { assertManagedPolicy } from "../../../core/config/policy.ts"
import { type WorktreeRequest, WorktreeStore } from "../../../core/orchestration/worktrees.ts"
import type { HarnessTool, PermissionMode, ToolContext } from "../contracts.ts"
import { createPermissionRuntime } from "../permissions.ts"
import type { SandboxProfile } from "../sandbox/contracts.ts"
import { contains } from "../sandbox/profile.ts"

export function worktreeInput(raw: unknown): WorktreeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected worktree request")
  const value = raw as WorktreeRequest
  const allowed: Record<string, string[]> = {
    list: ["action"],
    gc: ["action"],
    create: ["action", "base"],
    "pool-fill": ["action", "base", "count"],
    "pool-take": ["action", "base"],
    preview: ["action", "id"],
    remove: ["action", "id"],
    recover: ["action", "id"],
    rollback: ["action", "id"],
    apply: ["action", "id", "fingerprint"],
  }
  if (!allowed[value.action] || Object.keys(value).some((k) => !allowed[value.action]!.includes(k)))
    throw new Error("Invalid worktree request")
  if ("id" in value && (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)))
    throw new Error("Worktree ID required")
  if (
    ["create", "pool-fill", "pool-take"].includes(value.action) &&
    "base" in value &&
    value.base !== undefined &&
    typeof value.base !== "string"
  )
    throw new Error("Invalid base reference")
  if (
    value.action === "pool-fill" &&
    (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 8)
  )
    throw new Error("Pool capacity must be between 1 and 8")
  return structuredClone(value)
}
export async function controlWorktree(store: WorktreeStore, request: WorktreeRequest) {
  switch (request.action) {
    case "list":
      return store.list()
    case "create":
      return store.create(request.base)
    case "pool-fill":
      return store.fillPool(request.count, request.base)
    case "pool-take":
      return store.takePool(request.base)
    case "preview":
      return store.preview(request.id)
    case "apply":
      return store.apply(request.id, request.fingerprint)
    case "remove":
      return store.remove(request.id)
    case "recover":
      return store.recover(request.id)
    case "rollback":
      return store.rollback(request.id)
    case "gc":
      return store.gc()
  }
}
export class NativeWorktrees {
  constructor(
    readonly cwd: string,
    readonly data: string,
    readonly profile: () => SandboxProfile,
    readonly mode: () => PermissionMode,
    readonly trusted: boolean,
    readonly permissionRuntime: () => import("../contracts.ts").PermissionRuntime,
    readonly configuration: () => Promise<import("../../../core/config.ts").AgentConfig>,
  ) {}
  async store() {
    if (!this.trusted) throw new Error("Worktrees require a trusted workspace")
    const config = await this.configuration()
    if (!config.history.enabled) throw new Error("Worktree persistence is disabled by configuration")
    const profile = this.profile(),
      permissions = this.permissionRuntime()
    assertManagedPolicy(config, { ...config.codex, sandbox: profile.mode, permissionMode: permissions.mode })
    const fresh = await createPermissionRuntime({
      cwd: this.cwd,
      workspaceTrusted: this.trusted,
      mode: permissions.mode,
      configRules: config.permissions,
      constraints: config.resolution?.constraints,
    })
    const current = fresh.decide("worktree", undefined, true)
    if (
      current.kind === "deny" ||
      (current.kind === "ask" && permissions.decide("worktree", undefined, true).kind !== "ask")
    )
      throw new Error("Current worktree policy requires permission reload/review")
    const permitted = (tool: string, path: string, readOnly: boolean) =>
      [permissions, fresh].every(
        (runtime) => !["ask", "deny"].includes(runtime.decide(tool, { paths: [path] }, readOnly).kind),
      )
    const store = await WorktreeStore.open(this.cwd, this.data, {
      readable: (path) =>
        profile.readRoots.some((root) => contains(root, path)) &&
        !profile.deniedReadPaths.some((root) => contains(root, path)) &&
        !permissions.isReadDenied(path, "read_file") &&
        permitted("read_file", path, true),
      writable: (path) =>
        permissions.mode !== "plan" &&
        profile.writeRoots.some((root) => contains(root, path)) &&
        !profile.protectedPaths.some((root) => contains(root, path)) &&
        permitted("write_file", path, false),
    })
    if (store.repo !== this.cwd)
      throw new Error("Worktree lifecycle requires a session at the repository root")
    return store
  }
  async select(id: string) {
    const store = await this.store()
    const tree = (await store.list()).find((t) => t.id === id)
    if (!tree || tree.unavailable || tree.status !== "ready")
      throw new Error("Owned worktree is not available")
    return tree
  }
  async claim(id: string) {
    return (await this.store()).claim(id)
  }
  async control(raw: unknown, context: ToolContext) {
    const request = worktreeInput(raw),
      store = await this.store()
    if (!["list", "recover"].includes(request.action)) {
      const profile = this.profile()
      if (
        this.mode() === "plan" ||
        profile.mode !== "workspace-write" ||
        !profile.writeRoots.some((root) => contains(root, store.repo)) ||
        profile.protectedPaths.some((root) => contains(root, store.repo))
      )
        throw new Error("Worktree lifecycle requires the parent's writable repository authority")
      // Host plumbing has a fixed repository scope; it cannot perform a path excluded by policy.
      const target = join(store.repo, ".codesplash-worktrees")
      if (context.permissions?.decide("worktree", { paths: [target] }, false).kind === "deny")
        throw new Error("Worktree lifecycle denied")
    }
    context.signal.throwIfAborted()
    const pending = controlWorktree(store, request)
    context.holdMutationUntil?.(pending)
    const result = await pending
    return { label: "Worktrees", text: JSON.stringify(result) }
  }
  tool(): HarnessTool {
    return {
      name: "worktree",
      alwaysAsk: (raw) => !["list", "recover"].includes((raw as { action: string })?.action),
      description:
        "Manage owned Git worktrees: list/create/pool-fill/pool-take/preview/apply/remove/gc/recover/rollback. Apply requires an exact reviewed fingerprint. Conflicts preserve destination and recovery refs; dirty or active worktrees cannot be removed.",
      effects: "external",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "create",
              "pool-fill",
              "pool-take",
              "preview",
              "apply",
              "remove",
              "gc",
              "recover",
              "rollback",
            ],
          },
          id: { type: "string" },
          base: { type: "string" },
          count: { type: "integer", minimum: 1, maximum: 8 },
          fingerprint: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      isReadOnly: (raw) => ["list", "preview", "recover"].includes(worktreeInput(raw).action),
      permission: (raw) =>
        ["list", "recover"].includes(worktreeInput(raw).action)
          ? { kind: "none" }
          : {
              kind: "approval",
              title: "Manage Git worktree?",
              detail: JSON.stringify(worktreeInput(raw)),
              alwaysAsk: true,
            },
      run: (raw, context) => this.control(raw, context),
    }
  }
}
