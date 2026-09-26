// Run with an operator-installed Electron: electron . --daemon-root DIR --workspace DIR
const { app, BrowserWindow, dialog } = require("electron")
const { spawn } = require("node:child_process")
const fs = require("node:fs/promises")
const path = require("node:path")
const argument = (key) => {
  const index = process.argv.indexOf(key)
  return index < 0 ? undefined : process.argv[index + 1]
}
const root = argument("--daemon-root"),
  workspace = argument("--workspace")
let window, sidecar
function localURL(value) {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("Desktop prototype accepts loopback daemon only")
  return url
}

function link(value) {
  const parsed = new URL(value)
  if (
    parsed.protocol !== "codesplash:" ||
    parsed.hostname !== "session" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !/^\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parsed.pathname)
  )
    throw Error("Invalid CodeSplash link")
  return parsed.pathname.slice(1)
}
async function handoff(value) {
  const id = link(value)
  const choice = await dialog.showMessageBox(window, {
    type: "info",
    title: "External session link",
    message: "This link came from an external application. Its sender is not authenticated.",
    detail: `Select local session ${id}? No prompt will be submitted and permissions stay unchanged.`,
    buttons: ["Cancel", "Select session"],
    defaultId: 0,
    cancelId: 0,
  })
  if (choice.response === 1) {
    const url = new URL(window.webContents.getURL())
    url.hash = id
    await window.loadURL(url.href)
  }
}
if (!app.requestSingleInstanceLock()) app.quit()
app.on("open-url", (event, value) => {
  event.preventDefault()
  if (window) handoff(value).catch(() => {})
})
app.on("second-instance", (_, argv) => {
  const value = argv.find((v) => v.startsWith("codesplash://"))
  if (value && window) handoff(value).catch(() => {})
})
app
  .whenReady()
  .then(async () => {
    if (!root || !workspace) throw Error("--daemon-root and --workspace are required")
    if (process.argv.includes("--register-deep-links")) app.setAsDefaultProtocolClient("codesplash")
    let meta
    try {
      meta = JSON.parse(await fs.readFile(path.join(root, "daemon.json"), "utf8"))
      const r = await fetch(localURL(meta.url), { signal: AbortSignal.timeout(1000) })
      if (!r.ok) throw Error("No daemon")
    } catch {
      sidecar = spawn("codesplash", ["serve", "--root", root, "--cwd", workspace], { stdio: "ignore" })
      for (let tries = 0; tries < 40; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        try {
          meta = JSON.parse(await fs.readFile(path.join(root, "daemon.json"), "utf8"))
          if ((await fetch(localURL(meta.url), { signal: AbortSignal.timeout(500) })).ok) break
        } catch {}
      }
    }
    const url = localURL(meta.url)
    window = new BrowserWindow({
      width: 1200,
      height: 850,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin !== url.origin) event.preventDefault()
    })
    await window.loadURL(url.href)
  })
  .catch((error) => {
    dialog.showErrorBox("CodeSplash desktop", error.message)
    app.quit()
  })
// Deliberately leave the independently owned daemon alive so terminal/browser sessions survive handoff.
app.on("window-all-closed", () => app.quit())
