import { isIP } from "node:net"
import { domainToASCII } from "node:url"
import { ToolInputError } from "../contracts.ts"

/** Domain lists match the named host and its subdomains, never suffix lookalikes. */
export function searchDomains(value: unknown): string[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 64) throw new ToolInputError("Expected at most 64 domain names")
  return [
    ...new Set(
      value.map((raw) => {
        if (typeof raw !== "string" || raw.length > 253 || /[\s/:@?#*\\]/.test(raw))
          throw new ToolInputError(
            "Search domains must be literal hostnames without paths, ports or wildcards",
          )
        const name = domainToASCII(raw.replace(/\.$/, "").toLowerCase())
        if (
          !name ||
          isIP(name) ||
          !name.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
        )
          throw new ToolInputError("Invalid search domain")
        return name
      }),
    ),
  ]
}

export function searchDomainAllowed(url: string, allow?: string[], deny?: string[]): boolean {
  try {
    const parsed = new URL(url)
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return false
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "")
    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`)
    return !deny?.some(matches) && (allow === undefined || allow.some(matches))
  } catch {
    return false
  }
}
