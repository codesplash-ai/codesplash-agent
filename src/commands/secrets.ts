import { NamedSecrets, validateSecretName } from "../engines/codesplash/secrets.ts"
import { UsageError } from "./usage-error.ts"

export async function runSecretsCommand(
  args: string[],
  readSecret: () => Promise<string>,
  store = new NamedSecrets(),
): Promise<number> {
  const [action, name] = args
  if (action === "list" && args.length === 1) {
    for (const item of await store.list()) process.stdout.write(`${item}\n`)
    return 0
  }
  if (!name || args.length !== 2 || (action !== "set" && action !== "delete"))
    throw new UsageError(
      "Usage: codesplash secrets set NAME (value from hidden stdin), list, or delete NAME; values are never command arguments",
    )
  validateSecretName(name)
  if (action === "set") await store.set(name, await readSecret())
  else await store.delete(name)
  process.stdout.write(`${action === "set" ? "Saved" : "Deleted"} named secret ${name}\n`)
  return 0
}
