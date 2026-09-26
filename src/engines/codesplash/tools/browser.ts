import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Browser, Page } from "playwright-core"
import type { HarnessTool, ToolContext } from "../contracts.ts"
import { ToolInputError } from "../contracts.ts"
import { childEnvironment } from "../sandbox/env-policy.ts"
import { startNetworkBroker } from "../sandbox/network-broker.ts"

/** Owns a fresh browser, never the operator's profile. All page traffic uses the native DNS broker. */
export class BrowserTools {
  #browser?: Browser
  #page?: Page
  #broker?: Awaited<ReturnType<typeof startNetworkBroker>>
  #closed = false
  constructor(
    readonly allowedHosts: readonly string[],
    readonly origins: readonly string[],
    readonly executable: string | undefined = process.env.CODESPLASH_BROWSER_EXECUTABLE,
    readonly allowLoopback = true,
  ) {}
  #url(value: string): URL {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !this.origins.includes(url.origin)
    )
      throw new ToolInputError("Browser origin is not in the operator's allowlist")
    return url
  }
  #checkNetwork(context: ToolContext, value: string) {
    const url = this.#url(value)
    if (!this.allowLoopback && ["127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Managed host policy refuses loopback browser access")
    if (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && this.allowLoopback)
      return
    context.checkNetwork?.(value)
  }
  async #open(context: ToolContext): Promise<Page> {
    if (this.#closed) throw new ToolInputError("Browser owner closed")
    if (this.#page) return this.#page
    if (!this.executable)
      throw new ToolInputError("Set CODESPLASH_BROWSER_EXECUTABLE to an installed Chromium browser")
    this.#broker = await startNetworkBroker([...this.allowedHosts], {
      loopbackOrigins: this.origins.filter((origin) => {
        const url = new URL(origin)
        return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
      }),
    })
    try {
      const module = import.meta.url.includes("/$bunfs/")
        ? pathToFileURL(join(dirname(process.execPath), "sandbox-runtime", "playwright-core", "index.mjs"))
            .href
        : "playwright-core"
      const { chromium } = (await import(module)) as typeof import("playwright-core")
      const proxy = new URL(this.#broker.url)
      this.#browser = await chromium.launch({
        executablePath: this.executable,
        headless: true,
        chromiumSandbox: true,
        timeout: 15000,
        env: childEnvironment(context.cwd),
        proxy: {
          server: proxy.origin,
          username: decodeURIComponent(proxy.username),
          password: decodeURIComponent(proxy.password),
        },
        args: [
          "--proxy-bypass-list=<-loopback>",
          "--disable-extensions",
          "--disable-features=WebRtcAllowInputVolumeAdjustment",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      })
      const browserContext = await this.#browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
        permissions: [],
        viewport: { width: 1280, height: 800 },
      })
      browserContext.setDefaultTimeout(5000)
      await browserContext.route("**/*", async (route) => {
        try {
          this.#checkNetwork(context, route.request().url())
          await route.continue()
        } catch {
          await route.abort()
        }
      })
      await browserContext.routeWebSocket("**/*", (socket) => socket.close())
      this.#page = await browserContext.newPage()
      browserContext.on("page", (page) => {
        if (page !== this.#page) void page.close()
      })
      this.#page.on("dialog", (dialog) => void dialog.dismiss())
      this.#page.on("download", (download) => void download.cancel())
      if (this.#closed) {
        await this.#browser.close()
        throw new ToolInputError("Browser closed during launch")
      }
      return this.#page
    } catch (error) {
      await this.close()
      throw error
    }
  }
  tool(): HarnessTool {
    return {
      name: "browser",
      description:
        "Use an isolated Chromium page within operator-allowed origins. Snapshot, screenshot, navigate, click/type by selector or mouse coordinates, and key input. No arbitrary page code, downloads, external profiles or popups.",
      effects: "external",
      allowPersistentApproval: false,
      inputSchema: {
        type: "object",
        properties: {
          action: { enum: ["open", "snapshot", "screenshot", "click", "type", "key", "mouse"] },
          url: { type: "string" },
          selector: { type: "string", maxLength: 512 },
          text: { type: "string", maxLength: 4096 },
          key: { enum: ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace"] },
          x: { type: "integer", minimum: 0, maximum: 1279 },
          y: { type: "integer", minimum: 0, maximum: 799 },
        },
        required: ["action"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      alwaysAsk: (input) =>
        !["snapshot", "screenshot"].includes((input as { action?: string })?.action ?? ""),
      permission: () => ({
        kind: "approval",
        title: "Use isolated browser?",
        detail: "Browser actions can submit data or change remote state within configured origins.",
      }),
      run: async (input: unknown, context: ToolContext) => {
        return this.#run(input, context)
      },
    } as HarnessTool
  }
  async #run(input: unknown, context: ToolContext) {
    const p = input as {
      action: string
      url?: string
      selector?: string
      text?: string
      key?: string
      x?: number
      y?: number
    }
    if (!p || !["open", "snapshot", "screenshot", "click", "type", "key", "mouse"].includes(p.action))
      throw new ToolInputError("Invalid browser action")
    if (context.policy.permissionMode === "plan" || context.policy.sandbox === "read-only")
      throw new ToolInputError("Browser actions are unavailable in plan mode")
    if (p.action === "open") {
      this.#checkNetwork(context, p.url ?? "")
    }
    context.signal.throwIfAborted()
    const abort = () => {
      void this.close()
    }
    context.signal.addEventListener("abort", abort, { once: true })
    try {
      const page = await this.#open(context)
      context.signal.throwIfAborted()
      if (p.action === "open") await page.goto(p.url!, { waitUntil: "domcontentloaded", timeout: 10000 })
      else {
        this.#url(page.url())
        if (p.action === "click") await page.locator(p.selector ?? "").click()
        else if (p.action === "type") await page.locator(p.selector ?? "").fill(p.text ?? "")
        else if (p.action === "key") {
          if (!["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace"].includes(p.key ?? ""))
            throw new ToolInputError("Invalid key")
          await page.keyboard.press(p.key!)
        } else if (p.action === "mouse") {
          if (
            !Number.isInteger(p.x) ||
            !Number.isInteger(p.y) ||
            p.x! < 0 ||
            p.x! >= 1280 ||
            p.y! < 0 ||
            p.y! >= 800
          )
            throw new ToolInputError("Coordinates outside viewport")
          await page.mouse.click(p.x!, p.y!)
        }
      }
      this.#url(page.url())
      if (p.action === "screenshot") {
        const image = await page.screenshot({ type: "png", timeout: 5000 })
        if (image.length > 8 * 1024 * 1024) throw new ToolInputError("Screenshot exceeds limit")
        return {
          text: "Isolated browser screenshot",
          label: "Browser screenshot",
          images: [{ type: "image" as const, mediaType: "image/png", base64Data: image.toString("base64") }],
        }
      }
      const text = await page.locator("body").innerText({ timeout: 5000 })
      return { text: (context.sanitizeOutput?.(text) ?? text).slice(0, 32768), label: `Browser ${p.action}` }
    } finally {
      context.signal.removeEventListener("abort", abort)
    }
  }
  async close() {
    this.#closed = true
    await this.#browser?.close().catch(() => {})
    this.#broker?.close()
    this.#page = undefined
  }
}
