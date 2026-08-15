const mode = process.argv[2]

if (mode === "normal") {
  process.exit(Number(process.argv[3] ?? 0))
}

if (mode === "wait") {
  process.on("SIGINT", () => process.exit(130))
  process.on("SIGTERM", () => process.exit(143))
  process.on("SIGHUP", () => process.exit(129))
  setInterval(() => {}, 1_000)
} else {
  process.stderr.write(`unknown fake terminal mode: ${mode}\n`)
  process.exit(2)
}
