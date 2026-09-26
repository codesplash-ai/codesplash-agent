import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { serve } from "../../src/server/transport.ts"
import { fixture } from "./fixture.ts"

test("bundled VS Code commands share explicit context, pick files and attach the owned native thread", async () => {
  const f = await fixture(),
    daemon = await serve({ ...f.options, port: 0 })
  const commands = new Map<string, () => Promise<void>>(),
    errors: string[] = [],
    opened: string[] = [],
    terminals: any[] = []
  let prompt = "Explain the selection",
    subscriptions: any[] = []
  const vscode = {
    workspace: {
      getConfiguration: () => ({ get: () => f.options.root }),
      workspaceFolders: [{ uri: { fsPath: f.cwd } }],
    },
    commands: {
      registerCommand: (name: string, callback: () => Promise<void>) => {
        commands.set(name, callback)
        return { dispose() {} }
      },
    },
    Uri: { file: (path: string) => path },
    window: {
      showInputBox: async () => prompt,
      showQuickPick: async (values: any[]) => values[0],
      showInformationMessage() {},
      showErrorMessage: (text: string) => errors.push(text),
      showTextDocument: async (path: string) => {
        opened.push(path)
      },
      createTerminal: (options: any) => {
        terminals.push(options)
        return { show() {} }
      },
      activeTextEditor: {
        document: { uri: { fsPath: join(f.cwd, "example.ts") }, getText: () => "@literal reference" },
        selection: { start: { line: 2 }, end: { line: 4 } },
      },
      tabGroups: { all: [{ tabs: [{ input: { uri: { fsPath: join(f.cwd, "example.ts") } } }] }] },
    },
  }
  const exports: any = {},
    require = createRequire(import.meta.url)
  new Function("require", "exports", await readFile(resolve("extensions/vscode/extension.cjs"), "utf8"))(
    (name: string) => (name === "vscode" ? vscode : require(name)),
    exports,
  )
  try {
    await writeFile(join(f.cwd, "example.ts"), "const example = 1")
    exports.activate({ subscriptions })
    await commands.get("codesplash.connect")!()
    await commands.get("codesplash.sendSelection")!()
    const thread = [...daemon.hub.threads.values()][0]!
    for (let i = 0; i < 100 && !thread.events.some((e) => e.kind === "message.completed"); i++)
      await Bun.sleep(10)
    expect(JSON.stringify(thread.events)).toContain("@literal reference")
    expect(JSON.stringify(thread.events)).toContain('startLine\\":3')
    expect(f.calls()).toBe(1)
    prompt = "example"
    await commands.get("codesplash.pickFile")!()
    expect(opened).toEqual([join(f.cwd, "example.ts")])
    await commands.get("codesplash.attach")!()
    expect(terminals[0].shellArgs).toEqual(["attach", thread.id, "--root", f.options.root, "--shared"])
    expect(errors).toEqual([])
  } finally {
    await exports.deactivate()
    await daemon.close()
    await f.clean()
  }
})
