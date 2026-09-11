import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProfile } from "../../../src/engines/codesplash/sandbox/profile.ts"
import { NativeSandbox } from "../../../src/engines/codesplash/sandbox/runtime.ts"

test("persistent sandbox transport exchanges multiple requests and retains the filesystem boundary", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-duplex-")))
  const outside = `${root}-outside`
  await writeFile(outside, "PRIVATE_FIXTURE")
  const runtime = new NativeSandbox(createProfile(root, "workspace-write"))
  const decoder = new TextDecoder()
  let text = ""
  let notify: (() => void) | undefined
  const script = `let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  while (pending.includes("\\n")) {
    const at = pending.indexOf("\\n"), request = JSON.parse(pending.slice(0, at));
    pending = pending.slice(at + 1);
    let result = "written";
    try { await Bun.write(request.path, "ok") } catch { result = "denied" }
    process.stdout.write(JSON.stringify({id: request.id, result}) + "\\n");
  }
}`

  try {
    runtime.grant(runtime.validateGrant({ resource: "write", target: outside, scope: "turn" }, "default"))
    const stream = await runtime.openDuplex(
      [process.execPath, "-e", script],
      AbortSignal.timeout(8000),
      (chunk) => {
        text += decoder.decode(chunk, { stream: true })
        notify?.()
      },
    )
    let completion: unknown
    void stream.finished.then(
      (result) => {
        completion = result
      },
      (error) => {
        completion = String(error)
      },
    )
    const waitFor = async (count: number) => {
      const until = Date.now() + 6000
      while (text.trim().split("\n").filter(Boolean).length < count) {
        if (completion) throw new Error(`Transport ended before reply: ${JSON.stringify(completion)}`)
        if (Date.now() > until) throw new Error(`No transport reply: ${text}`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20)
          notify = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    }
    await stream.write(Buffer.from(`${JSON.stringify({ id: 1, path: join(root, "allowed") })}\n`))
    await waitFor(1)
    await stream.write(Buffer.from(`${JSON.stringify({ id: 2, path: outside })}\n`))
    await waitFor(2)
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: 1, result: "written" },
      { id: 2, result: "denied" },
    ])
    expect(await readFile(outside, "utf8")).toBe("PRIVATE_FIXTURE")
    await runtime.close()
    await expect(stream.finished).resolves.toMatchObject({ kind: "interrupted" })
    await expect(stream.write(Buffer.from("{}\n"))).rejects.toThrow("closed")
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
}, 15000)

test("already cancelled persistent transports allocate no child", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cs-duplex-abort-")))
  const runtime = new NativeSandbox(createProfile(root, "read-only"))
  try {
    await expect(
      runtime.openDuplex(["/usr/bin/true"], AbortSignal.timeout(1000), () => {}, "default", [
        "MCP_UNGRANTED",
      ]),
    ).rejects.toThrow("no fixed sandbox grant")
    await expect(
      runtime.openDuplex(["/usr/bin/true"], AbortSignal.abort(new Error("cancelled fixture")), () => {}),
    ).rejects.toThrow("cancelled fixture")
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})
