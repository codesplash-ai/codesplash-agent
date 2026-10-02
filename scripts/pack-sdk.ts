import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

async function copyRuntimeTree(source: string, destination: string, ancestors: string[] = []) {
  assert.ok(!ancestors.includes(source), "Unexpected cyclic bundled runtime dependency")
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => path !== join(source, "node_modules"),
  })
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
  const require = createRequire(join(source, "package.json"))
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    await copyRuntimeTree(
      dirname(require.resolve(`${name}/package.json`)),
      join(destination, "node_modules", name),
      [...ancestors, source],
    )
  }
}

// Consumers cannot apply this repository's Bun patch paths. Ship the already
// patched runtime and its dependencies in the package, without install scripts
// or modifications to the consumer's dependency tree.
export async function packSDK(archive: string, project = process.cwd()) {
  const stage = await mkdtemp(join(tmpdir(), "codesplash-sdk-pack-"))
  try {
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
    const runtime = "@anthropic-ai/sandbox-runtime"
    const patched = await readFile(
      join(project, "node_modules", runtime, "dist/sandbox/windows-sandbox-utils.js"),
      "utf8",
    )
    assert.equal(
      patched.match(/timeoutMs: 600000/g)?.length,
      4,
      "Windows ACL deadline patch must be present before packing",
    )
    for (const path of manifest.files) {
      await cp(join(project, path), join(stage, path), { recursive: true })
    }
    delete manifest.patchedDependencies
    manifest.bundleDependencies = [runtime]
    await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    // A symlink to the checkout lets npm omit hoisted runtime dependencies.
    // Materialize its complete installed tree so the tarball is self-contained.
    await copyRuntimeTree(join(project, "node_modules", runtime), join(stage, "node_modules", runtime))
    await mkdir(dirname(resolve(archive)), { recursive: true })
    const child = Bun.spawn(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", stage], {
      cwd: stage,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    assert.equal(code, 0, error)
    const [result] = JSON.parse(output)
    assert.ok(result.bundled.includes(runtime), "Packed SDK must include the patched runtime")
    await rename(join(stage, result.filename), resolve(archive))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const manifest = JSON.parse(await readFile("package.json", "utf8"))
  await packSDK(`out/codesplash-agent-${manifest.version}-sdk.tgz`)
}
