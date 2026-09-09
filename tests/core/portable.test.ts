import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BranchStore } from "../../src/core/session/branches.ts"
import { control } from "../../src/core/session/control.ts"
import { digest } from "../../src/core/session/files.ts"
import {
  envelope,
  exportPortable,
  importPortable,
  renderPortable,
  validatePortable,
  writePortable,
} from "../../src/core/session/portable.ts"
import { readSessionEvents, SessionStore } from "../../src/core/sessions.ts"
import { loadTranscript } from "../../src/engines/codesplash/transcript.ts"

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "portable-test-")),
    cwd = join(root, "project"),
    destination = join(root, "destination"),
    sessions = join(root, "sessions")
  mkdirSync(cwd)
  mkdirSync(destination)
  const now = new Date().toISOString(),
    handle = await new SessionStore(sessions).create({
      schemaVersion: 2,
      engine: "codesplash",
      localSessionId: "source",
      projectId: "project",
      projectPath: cwd,
      createdAt: now,
      updatedAt: now,
      lastSequence: -1,
      lastStatus: "closed",
      title: "Portable branches",
    })
  handle.acquire()
  const branches = new BranchStore(handle.state),
    first = branches.capture({
      kind: "base",
      label: "first",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `password=secretvalueverylong ${cwd} person@example.com` }],
        },
      ],
      usage: { estimatedCostUsd: 1 },
      eventSequence: -1,
    })
  const second = branches.capture({
    kind: "turn",
    label: "second",
    messages: [
      ...branches.context(first.id),
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "private reasoning", signature: "opaque" },
          { type: "text", text: "reply" },
        ],
      },
    ],
    usage: { estimatedCostUsd: 2 },
    eventSequence: -1,
  })
  branches.prepareSwitch(first.id, branches.view().revision)
  branches.finishSwitch()
  return {
    root,
    cwd,
    destination,
    sessions,
    handle,
    branches,
    first,
    second,
    close: () => {
      handle.release()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
test("portable current/all branches round-trip with fresh IDs, no authority or billable duplication", async () => {
  const f = await fixture()
  try {
    const selected = await exportPortable(f.branches, f.handle.meta)
    expect(selected.payload.nodes).toHaveLength(1)
    const all = await exportPortable(f.branches, f.handle.meta, { all: true })
    expect(all.payload.nodes).toHaveLength(2)
    expect(JSON.stringify(all)).not.toContain("secretvalueverylong")
    expect(JSON.stringify(all)).not.toContain("private reasoning")
    const preview = await importPortable(f.sessions, all, f.destination)
    expect("duplicate" in preview && preview.duplicate).toBe(false)
    const imported = await importPortable(f.sessions, all, f.destination, true)
    if (!("meta" in imported) || !imported.meta) throw new Error("No imported session")
    const handle = await new SessionStore(f.sessions).open(
      imported.meta.projectId,
      imported.meta.localSessionId,
    )
    const graph = new BranchStore(handle.state)
    expect(graph.view().nodes).toHaveLength(2)
    expect(graph.view().nodes.some((node) => node.id === f.first.id)).toBe(false)
    expect(await loadTranscript(join(handle.directory, "transcript.jsonl"))).toEqual(
      selected.payload.contexts[selected.payload.nodes[0]!.context] ?? [],
    )
    expect(
      (await readSessionEvents(handle.directory)).events.some((event) => event.kind === "usage.updated"),
    ).toBe(false)
    expect(control(handle.directory).state.values.inputQueue).toBeUndefined()
    expect(existsSync(join(handle.directory, "sandbox-profile.json"))).toBe(false)
    expect((await importPortable(f.sessions, all, f.destination, true)).duplicate).toBe(true)
  } finally {
    f.close()
  }
})
test("sharing redaction preserves IDs and viewers keep untrusted markup inert", async () => {
  const f = await fixture()
  try {
    const bundle = await exportPortable(f.branches, f.handle.meta, { redact: true, all: true })
    expect(bundle.payload.nodes[0]?.id).toBe(f.first.id)
    expect(JSON.stringify(bundle)).not.toContain(f.cwd)
    expect(JSON.stringify(bundle)).not.toContain("person@example.com")
    bundle.payload.title = "</title><script>alert(1)</script>"
    const context = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: '```\n<img src="https://secret.example">\n[image](https://secret.example)',
          },
        ],
      },
    ]
    const hash = digest(JSON.stringify(context))
    bundle.payload.contexts = { [hash]: context }
    bundle.payload.nodes = [{ ...bundle.payload.nodes[0]!, context: hash }]
    const modified = envelope(bundle.payload)
    expect(renderPortable(modified, "html")).not.toContain("<script>")
    expect(renderPortable(modified, "html")).not.toContain('<img src="https:')
    expect(renderPortable(modified, "html")).toContain("default-src 'none'")
    expect(renderPortable(modified, "markdown")).toContain("````text")
    const path = join(f.destination, "export.html")
    writePortable(path, renderPortable(modified, "html"))
    expect(() => writePortable(path, "overwrite")).toThrow()
    expect(readFileSync(path, "utf8")).toContain("<!doctype html>")
  } finally {
    f.close()
  }
})
test("portable import rejects malicious ancestry, corrupt blobs, incomplete tool pairs and invalid images", async () => {
  const f = await fixture()
  try {
    const valid = await exportPortable(f.branches, f.handle.meta)
    const changed = structuredClone(valid)
    changed.payload.title = "changed"
    expect(() => validatePortable(changed)).toThrow("checksum")
    const cycle = structuredClone(valid.payload)
    cycle.nodes[0]!.parent = cycle.nodes[0]!.id
    expect(() => validatePortable(envelope(cycle))).toThrow("branch")
    const injected = { ...valid.payload, inputQueue: { execute: true } }
    expect(() => validatePortable(envelope(injected))).toThrow("metadata")
    for (const blocks of [
      [{ type: "tool_call", name: "bash", id: "missing", input: { command: "touch file" } }],
      [
        {
          type: "image",
          mediaType: "image/png",
          base64Data: Buffer.from("not image bytes").toString("base64"),
        },
      ],
    ]) {
      const messages = [{ role: blocks[0]?.type === "image" ? "user" : "assistant", content: blocks }]
      const hash = digest(JSON.stringify(messages)),
        payload = structuredClone(valid.payload)
      payload.nodes[0]!.context = hash
      payload.contexts = { [hash]: messages as never }
      expect(() => validatePortable(envelope(payload))).toThrow()
    }
  } finally {
    f.close()
  }
})
