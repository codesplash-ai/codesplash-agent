/**
 * A caller mistake (bad flags, unknown values, missing input): the CLI prints the message to
 * stderr and exits 2. This lives in its own tiny module so command modules can throw it without
 * importing cli.ts (which would be an import cycle); cli.ts re-exports it for existing callers.
 */
export class UsageError extends Error {
  override readonly name = "UsageError"
}
