import { loadConfig } from "../core/config.ts"
import { browserLogin, browserLogout } from "../core/identity/browser.ts"
import { deviceLogin, deviceLogout } from "../core/identity/device.ts"
import { UsageError } from "./usage-error.ts"
export async function runIdentityCommand(args: string[]): Promise<number> {
  const [action, id, ...rest] = args
  if (!id || rest.length || !["login", "logout"].includes(action ?? ""))
    throw new UsageError(
      "Use identity login|logout PROVIDER; configure an Azure device identity in user config first",
    )
  const config = await loadConfig(undefined, [], { workspaceTrusted: false })
  const provider = config.providers.find((p) => p.id === id)
  if (provider?.browserAuth) {
    const abort = new AbortController(),
      cancel = () => abort.abort()
    process.once("SIGINT", cancel)
    try {
      if (action === "logout") await browserLogout(provider.browserAuth, { signal: abort.signal })
      else
        await browserLogin(
          provider.browserAuth,
          (url) => {
            process.stdout.write(`Open this registered-client authorization URL in your browser:\n${url}\n`)
          },
          { signal: abort.signal },
        )
    } finally {
      process.removeListener("SIGINT", cancel)
    }
    process.stdout.write(
      action === "login"
        ? "Browser identity saved in OS credential store\n"
        : "Local browser credential removed; configured revocation attempted\n",
    )
    return 0
  }
  const identity = provider?.identity
  if (!identity || identity.kind !== "azure" || identity.authMode !== "device")
    throw new UsageError("Provider must have identity.kind=azure and identity.authMode=device")
  if (action === "logout") await deviceLogout(identity)
  else {
    const abort = new AbortController(),
      cancel = () => abort.abort()
    process.once("SIGINT", cancel)
    try {
      await deviceLogin(identity, (uri, code) => process.stdout.write(`Open ${uri} and enter ${code}\n`), {
        signal: abort.signal,
      })
    } finally {
      process.removeListener("SIGINT", cancel)
    }
  }
  process.stdout.write(
    action === "login" ? "Identity saved in OS credential store\n" : "Local identity credential removed\n",
  )
  return 0
}
