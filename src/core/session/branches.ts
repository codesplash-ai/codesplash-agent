import { existsSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { ChatMessage, ContentBlock } from "../../engines/codesplash/contracts.ts"
import type { SessionUsageSnapshot } from "../engine.ts"
import { MemorySessionState, type SessionStateAccess } from "./control.ts"
import { atomic, bytes, component, digest, directory } from "./files.ts"
import { safeSessionText } from "./repository.ts"

export type BranchNode = {
  id: string
  parent?: string
  kind: "base" | "turn" | "before-compaction" | "compaction" | "fork"
  created: string
  label: string
  context?: string
  threadId?: string
  turnId?: string
  eventSequence: number
  eventStart?: number
  usage: SessionUsageSnapshot
  notes?: Record<string, string>
  checkpoint?: string
  promptId?: string
  evidenceTurnIds?: string[]
}
export type BranchGraph = {
  version: 1
  head?: string
  nodes: BranchNode[]
  pins: string[]
  epoch: number
  activeThreadId?: string
  providerFork?: { id: string; node: string; action: "fork" | "rewind"; threadId?: string }
  switch?: { from?: string; to: string }
  origin?: { sessionId: string; nodeId: string; inheritedUsage: SessionUsageSnapshot }
}
export type BranchView = BranchGraph & { revision: string; durable: boolean }
const hashPattern = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9-]{36}$/
const MAX_CONTEXT_BYTES = 64 * 1024 * 1024
const MAX_RETAINED_BYTES = 512 * 1024 * 1024

