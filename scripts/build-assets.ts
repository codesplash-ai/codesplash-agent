import { copyFile, mkdir } from "node:fs/promises"

await mkdir(new URL("../dist/core/session/", import.meta.url), { recursive: true })
await copyFile(
  new URL("../src/core/session/secure-path.c", import.meta.url),
  new URL("../dist/core/session/secure-path.c", import.meta.url),
)
