import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { defaultConfig } from "../../src/core/config.ts"
import type { ToolContext } from "../../src/engines/codesplash/contracts.ts"
import {
  installDescriptor,
  reviewDescriptor,
  reviewedDescriptors,
} from "../../src/engines/codesplash/language/managed.ts"
import { LanguageServices } from "../../src/engines/codesplash/language/service.ts"
import { createPermissionRuntime } from "../../src/engines/codesplash/permissions.ts"
import { createProfile } from "../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../src/engines/codesplash/sandbox/runtime.ts"

test("reviewed LSP runs through the native sandbox, synchronizes versions and rejects changed descriptors", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "m9-lsp-"))),
    services = join(root, "services"),
    path = join(root, "service.json"),
    file = join(root, "example.ts")
  const fixture = resolve("tests/fixtures/m9/lsp.cjs")
  const sandbox = new NativeSandbox(
    createProfile(root, "workspace-write", {
      readRoots: [resolve("tests/fixtures/m9"), process.execPath],
      writeRoots: [root],
    }),
  )
  const permissions = await createPermissionRuntime({
    cwd: root,
    mode: "default",
    workspaceTrusted: true,
    configRules: defaultConfig.permissions,
  })
  const language = new LanguageServices({ root: services, cwd: root, sandbox, permissions, trusted: true })
  const context: ToolContext = {
    cwd: root,
    policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    permissions,
    signal: AbortSignal.timeout(30000),
  }
  try {
    await writeFile(file, "const example = 1\n")
    await writeFile(
      path,
      JSON.stringify({
        id: "fixture",
        languageId: "typescript",
        extensions: [".ts"],
        command: [process.execPath, fixture],
        kind: "lsp",
      }),
    )
    const review = await reviewDescriptor(path)
    await expect(installDescriptor(services, path, "wrong")).rejects.toThrow("changed")
    await installDescriptor(services, path, review.fingerprint)
    const graph = language.workspaceTool()
    await graph.run({ operation: "index", paths: [file], references: true }, context)
    expect(
      JSON.parse((await graph.run({ operation: "query", query: "example" }, context)).text).results[0]
        .references.length,
    ).toBe(1)
    const hover = await language.query({ operation: "hover", path: file }, context)
    expect(JSON.stringify(hover)).toContain("const example = 1")
    const diagnostics = await language.query({ operation: "diagnostics", path: file }, context)
    expect(JSON.stringify(diagnostics)).toContain("fixture diagnostic")
    await writeFile(file, "const updated = 2\n")
    const stale = JSON.parse((await graph.run({ operation: "query", query: "example" }, context)).text)
    expect(stale.results).toEqual([])
    expect(stale.stale).toBe(1)
    expect(JSON.stringify(await language.query({ operation: "hover", path: file }, context))).toContain(
      "updated",
    )
    expect(await language.query({ operation: "diagnostics", path: file }, context)).toMatchObject({
      version: 2,
      diagnostics: [],
      pending: false,
    })
    await expect(language.query({ operation: "hover", path: "/etc/passwd" }, context)).rejects.toThrow(
      "outside",
    )
    const installed = join(services, "fixture.json"),
      changed = await Bun.file(installed).json()
    changed.descriptor.command.push("changed")
    await writeFile(installed, JSON.stringify(changed))
    await expect(reviewedDescriptors(services)).rejects.toThrow("changed after review")
  } finally {
    await language.close()
    await sandbox.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("managed commands bind script bytes, verify downloaded checksums and repair cached executables", async () => {
  const { managedCommand } = await import("../../src/engines/codesplash/language/managed.ts")
  const { digest } = await import("../../src/core/session/files.ts")
  const root = await realpath(await mkdtemp(join(tmpdir(), "m9-download-"))),
    path = join(root, "descriptor.json"),
    script = join(root, "script.cjs")
  const originalFetch = globalThis.fetch
  try {
    await writeFile(script, "console.log('reviewed')")
    await writeFile(
      path,
      JSON.stringify({
        id: "local",
        languageId: "text",
        extensions: [".txt"],
        command: [process.execPath, script],
        kind: "formatter",
      }),
    )
    const reviewed = await reviewDescriptor(path)
    await writeFile(script, "console.log('changed')")
    await expect(managedCommand(root, reviewed, new AbortController().signal)).rejects.toThrow(
      "command file changed",
    )
    const content = Buffer.from("#!/bin/sh\nprintf downloaded")
    await writeFile(
      path,
      JSON.stringify({
        id: "download",
        languageId: "text",
        extensions: [".txt"],
        command: ["{binary}"],
        kind: "formatter",
        download: { url: "https://fixture.invalid/binary", sha256: digest(content) },
      }),
    )
    const download = await reviewDescriptor(path)
    globalThis.fetch = (async () => new Response("tampered")) as unknown as typeof fetch
    await expect(managedCommand(root, download, new AbortController().signal)).rejects.toThrow("checksum")
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(content)
    }) as unknown as typeof fetch
    const [binary] = await managedCommand(root, download, new AbortController().signal)
    expect(calls).toBe(1)
    await writeFile(binary!, "tampered cache")
    await managedCommand(root, download, new AbortController().signal)
    expect(await Bun.file(binary!).text()).toBe(content.toString())
    expect(calls).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test("post-edit formatting runs in the sandbox and explicit ask policy prevents automatic writes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "m9-formatter-"))),
    services = join(root, "services"),
    file = join(root, "text.txt"),
    script = join(root, "format.cjs"),
    descriptor = join(root, "descriptor.json")
  const sandbox = new NativeSandbox(
    createProfile(root, "workspace-write", { readRoots: [process.execPath], writeRoots: [root] }),
  )
  const languages: LanguageServices[] = []
  try {
    await writeFile(script, "process.stdout.write((await new Response(process.stdin).text()).toUpperCase())")
    await writeFile(
      descriptor,
      JSON.stringify({
        id: "formatter",
        languageId: "text",
        extensions: [".txt"],
        command: [process.execPath, script],
        kind: "formatter",
      }),
    )
    await installDescriptor(services, descriptor, (await reviewDescriptor(descriptor)).fingerprint)
    for (const ask of [false, true]) {
      const permissions = await createPermissionRuntime({
        cwd: root,
        mode: "default",
        workspaceTrusted: true,
        configRules: { allow: ["formatter", "write_file"], ask: ask ? ["formatter"] : [], deny: [] },
      })
      const language = new LanguageServices({
        root: services,
        cwd: root,
        sandbox,
        permissions,
        trusted: true,
      })
      languages.push(language)
      await writeFile(file, "hello\n")
      const outcome = { label: "write", text: "written", mutatedPaths: [file] }
      await language.afterEdit(outcome, {
        cwd: root,
        policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
        permissions,
        signal: AbortSignal.timeout(15000),
      })
      expect(outcome.text).not.toContain("failed")
      expect(await Bun.file(file).text()).toBe(ask ? "hello\n" : "HELLO\n")
    }
  } finally {
    for (const language of languages) await language.close()
    await sandbox.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("a downloaded language server launches while its private descriptor/cache directory remains denied", async () => {
  const { digest } = await import("../../src/core/session/files.ts")
  const root = await realpath(await mkdtemp(join(tmpdir(), "m9-managed-lsp-"))),
    services = join(root, "private-services"),
    path = join(root, "server.json"),
    file = join(root, "example.ts")
  const parent = createProfile(root, "workspace-write"),
    { hash: _hash, ...data } = parent
  data.deniedReadPaths.push(services)
  const sandbox = new NativeSandbox({ ...data, hash: digest(JSON.stringify(data)) }),
    originalFetch = globalThis.fetch
  const permissions = await createPermissionRuntime({
    cwd: root,
    mode: "default",
    workspaceTrusted: true,
    configRules: defaultConfig.permissions,
  })
  const language = new LanguageServices({ root: services, cwd: root, sandbox, permissions, trusted: true })
  try {
    const body = Buffer.from(
      `#!${process.execPath}\n${await Bun.file(resolve("tests/fixtures/m9/lsp.cjs")).text()}`,
    )
    await writeFile(
      path,
      JSON.stringify({
        id: "downloaded",
        languageId: "typescript",
        extensions: [".ts"],
        command: ["{binary}"],
        kind: "lsp",
        download: { url: "https://fixture.invalid/lsp", sha256: digest(body) },
      }),
    )
    await installDescriptor(services, path, (await reviewDescriptor(path)).fingerprint)
    globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch
    await writeFile(file, "const downloaded = true")
    const result = await language.query(
      { operation: "hover", path: file },
      {
        cwd: root,
        policy: { sandbox: "workspace-write", approvalPolicy: "on-request" },
        permissions,
        signal: AbortSignal.timeout(15000),
      },
    )
    expect(JSON.stringify(result)).toContain("const downloaded = true")
    expect(sandbox.profile.deniedReadPaths).toContain(services)
    expect(sandbox.profile.readRoots).not.toContain(services)
  } finally {
    globalThis.fetch = originalFetch
    await language.close()
    await sandbox.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