/** Immutable model context plus a small canonical ancestry/head record. */
export class BranchStore {
  readonly #memory = new Map<string, Buffer>()
  constructor(readonly state: SessionStateAccess = new MemorySessionState()) {}
  view(): BranchView {
    const record = this.state.read()
    const graph = (record.state.values.branches ?? {
      version: 1,
      nodes: [],
      pins: [],
      epoch: 0,
    }) as BranchGraph
    validateBranchGraph(graph)
    return { ...structuredClone(graph), revision: record.revision, durable: this.state.durable }
  }
  node(id?: string): BranchNode {
    const view = this.view(),
      target = id ?? view.head
    const matches = view.nodes.filter(
      (node) => node.id === target || (!!target && node.id.startsWith(target)),
    )
    if (matches.length !== 1) throw new Error("Branch boundary not found or ambiguous; inspect the tree")
    return matches[0] as BranchNode
  }
  ancestry(id?: string): BranchNode[] {
    const result: BranchNode[] = []
    let node: BranchNode | undefined = this.node(id)
    while (node) {
      result.unshift(node)
      node = node.parent ? this.node(node.parent) : undefined
    }
    return result
  }
  context(id?: string): ChatMessage[] {
    const node = this.node(id)
    if (!node.context) throw new Error("Exact native context is unavailable at this provider boundary")
    const source = this.#read(node.context)
    if (digest(source) !== node.context) throw new Error("Retained context checksum mismatch")
    let value: { version: number; messages: unknown }
    try {
      value = JSON.parse(source.toString())
    } catch {
      throw new Error("Invalid retained context")
    }
    if (value.version !== 1 || !validNativeContext(value.messages))
      throw new Error("Invalid retained provider context")
    return value.messages
  }
  capture(
    options: Omit<BranchNode, "id" | "created" | "parent" | "context"> & {
      messages?: readonly ChatMessage[]
      parent?: string
      origin?: BranchGraph["origin"]
      activateThread?: boolean
    },
  ): BranchNode {
    this.#owned()
    const before = this.view()
    if (before.switch) throw new Error("Finish the interrupted head switch before recording another boundary")
    if (before.nodes.length >= 1000)
      throw new Error(
        "Branch graph reached 1,000 boundaries; fork the selected boundary into a new session or prune abandoned branches",
      )
    const { messages, origin, parent, activateThread, ...metadata } = options
    if (parent && !before.nodes.some((node) => node.id === parent)) throw new Error("Unknown branch parent")
    let context: string | undefined
    if (messages) {
      if (!validNativeContext(messages))
        throw new Error("Incomplete provider tool exchange is not a branch boundary")
      const source = Buffer.from(JSON.stringify({ version: 1, messages }))
      if (source.length > MAX_CONTEXT_BYTES) throw new Error("Retained context exceeds 64 MiB")
      context = digest(source)
      this.#write(context, source)
    }
    const node: BranchNode = {
      ...metadata,
      label: safeSessionText(metadata.label).slice(0, 200),
      notes:
        metadata.notes === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(metadata.notes).map(([key, value]) => [
                key,
                safeSessionText(value).slice(0, 4096),
              ]),
            ),
      id: crypto.randomUUID(),
      created: new Date().toISOString(),
      parent: parent ?? before.head,
      context,
    }
    this.#update(before.revision, "capture", (graph) => {
      graph.nodes.push(node)
      graph.head = node.id
      if (origin) graph.origin = origin
      if (activateThread) {
        graph.activeThreadId = node.threadId
        graph.epoch++
      }
    })
    return node
  }
  beginProviderFork(node: string, action: "fork" | "rewind"): string {
    const id = crypto.randomUUID()
    this.#update(this.view().revision, "provider-fork-start", (graph) => {
      if (graph.providerFork) throw new Error("A previous provider fork requires review; inspect the tree")
      graph.providerFork = { id, node, action }
    })
    return id
  }
  providerForkResponse(id: string, threadId: string): void {
    this.#update(this.view().revision, "provider-fork-response", (graph) => {
      if (graph.providerFork?.id !== id) throw new Error("Provider fork receipt changed")
      graph.providerFork.threadId = threadId
    })
  }
  acknowledgeProviderFork(id: string, revision: string): void {
    this.#update(revision, "provider-fork-acknowledge", (graph) => {
      if (graph.providerFork?.id !== id) throw new Error("Provider fork receipt changed")
      delete graph.providerFork
    })
  }
  prepareSwitch(id: string, revision: string): BranchNode {
    const node = this.node(id)
    this.#update(revision, "switch-prepare", (graph) => {
      if (graph.switch) throw new Error("A head switch already requires recovery")
      graph.switch = { from: graph.head, to: node.id }
    })
    return node
  }
  finishSwitch(): void {
    this.#update(this.view().revision, "switch-finish", (graph) => {
      if (!graph.switch) throw new Error("No pending head switch")
      graph.head = graph.switch.to
      graph.epoch++
      delete graph.switch
    })
  }
  cancelSwitch(): void {
    this.#update(this.view().revision, "switch-cancel", (graph) => {
      delete graph.switch
    })
  }
  pin(id: string, pinned: boolean, revision: string): void {
    const node = this.node(id)
    this.#update(revision, "pin", (graph) => {
      graph.pins = graph.pins.filter((id) => id !== node.id)
      if (pinned) graph.pins.push(node.id)
    })
  }
  /** Explicit abandoned-branch deletion; head ancestry and pins always remain roots. */
  prune(ids: string[], revision: string): { removed: string[]; bytes: number } {
    const before = this.view(),
      requested = new Set(ids.map((id) => this.node(id).id)),
      protectedIds = new Set<string>()
    for (const root of [before.head, ...before.pins]) {
      let node = root ? this.node(root) : undefined
      while (node) {
        protectedIds.add(node.id)
        node = node.parent ? this.node(node.parent) : undefined
      }
    }
    if (
      before.switch ||
      before.providerFork ||
      requested.size === 0 ||
      [...requested].some((id) => protectedIds.has(id))
    )
      throw new Error("Only explicitly selected abandoned, unpinned branches can be pruned")
    for (const node of before.nodes)
      if (node.parent && requested.has(node.parent) && !requested.has(node.id))
        throw new Error("Select the entire abandoned descendant branch before pruning")
    this.#update(revision, "prune", (graph) => {
      graph.nodes = graph.nodes.filter((node) => !requested.has(node.id))
    })
    const retained = new Set(
      this.view()
        .nodes.map((node) => node.context)
        .filter(Boolean),
    )
    let removedBytes = 0
    for (const hash of new Set(
      before.nodes.filter((node) => requested.has(node.id)).map((node) => node.context),
    )) {
      if (!hash || retained.has(hash)) continue
      const source = this.#read(hash)
      removedBytes += source.length
      if (this.state.directory) unlinkSync(join(this.state.directory, "branches", `${hash}.json`))
      else this.#memory.delete(hash)
    }
    return { removed: [...requested], bytes: removedBytes }
  }
  collect(revision: string): number {
    this.#owned()
    const view = this.view()
    if (view.revision !== revision || view.switch || view.providerFork)
      throw new Error("Session changed or branch recovery is pending")
    const retained = new Set(view.nodes.map((node) => node.context))
    let reclaimed = 0
    if (!this.state.directory) {
      for (const [hash, source] of this.#memory)
        if (!retained.has(hash)) {
          reclaimed += source.length
          this.#memory.delete(hash)
        }
    } else {
      const root = join(this.state.directory, "branches")
      if (existsSync(root))
        for (const name of readdirSync(root)) {
          if (!/^[a-f0-9]{64}\.json$/.test(name) || retained.has(name.slice(0, -5))) continue
          reclaimed += bytes(join(root, name), MAX_CONTEXT_BYTES).length
          unlinkSync(join(root, name))
        }
    }
    return reclaimed
  }
  #owned(): void {
    if (this.state.durable) {
      if (!this.state.directory || !this.state.assertOwned)
        throw new Error("Branch storage requires owned canonical assets")
      this.state.assertOwned()
    }
  }
  #read(hash: string): Buffer {
    if (!hashPattern.test(hash)) throw new Error("Invalid context reference")
    const source = this.state.directory
      ? bytes(join(this.state.directory, "branches", `${hash}.json`), MAX_CONTEXT_BYTES)
      : this.#memory.get(hash)
    if (!source) throw new Error("Retained context is missing")
    return source
  }
  #write(hash: string, source: Buffer): void {
    if (!this.state.directory) {
      if (
        !this.#memory.has(hash) &&
        [...this.#memory.values()].reduce((sum, value) => sum + value.length, 0) + source.length >
          MAX_RETAINED_BYTES
      )
        throw new Error("Retained context exceeds 512 MiB")
      this.#memory.set(hash, source)
      return
    }
    const root = join(this.state.directory, "branches"),
      path = join(root, `${hash}.json`)
    directory(root, true)
    if (existsSync(path)) {
      if (digest(bytes(path, MAX_CONTEXT_BYTES)) !== hash) throw new Error("Existing context blob is corrupt")
      return
    }
    const size = readdirSync(root)
      .filter((name) => name.endsWith(".json"))
      .reduce((sum, name) => sum + bytes(join(root, component(name)), MAX_CONTEXT_BYTES).length, 0)
    if (size + source.length > MAX_RETAINED_BYTES) throw new Error("Retained context exceeds 512 MiB")
    atomic(path, source)
  }
  #update(revision: string, operation: string, change: (graph: BranchGraph) => void): void {
    this.#owned()
    this.state.update(revision, `branches/${operation}`, (state) => {
      const graph = (state.values.branches ?? { version: 1, nodes: [], pins: [], epoch: 0 }) as BranchGraph
      change(graph)
      validateBranchGraph(graph)
      state.values.branches = graph
    })
  }
}

