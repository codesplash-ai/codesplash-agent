export type TomlScalar = string | number | boolean

export type TomlTable = {
  [key: string]: TomlScalar | { [key: string]: TomlScalar }
}

/**
 * Serializes a flat table (root scalars plus one level of `[section]` tables) to TOML.
 * Bun ships `Bun.TOML.parse` without a serializer; the config schema is deliberately
 * flat, so this stays a minimal internal implementation instead of a dependency.
 */
export function stringifyToml(table: TomlTable): string {
  const rootLines: string[] = []
  const sectionLines: string[] = []

  for (const [key, value] of Object.entries(table)) {
    if (isScalar(value)) {
      rootLines.push(`${formatKey(key)} = ${formatScalar(value)}`)
      continue
    }
    sectionLines.push("", `[${formatKey(key)}]`)
    for (const [sectionKey, sectionValue] of Object.entries(value)) {
      if (!isScalar(sectionValue)) {
        throw new Error(
          `Cannot serialize [${key}].${sectionKey}: nested tables beyond one level are unsupported`,
        )
      }
      sectionLines.push(`${formatKey(sectionKey)} = ${formatScalar(sectionValue)}`)
    }
  }

  return `${[...rootLines, ...sectionLines].join("\n")}\n`.replace(/^\n/, "")
}

function isScalar(value: unknown): value is TomlScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function formatKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : formatString(key)
}

function formatScalar(value: TomlScalar): string {
  if (typeof value === "string") return formatString(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialize non-finite number ${value}`)
    return String(value)
  }
  return value ? "true" : "false"
}

function formatString(value: string): string {
  let out = '"'
  for (const character of value) {
    switch (character) {
      case '"':
        out += '\\"'
        break
      case "\\":
        out += "\\\\"
        break
      case "\n":
        out += "\\n"
        break
      case "\r":
        out += "\\r"
        break
      // Bun 1.3's TOML parser swaps the \t and \f short escapes, so emit the
      // unambiguous \uXXXX forms it round-trips correctly.
      case "\t":
        out += "\\u0009"
        break
      case "\b":
        out += "\\b"
        break
      case "\f":
        out += "\\u000c"
        break
      default: {
        const code = character.codePointAt(0) ?? 0
        if (code === 0x7f) {
          out += "\\u007f"
        } else if (code < 0x20) {
          // Bun's TOML parser rejects \uXXXX escapes for most C0 controls; failing
          // here beats writing a config file that cannot be read back.
          throw new Error(`Cannot serialize control character U+${code.toString(16).padStart(4, "0")}`)
        } else {
          out += character
        }
      }
    }
  }
  return `${out}"`
}
