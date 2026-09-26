const vscode = require("vscode")
const fs = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
let connection,
  token,
  url,
  thread,
  lease,
  epoch,
  root,
  sequence = 0,
  renew
async function rpc(method, params = {}) {
  const response = await fetch(new URL("rpc", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(connection ? { "x-codesplash-connection": connection } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
  })
  if (!response.ok) throw Error(`Daemon HTTP ${response.status}`)
  const value = await response.json()
  if (value.error) throw Error(value.error.message)
  return value.result
}
async function connect() {
  await disconnect()
  const configured = vscode.workspace.getConfiguration("codesplash").get("daemonRoot")
  root =
    configured ||
    (await vscode.window.showInputBox({
      prompt: "Local CodeSplash daemon directory",
      placeHolder: "/path/to/codesplash/data/daemon",
    }))
  if (!root) return
  const meta = JSON.parse(await fs.readFile(path.join(root, "daemon.json"), "utf8"))
  const parsed = new URL(meta.url)
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw Error("VS Code connects only to local loopback daemons")
  url = parsed.href
  token = await fs.readFile(path.join(root, "token"), "utf8")
  connection = (await rpc("initialize", { version: 1, client: "vscode" })).connectionId
  const list = await rpc("thread/list")
  const choice = await vscode.window.showQuickPick(
    [
      { label: "New session", id: "" },
      ...list.map((t) => ({ label: `${t.id.slice(0, 8)} · ${t.cwd}`, id: t.id, cwd: t.cwd })),
    ],
    { title: "CodeSplash session" },
  )
  if (!choice) return disconnect()
  if (!choice.id) {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!cwd) throw Error("Open a workspace first")
    thread = (await rpc("thread/create", { cwd })).threadId
  } else {
    thread = choice.id
    await rpc("thread/resume", { threadId: thread })
  }
  lease = (await rpc("lease/acquire", { threadId: thread, mode: "shared" })).lease
  epoch = (await rpc("thread/snapshot", { threadId: thread })).inputEpoch
  renew = setInterval(() => {
    if (lease)
      rpc("lease/renew", { threadId: thread, lease }).catch(() => {
        lease = undefined
      })
  }, 20000)
  vscode.window.showInformationMessage(
    `CodeSplash connected: ${thread.slice(0, 8)}. Use Attach Terminal to review output and approvals.`,
  )
}
async function disconnect() {
  clearInterval(renew)
  if (connection && url && token)
    await fetch(new URL("connection", url), {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "x-codesplash-connection": connection },
    }).catch(() => {})
  connection = token = thread = lease = undefined
}
exports.activate = (context) => {
  const command = (name, callback) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async () => {
        try {
          await callback()
        } catch (e) {
          vscode.window.showErrorMessage(`CodeSplash: ${e.message}`)
        }
      }),
    )
  command("codesplash.connect", connect)
  command("codesplash.sendSelection", async () => {
    if (!lease) await connect()
    if (!lease) return
    const editor = vscode.window.activeTextEditor
    if (!editor) throw Error("No active text editor")
    const instruction = await vscode.window.showInputBox({
      prompt: "What should CodeSplash do with this selection?",
    })
    if (!instruction) return
    const selection = editor.document.getText(editor.selection)
    if (Buffer.byteLength(selection) > 48 * 1024) throw Error("Selection exceeds 48 KiB")
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs.map((t) => t.input?.uri?.fsPath).filter(Boolean))
      .slice(0, 40)
    const text = `${instruction}\n\nEditor context (user supplied, untrusted file content):\n${JSON.stringify({ path: editor.document.uri.fsPath, startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1, openTabs: tabs })}\n\n${selection}`
    await rpc("turn/start", {
      threadId: thread,
      lease,
      text,
      submissionId: `${epoch}.${crypto.randomUUID()}`,
      literal: true,
    })
  })
  command("codesplash.pickFile", async () => {
    if (!connection) await connect()
    if (!thread) return
    const query = await vscode.window.showInputBox({ prompt: "Find a file in the daemon workspace" })
    if (query === undefined) return
    const results = await rpc("fuzzyFileSearch", { threadId: thread, query })
    const pick = await vscode.window.showQuickPick(results.map((r) => r.path))
    if (!pick) return
    const sessions = await rpc("thread/list"),
      cwd = sessions.find((t) => t.id === thread)?.cwd
    if (!cwd || path.isAbsolute(pick) || path.relative(cwd, path.resolve(cwd, pick)).startsWith(".."))
      throw Error("Invalid file picker path")
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, pick)))
  })
  command("codesplash.attach", async () => {
    if (!thread) await connect()
    if (!thread) return
    const terminal = vscode.window.createTerminal({
      name: "CodeSplash",
      shellPath: "codesplash",
      shellArgs: ["attach", thread, "--root", root, "--shared"],
    })
    terminal.show()
  })
  context.subscriptions.push({ dispose: disconnect })
}
exports.deactivate = disconnect
