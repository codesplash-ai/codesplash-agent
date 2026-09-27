/** Generated at build time for forks; never read from the workspace or remote settings. */
declare const __CODESPLASH_BRAND__: string | undefined
const defaultBrand = {
  name: "CodeSplash Agent",
  command: "codesplash",
  variant: "public" as "public" | "internal",
  supportUrl: "https://github.com/codesplash-ai/codesplash-agent/issues",
}
export function validateBrand(value: unknown): typeof defaultBrand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid build brand")
  const v = value as typeof defaultBrand
  if (
    Object.keys(v).some((k) => !["name", "command", "variant", "supportUrl"].includes(k)) ||
    typeof v.name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/.test(v.name) ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(v.command) ||
    !["public", "internal"].includes(v.variant)
  )
    throw new Error("Invalid build brand")
  const url = new URL(v.supportUrl)
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Invalid build support URL")
  return { name: v.name, command: v.command, variant: v.variant, supportUrl: url.href }
}
export const brand =
  typeof __CODESPLASH_BRAND__ === "undefined" ? defaultBrand : validateBrand(JSON.parse(__CODESPLASH_BRAND__))
export function dispatchArguments(argv0: string, args: string[]): string[] {
  const name = argv0
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.exe$/i, "")
  const dispatch: Record<string, string> = {
    [`${brand.command}-sandbox`]: "sandbox",
    [`${brand.command}-key-proxy`]: "key-proxy",
    [`${brand.command}-wrap`]: "wrap",
  }
  return name && dispatch[name] ? [dispatch[name]!, ...args] : args
}
