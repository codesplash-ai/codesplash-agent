import { redactSensitiveText } from "../../../core/redaction.ts"

const SAFE_NAMES = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TZ"])
const INJECTION =
  /^(?:BASH_ENV|ENV|IFS|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT|PERL5LIB|GIT_CONFIG.*|GIT_SSH.*|LD_.*|DYLD_.*|.*PROXY)$/i
export const SENSITIVE_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION)/i

export function validateEnvironmentName(name: string): void {
  if (
    !/^[A-Z_][A-Z0-9_]*$/.test(name) ||
    SENSITIVE_NAME.test(name) ||
    INJECTION.test(name) ||
    ["HOME", "TMPDIR", "TMP", "TEMP"].includes(name)
  ) {
    throw new Error(
      "Sandbox environment entries must name non-secret variables without startup or injection behavior",
    )
  }
}

/** Keep provider/auth environment separate from every model-controlled child. */
export function childEnvironment(
  temp: string,
  extra: readonly string[] = [],
  source = process.env,
): NodeJS.ProcessEnv {
  for (const name of extra) validateEnvironmentName(name)
  const env: NodeJS.ProcessEnv = {
    HOME: temp,
    TMPDIR: `${temp}/`,
    TMP: temp,
    TEMP: temp,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
  }
  for (const name of [...SAFE_NAMES, ...extra]) {
    const value = source[name]
    if (
      value !== undefined &&
      !SENSITIVE_NAME.test(name) &&
      !INJECTION.test(name) &&
      redactSensitiveText(value, source) === value
    )
      env[name] = value
  }
  return env
}

/** Carries a suffix between chunks so even split/short/overlapping secrets are removed. */
export class SecretSanitizer {
  #pending = ""
  #coveredPrefix = 0
  readonly #secrets: string[]
  readonly #reserve: number
  constructor(values: readonly string[]) {
    this.#secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length)
    this.#reserve = Math.max(1, ...this.#secrets.map((s) => s.length)) - 1
  }
  push(chunk: string, final = false): string {
    this.#pending += chunk
    const end = final ? this.#pending.length : Math.max(0, this.#pending.length - this.#reserve)
    if (end === 0) return ""
    const ranges = this.#ranges(this.#pending, this.#coveredPrefix)
    let output = "",
      cursor = 0,
      covered = 0
    for (const [start, stop] of ranges) {
      if (start >= end) break
      output += this.#pending.slice(cursor, start)
      if (!(start === 0 && this.#coveredPrefix > 0)) output += "[REDACTED]"
      cursor = Math.min(end, stop)
      if (stop > end) covered = stop - end
    }
    output += this.#pending.slice(cursor, end)
    this.#pending = this.#pending.slice(end)
    // Carry redacted coverage through the retained suffix. Future overlapping
    // matches cannot expose a prefix, and pending data stays bounded.
    this.#coveredPrefix = covered
    return output
  }
  redact(text: string): string {
    if (this.#secrets.length === 0) return text
    let output = "",
      cursor = 0
    for (const [start, end] of this.#ranges(text)) {
      output += `${text.slice(cursor, start)}[REDACTED]`
      cursor = end
    }
    return output + text.slice(cursor)
  }
  #ranges(text: string, covered = 0): Array<[number, number]> {
    const ranges: Array<[number, number]> = []
    if (covered) ranges.push([0, covered])
    for (const secret of this.#secrets) {
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) {
        const marker = text.lastIndexOf("[REDACTED]", at)
        if (marker < 0 || at >= marker + "[REDACTED]".length) ranges.push([at, at + secret.length])
      }
    }
    ranges.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const range of ranges) {
      const last = merged[merged.length - 1]
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
      else merged.push([...range])
    }
    return merged
  }
}
