import { CodexAppServerClient, SUPPORTED_CODEX_CLI_VERSION } from "./app-server-client.ts"

export async function runCodexSmoke(): Promise<void> {
  const client = new CodexAppServerClient()

  try {
    const initialized = await client.initialize()
    const account = await client.readAccount()
    const auth = formatAccount(account.account)

    process.stdout.write(`Codex app-server smoke check passed
Supported CLI baseline: ${SUPPORTED_CODEX_CLI_VERSION}
Server: ${initialized.userAgent}
Platform: ${initialized.platformOs}
Authentication: ${auth}
`)
  } catch (error) {
    const stderr = client.process.getStderr().trim()
    if (stderr.length > 0 && error instanceof Error) {
      throw new Error(`${error.message}\nCodex stderr: ${stderr}`, { cause: error })
    }
    throw error
  } finally {
    await client.close()
  }
}

function formatAccount(account: Awaited<ReturnType<CodexAppServerClient["readAccount"]>>["account"]): string {
  if (!account) return "not signed in"
  if (account.type === "chatgpt") return `ChatGPT (${account.planType})`
  if (account.type === "apiKey") return "API key"
  return "Amazon Bedrock"
}