/** Exact native shape, with complete tool/result exchanges; no redaction of opaque blocks. */
export function validNativeContext(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length > 100000) return false
  const pending = new Set<string>()
  for (const message of value) {
    if (!message || !["user", "assistant"].includes(message.role) || !Array.isArray(message.content))
      return false
    if (message.role === "assistant" && pending.size) return false
    for (const block of message.content as ContentBlock[]) {
      if (!block || typeof block !== "object") return false
      switch (block.type) {
        case "text":
          if (typeof block.text !== "string") return false
          break
        case "thinking":
          if (
            message.role !== "assistant" ||
            typeof block.text !== "string" ||
            (block.signature !== undefined && typeof block.signature !== "string")
          )
            return false
          break
        case "redacted_thinking":
          if (message.role !== "assistant" || typeof block.data !== "string") return false
          break
        case "image":
          if (
            message.role !== "user" ||
            !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mediaType) ||
            typeof block.base64Data !== "string"
          )
            return false
          break
        case "tool_call":
          if (
            message.role !== "assistant" ||
            typeof block.id !== "string" ||
            !block.id ||
            pending.has(block.id) ||
            typeof block.name !== "string" ||
            !("input" in block)
          )
            return false
          pending.add(block.id)
          break
        case "tool_result":
          if (
            message.role !== "user" ||
            !pending.delete(block.toolCallId) ||
            typeof block.text !== "string" ||
            (block.isError !== undefined && typeof block.isError !== "boolean")
          )
            return false
          break
        default:
          return false
      }
    }
    if (message.role === "user" && pending.size) return false
  }
  return pending.size === 0
}

