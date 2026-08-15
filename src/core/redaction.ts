const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|authorization|cookie|password|secret|session|token)\b(\s*[:=]\s*)([^\s,;]+)/gi

/** Redact credential-shaped values before process diagnostics reach logs or the UI. */
export function redactSensitiveText(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = value
    .replace(AUTHORIZATION_PATTERN, "$1 [REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[REDACTED]")

  for (const [name, secret] of Object.entries(env)) {
    if (!isSensitiveEnvironmentName(name) || !secret || secret.length < 8) continue
    redacted = redacted.replaceAll(secret, "[REDACTED]")
  }

  return redacted
}

function isSensitiveEnvironmentName(name: string): boolean {
  return /(api[_-]?key|authorization|cookie|credential|password|secret|session|token)/i.test(name)
}
