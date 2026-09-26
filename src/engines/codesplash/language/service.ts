import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { bytes, digest } from "../../../core/session/files.ts"
import type { HarnessTool, PermissionRuntime, ToolContext, ToolOutcome } from "../contracts.ts"
import type { SandboxRuntime } from "../sandbox/contracts.ts"
import { NativeSandbox } from "../sandbox/runtime.ts"
import { writeFileTool } from "../tools/write.ts"
import { managedCommand, reviewedDescriptors } from "./managed.ts"
import { LanguageRpc } from "./rpc.ts"

const within = (root: string, path: string) => {
  const r = relative(root, path)
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith("../"))
}
type Server = {
  rpc: LanguageRpc
  opened: Map<string, { hash: string; version: number }>
  diagnostics: Map<string, { version?: number; diagnostics: unknown[] }>
}
export class LanguageServices {
  #servers = new Map<string, Promise<Server>>()
  #launches = new Map<string, Promise<{ command: string[]; sandbox: SandboxRuntime; directory?: string }>>()
  async launch(reviewed: Awaited<ReturnType<typeof reviewedDescriptors>>[number], signal: AbortSignal) {
    if (!reviewed.descriptor.download)
      return {
        command: await managedCommand(this.options.root, reviewed, signal),
        sandbox: this.options.sandbox,
      }
    let opening = this.#launches.get(reviewed.fingerprint)
    if (!opening) {
      opening = (async () => {
        const command = await managedCommand(this.options.root, reviewed, signal)
        const directory = await realpath(await mkdtemp(join(tmpdir(), "codesplash-language-")))
        try {
          // Copy only verified executable bytes out of the private store. This process receives
          // an exact read-only executable grant, never access to credentials or session history.
          const executable = join(directory, "server")
          await writeFile(executable, bytes(command[0]!, 256 * 1024 * 1024), { flag: "wx", mode: 0o500 })
          await chmod(directory, 0o700)
          const { hash: _hash, ...parent } = this.options.sandbox.profile
          const profile = {
            ...parent,
            mode: "read-only" as const,
            readRoots: [...parent.readRoots, directory],
            writeRoots: [],
            protectedPaths: [...parent.protectedPaths, directory],
            allowedHosts: [],
            environment: [],
          }
          const sandbox = new NativeSandbox({ ...profile, hash: digest(JSON.stringify(profile)) })
          return { command: [executable, ...command.slice(1)], sandbox, directory }
        } catch (error) {
          await rm(directory, { recursive: true, force: true })
          throw error
        }
      })()
      this.#launches.set(reviewed.fingerprint, opening)
      void opening.catch(() => this.#launches.delete(reviewed.fingerprint))
    }
    return opening
  }
  #lifetime = new AbortController()
  #symbols = new Map<string, { hash: string; result: unknown }>()
  constructor(
    readonly options: {
      root: string
      cwd: string
      sandbox: SandboxRuntime
      permissions: PermissionRuntime
      trusted: boolean
    },
  ) {}
  async file(path: string, tool = "lsp") {
    const absolute = await realpath(resolve(this.options.cwd, path)),
      profile = this.options.sandbox.profile
    if (
      !within(this.options.cwd, absolute) ||
      !profile.readRoots.some((root) => within(root, absolute)) ||
      profile.deniedReadPaths.some((root) => within(root, absolute)) ||
      this.options.permissions.isReadDenied(absolute, tool)
    )
      throw new Error("Language access is outside workspace read policy")
    return {
      path: absolute,
      text: bytes(absolute, 1024 * 1024).toString(),
      uri: pathToFileURL(absolute).href,
    }
  }
  async server(reviewed: Awaited<ReturnType<typeof reviewedDescriptors>>[number], signal: AbortSignal) {
    const key = reviewed.fingerprint
    let opening = this.#servers.get(key)
    if (!opening) {
      opening = (async () => {
        const state: Server = {
          rpc: undefined as unknown as LanguageRpc,
          opened: new Map(),
          diagnostics: new Map(),
        }
        state.rpc = new LanguageRpc((method, raw) => {
          const p = raw as { uri?: string; version?: number; diagnostics?: unknown[] }
          if (
            method === "textDocument/publishDiagnostics" &&
            typeof p?.uri === "string" &&
            state.opened.has(p.uri) &&
            Array.isArray(p.diagnostics)
          )
            state.diagnostics.set(p.uri, { version: p.version, diagnostics: p.diagnostics.slice(0, 100) })
        })
        const launch = await this.launch(reviewed, signal)
        await state.rpc.open(launch.sandbox, launch.command, this.#lifetime.signal)
        try {
          await state.rpc.request(
            "initialize",
            {
              processId: null,
              rootUri: pathToFileURL(this.options.cwd).href,
              capabilities: {
                textDocument: {
                  publishDiagnostics: { versionSupport: true },
                  synchronization: { didSave: true },
                },
              },
              workspaceFolders: [{ uri: pathToFileURL(this.options.cwd).href, name: "workspace" }],
            },
            signal,
          )
          await state.rpc.notify("initialized", {})
          return state
        } catch (error) {
          await state.rpc.close()
          throw error
        }
      })()
      this.#servers.set(key, opening)
      void opening.catch(() => this.#servers.delete(key))
    }
    return opening
  }
  async query(input: unknown, context: ToolContext) {
    if (!this.options.trusted)
      throw new Error("Language services require locally trusted workspace execution")
    const p = input as { path?: unknown; operation?: unknown; line?: unknown; character?: unknown }
    if (
      !p ||
      typeof p.path !== "string" ||
      !["definition", "references", "hover", "diagnostics", "symbols"].includes(p.operation as string) ||
      (p.line !== undefined && (!Number.isSafeInteger(p.line) || Number(p.line) < 0)) ||
      (p.character !== undefined && (!Number.isSafeInteger(p.character) || Number(p.character) < 0))
    )
      throw new Error("Invalid LSP query; positions are zero-based UTF-16")
    const file = await this.file(p.path)
    if (this.options.permissions.decide("lsp", { paths: [file.path] }, true).kind === "deny")
      throw new Error("LSP denied by policy")
    const services = await reviewedDescriptors(this.options.root),
      reviewed = services.find(
        (s) => s.descriptor.kind === "lsp" && s.descriptor.extensions.includes(extname(file.path)),
      )
    if (!reviewed && p.operation === "symbols") {
      const index = services.find(
        (s) => s.descriptor.kind === "tree-sitter" && s.descriptor.extensions.includes(extname(file.path)),
      )
      if (index && this.options.sandbox.executeFixed) {
        const key = `${index.fingerprint}:${file.path}`,
          hash = digest(file.text),
          cached = this.#symbols.get(key)
        if (cached?.hash === hash) return cached.result
        const launch = await this.launch(index, context.signal)
        const command = launch.command.map((a) => a.replaceAll("{file}", file.path))
        const output = await launch.sandbox.executeFixed!(command, "", context.signal, {
          mode: "plan",
          environment: [],
          timeoutMs: 10000,
          writeWorkspace: false,
        })
        if (output.kind !== "success") throw new Error("Tree-sitter query failed")
        if (digest(bytes(file.path, 1024 * 1024)) !== hash) throw new Error("File changed during indexing")
        const result = { backend: "tree-sitter", path: file.path, sha256: hash, captures: output.stdout }
        if (this.#symbols.size >= 1000) this.#symbols.clear()
        this.#symbols.set(key, { hash, result })
        return result
      }
    }
    if (!reviewed)
      throw new Error("No reviewed language server for this extension; use codesplash lsp review/install")
    if (this.options.permissions.decide("lsp", { paths: [file.path] }, true).kind === "deny")
      throw new Error("LSP denied by policy")
    const server = await this.server(reviewed, context.signal),
      previous = server.opened.get(file.uri),
      hash = digest(file.text)
    const version = previous?.hash === hash ? previous.version : (previous?.version ?? 0) + 1
    if (!previous) {
      server.opened.set(file.uri, { hash, version })
      await server.rpc.notify("textDocument/didOpen", {
        textDocument: { uri: file.uri, languageId: reviewed.descriptor.languageId, version, text: file.text },
      })
    } else if (previous.hash !== hash) {
      server.diagnostics.delete(file.uri)
      server.opened.set(file.uri, { hash, version })
      await server.rpc.notify("textDocument/didChange", {
        textDocument: { uri: file.uri, version },
        contentChanges: [{ text: file.text }],
      })
    }
    if (p.operation === "diagnostics") {
      await server.rpc.notify("textDocument/didSave", { textDocument: { uri: file.uri }, text: file.text })
      // Synchronize through a request, then use only diagnostics tagged with the current version.
      await server.rpc
        .request("textDocument/documentSymbol", { textDocument: { uri: file.uri } }, context.signal)
        .catch(() => {})
      if (digest(bytes(file.path, 1024 * 1024)) !== hash)
        throw new Error("File changed during language query; retry")
      const diagnostics = server.diagnostics.get(file.uri)
      return {
        path: file.path,
        version,
        diagnostics: diagnostics?.version === version ? diagnostics.diagnostics : [],
        pending: diagnostics?.version !== version,
        note:
          diagnostics?.version === undefined
            ? "Server has not published versioned diagnostics; stale results are omitted"
            : undefined,
      }
    }
    const key = `${reviewed.fingerprint}:${file.path}`,
      cached = this.#symbols.get(key)
    if (p.operation === "symbols" && cached?.hash === hash) return cached.result
    const method = {
      definition: "textDocument/definition",
      references: "textDocument/references",
      hover: "textDocument/hover",
      symbols: "textDocument/documentSymbol",
    }[p.operation as "definition" | "references" | "hover" | "symbols"]
    const result = await server.rpc.request(
      method,
      {
        textDocument: { uri: file.uri },
        ...(p.operation !== "symbols"
          ? {
              position: { line: p.line ?? 0, character: p.character ?? 0 },
              ...(p.operation === "references" ? { context: { includeDeclaration: true } } : {}),
            }
          : {}),
      },
      context.signal,
    )
    if (digest(bytes(file.path, 1024 * 1024)) !== hash)
      throw new Error("File changed during language query; retry")
    if (p.operation === "symbols") {
      if (this.#symbols.size >= 1000) this.#symbols.clear()
      this.#symbols.set(key, { hash, result })
    }
    return result
  }
  tool(): HarnessTool {
    return {
      name: "lsp",
      description:
        "Query a reviewed managed language server for definitions, references, hover, diagnostics or cached document symbols. Positions use zero-based UTF-16.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          operation: { enum: ["definition", "references", "hover", "diagnostics", "symbols"] },
          line: { type: "integer", minimum: 0 },
          character: { type: "integer", minimum: 0 },
        },
        required: ["path", "operation"],
        additionalProperties: false,
      },
      isReadOnly: () => true,
      permission: () => ({ kind: "none" }),
      permissionTargets: (input, context) => ({
        paths: [resolve(context.cwd, (input as { path: string }).path)],
      }),
      run: async (input, context) => ({
        label: "Language query",
        text: JSON.stringify(await this.query(input, context)).slice(0, 60000),
      }),
    }
  }
  async afterEdit(outcome: ToolOutcome, context: ToolContext): Promise<void> {
    if (!this.options.trusted || !outcome.mutatedPaths?.length || outcome.isError) return
    const services = await reviewedDescriptors(this.options.root)
    if (!services.length) return
    for (const path of outcome.mutatedPaths.slice(0, 20)) {
      try {
        const file = await this.file(path),
          formatter = services.find(
            (s) => s.descriptor.kind === "formatter" && s.descriptor.extensions.includes(extname(file.path)),
          )
        if (
          formatter &&
          this.options.sandbox.executeFixed &&
          context.policy.sandbox === "workspace-write" &&
          this.options.permissions.mode !== "plan" &&
          this.options.permissions.decide("formatter", { paths: [file.path] }, false).kind === "allow" &&
          this.options.permissions.decide("write_file", { paths: [file.path] }, false).kind === "allow"
        ) {
          const launch = await this.launch(formatter, context.signal)
          const command = launch.command.map((a) => a.replaceAll("{file}", file.path))
          const result = await launch.sandbox.executeFixed!(command, file.text, context.signal, {
            mode: "plan",
            environment: [],
            timeoutMs: 10000,
            writeWorkspace: false,
          })
          if (
            Buffer.byteLength(result.stdout) > 128 * 1024 ||
            result.stdout.includes("[output truncated]") ||
            result.stdout.includes("[REDACTED]")
          )
            throw new Error("Formatter output is truncated or redacted; original edit retained")
          if (result.kind !== "success") throw new Error("Formatter failed; original edit retained")
          if (result.stdout !== file.text) {
            if (digest(bytes(file.path, 1024 * 1024)) !== digest(file.text))
              throw new Error("File changed during formatting; formatted output discarded")
            const written = await this.options.sandbox.runTool(
              writeFileTool,
              { path: file.path, content: result.stdout },
              context,
            )
            if (written.isError) throw new Error(written.text)
          }
        }
        if (
          this.options.permissions.decide("lsp", { paths: [file.path] }, true).kind === "allow" &&
          services.some(
            (s) => s.descriptor.kind === "lsp" && s.descriptor.extensions.includes(extname(file.path)),
          )
        )
          outcome.text += `\nLanguage diagnostics: ${JSON.stringify(await this.query({ path, operation: "diagnostics" }, context)).slice(0, 16000)}`
      } catch (e) {
        outcome.text += `\nLanguage service: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
  async close() {
    this.#lifetime.abort()
    for (const promise of this.#servers.values()) {
      const server = await promise.catch(() => undefined)
      await server?.rpc.close()
    }
    this.#servers.clear()
    this.#symbols.clear()
    for (const opening of this.#launches.values()) {
      const launch = await opening.catch(() => undefined)
      if (launch?.directory) {
        await launch.sandbox.close()
        await rm(launch.directory, { recursive: true, force: true })
      }
    }
    this.#launches.clear()
  }
}