export function validateBranchGraph(graph: BranchGraph): void {
  if (
    graph.version !== 1 ||
    !Array.isArray(graph.nodes) ||
    graph.nodes.length > 1000 ||
    !Array.isArray(graph.pins) ||
    !Number.isSafeInteger(graph.epoch) ||
    graph.epoch < 0
  )
    throw new Error("Unsupported or corrupt branch graph")
  if (
    graph.origin &&
    (typeof graph.origin.sessionId !== "string" ||
      !graph.origin.sessionId ||
      graph.origin.sessionId.length > 256 ||
      typeof graph.origin.nodeId !== "string" ||
      !uuid.test(graph.origin.nodeId) ||
      !graph.origin.inheritedUsage ||
      Object.values(graph.origin.inheritedUsage).some(
        (value) =>
          typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value) || value < 0),
      ))
  )
    throw new Error("Invalid branch origin")
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (
      !node ||
      !uuid.test(node.id) ||
      ids.has(node.id) ||
      (node.parent && !ids.has(node.parent)) ||
      !["base", "turn", "before-compaction", "compaction", "fork"].includes(node.kind) ||
      (node.promptId !== undefined && (typeof node.promptId !== "string" || node.promptId.length > 256)) ||
      (node.evidenceTurnIds !== undefined &&
        (!Array.isArray(node.evidenceTurnIds) ||
          node.evidenceTurnIds.length > 1000 ||
          node.evidenceTurnIds.some((id) => typeof id !== "string" || id.length > 256))) ||
      typeof node.created !== "string" ||
      !Number.isFinite(Date.parse(node.created)) ||
      typeof node.label !== "string" ||
      node.label.length > 200 ||
      !Number.isSafeInteger(node.eventSequence) ||
      node.eventSequence < -1 ||
      (node.eventStart !== undefined &&
        (!Number.isSafeInteger(node.eventStart) ||
          node.eventStart < 0 ||
          node.eventStart > node.eventSequence + 1)) ||
      (node.context !== undefined && !hashPattern.test(node.context)) ||
      (node.threadId !== undefined && (typeof node.threadId !== "string" || node.threadId.length > 256)) ||
      (node.turnId !== undefined && (typeof node.turnId !== "string" || node.turnId.length > 256)) ||
      !node.usage ||
      typeof node.usage !== "object" ||
      Object.values(node.usage).some(
        (value) =>
          typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value) || value < 0),
      ) ||
      (node.notes !== undefined &&
        (typeof node.notes !== "object" ||
          Array.isArray(node.notes) ||
          Object.entries(node.notes).length > 16 ||
          Object.entries(node.notes).some(
            ([key, value]) =>
              !/^[a-z0-9][a-z0-9-]{0,63}$/.test(key) || typeof value !== "string" || value.length > 4096,
          )))
    )
      throw new Error("Invalid branch node")
    ids.add(node.id)
  }
  if (
    (graph.providerFork !== undefined &&
      (!uuid.test(graph.providerFork.id) ||
        !ids.has(graph.providerFork.node) ||
        !["fork", "rewind"].includes(graph.providerFork.action) ||
        (graph.providerFork.threadId !== undefined &&
          (typeof graph.providerFork.threadId !== "string" ||
            !graph.providerFork.threadId ||
            graph.providerFork.threadId.length > 256)))) ||
    (graph.activeThreadId !== undefined &&
      (typeof graph.activeThreadId !== "string" ||
        !graph.activeThreadId ||
        graph.activeThreadId.length > 256)) ||
    (graph.head && !ids.has(graph.head)) ||
    graph.pins.some((id) => !ids.has(id)) ||
    (graph.switch && (!ids.has(graph.switch.to) || graph.switch.from !== graph.head))
  )
    throw new Error("Invalid selected branch or pending switch")
}
