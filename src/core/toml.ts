export type TomlScalar = string | number | boolean

export type TomlValue = TomlScalar | TomlValue[] | TomlTable

export type TomlTable = {
  /** Undefined entries are skipped, so optional fields can be built unconditionally. */
  [key: string]: TomlValue | undefined
}

/**
 * Serializes a table to TOML: root scalars, nested `[a.b]` tables to any depth, inline arrays of
 * scalars, and `[[a.b]]` arrays of tables. Bun ships `Bun.TOML.parse` without a serializer; the
 * config schema is small and known, so this stays a minimal internal implementation instead of a
 * dependency. Mixed-type arrays (tables alongside scalars) are unsupported and throw.
 */
export function stringifyToml(table: TomlTable): string {
  const lines: string[] = []
  writeTable(lines, table, [])
  return `${lines.join("\n")}\n`.replace(/^\n/, "")
}

function writeTable(lines: string[], table: TomlTable, path: string[]): void {
  const nestedTables: Array<[string, TomlTable]> = []
  const tableArrays: Array<[string, TomlTable[]]> = []

  for (const [key, value] of Object.entries(table)) {
    if (value === undefined) continue
    if (isScalar(value)) {
      lines.push(`${formatKey(key)} = ${formatScalar(value)}`)
    } else if (Array.isArray(value)) {
      if (value.every(isTable)) tableArrays.push([key, value])
      else lines.push(`${formatKey(key)} = ${formatInlineArray(value, [...path, key])}`)
    } else {
      nestedTables.push([key, value])
    }
  }

  for (const [key, value] of nestedTables) {
    const nestedPath = [...path, key]
    lines.push("", `[${formatPath(nestedPath)}]`)
    writeTable(lines, value, nestedPath)
  }

  for (const [key, elements] of tableArrays) {
    const nestedPath = [...path, key]
    for (const element of elements) {
      lines.push("", `[[${formatPath(nestedPath)}]]`)
      writeTable(lines, element, nestedPath)
    }
  }
}

/** Non-table arrays serialize inline; every element must be a scalar or a scalar array. */
function formatInlineArray(values: TomlValue[], path: string[]): string {
  const parts = values.map((value) => {
    if (isScalar(value)) return formatScalar(value)
    if (Array.isArray(value)) return formatInlineArray(value, path)
    throw new Error(
      `Cannot serialize ${formatPath(path)}: arrays mixing tables with other values are unsupported`,
    )
  })
  return `[${parts.join(", ")}]`
}

function isScalar(value: unknown): value is TomlScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function isTable(value: TomlValue): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatPath(path: string[]): string {
  return path.map(formatKey).join(".")
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
