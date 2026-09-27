import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { networkFetch } from "../../../core/network.ts"
import { atomic, bytes, directory, json } from "../../../core/session/files.ts"
import type { HarnessTool, ToolContext } from "../contracts.ts"
import { startNetworkBroker } from "../sandbox/network-broker.ts"

type Job = {
  version: 1
  id: string
  kind: "image" | "video"
  status: "uncertain" | "queued" | "completed" | "failed"
  endpoint?: string
  outputUrl?: string
  remote?: string
  artifact?: string
}
export type GenerationConfig = {
  videoBaseUrl?: string
  videoKeyEnv?: string
  baseUrl: string
  imageModel?: string
  videoModel?: string
  apiKeyEnv: string
  maxJobs: number
}
export function generationConfig(env: NodeJS.ProcessEnv = process.env): GenerationConfig {
  return {
    videoBaseUrl: env.CODESPLASH_VIDEO_BASE_URL ?? "https://api.dev.runwayml.com/v1",
    videoKeyEnv: env.CODESPLASH_VIDEO_KEY_ENV ?? "RUNWAYML_API_SECRET",
    baseUrl: env.CODESPLASH_GENERATION_BASE_URL ?? "https://api.openai.com/v1",
    imageModel: env.CODESPLASH_IMAGE_MODEL,
    videoModel: env.CODESPLASH_VIDEO_MODEL,
    apiKeyEnv: env.CODESPLASH_GENERATION_KEY_ENV ?? "OPENAI_API_KEY",
    maxJobs: Number(env.CODESPLASH_GENERATION_MAX_JOBS ?? 2),
  }
}
export async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing response body")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maximum) throw new Error("Response exceeds byte limit")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}
/** Durable intent precedes a billable request. Interrupted POSTs are never replayed. */
export class GenerationTools {
  #count = 0
  constructor(
    readonly root: string,
    readonly hosts: readonly string[],
    readonly config = generationConfig(),
    readonly dollarLimited = false,
    readonly allowLoopback = true,
  ) {
    if (existsSync(root)) {
      directory(root)
      this.#count = readdirSync(root).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).length
    }
    for (const base of [config.baseUrl, config.videoBaseUrl ?? "https://api.dev.runwayml.com/v1"]) {
      const url = new URL(base)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
        ) ||
        !Number.isInteger(config.maxJobs) ||
        config.maxJobs < 1 ||
        config.maxJobs > 8 ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(config.apiKeyEnv)
      )
        throw new Error("Invalid operator generation configuration")
    }
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(config.videoKeyEnv ?? "RUNWAYML_API_SECRET"))
      throw new Error("Invalid video key binding")
  }
  tool(): HarnessTool {
    return {
      name: "generate_media",
      description:
        "Create an image or a short video using operator-selected models. Billable creates have a per-session job cap, explicit approval and no automatic retry. Poll video jobs explicitly; completed artifacts stay in the private generation store for operator export.",
      effects: "external",
      isReadOnly: () => false,
      alwaysAsk: () => true,
      allowPersistentApproval: false,
      permission: () => ({
        kind: "approval",
        title: "Use media generation service?",
        detail:
          "Creation is billable outside language-model token accounting. An interrupted create may still be billed and will not be retried.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          action: { enum: ["create", "status", "download"] },
          kind: { enum: ["image", "video"] },
          prompt: { type: "string", maxLength: 16000 },
          job: { type: "string", minLength: 36, maxLength: 36 },
        },
        required: ["action"],
        additionalProperties: false,
      },
      run: (input, context) => this.run(input, context),
    }
  }
  async run(input: unknown, context: ToolContext) {
    const p = input as { action: string; kind?: "image" | "video"; prompt?: string; job?: string }
    if (
      !p ||
      !["create", "status", "download"].includes(p.action) ||
      context.policy.permissionMode === "plan" ||
      context.policy.sandbox === "read-only"
    )
      throw new Error("Generation requires non-plan writable policy")
    if (process.env.CODESPLASH_OFFLINE === "1" || this.dollarLimited)
      throw new Error(
        "Generation is unavailable offline or under a language-model dollar ceiling; media has separate billing",
      )
    let job: Job
    if (p.action === "create") {
      if (
        !["image", "video"].includes(p.kind ?? "") ||
        typeof p.prompt !== "string" ||
        !p.prompt ||
        p.prompt.length > 16000
      )
        throw new Error("Invalid generation request")
      const model = p.kind === "image" ? this.config.imageModel : this.config.videoModel
      if (!model || model.length > 128) throw new Error("Operator must select an exact generation model")
      if (this.#count >= this.config.maxJobs) throw new Error("Generation job limit reached")
      this.#count++
      job = { version: 1, id: crypto.randomUUID(), kind: p.kind!, status: "uncertain" }
    } else {
      if (!/^[a-f0-9-]{36}$/.test(p.job ?? "")) throw new Error("Invalid generation job id")
      job = json<Job>(join(this.root, `${p.job}.json`), 8192)
      if (job.version !== 1 || job.id !== p.job || !["image", "video"].includes(job.kind))
        throw new Error("Invalid generation job")
      if (job.artifact)
        return { text: JSON.stringify({ ...job, outputUrl: undefined }), label: "Generated media" }
      if (!job.remote || !/^[a-f0-9-]{36}$/.test(job.remote))
        throw new Error("Job has no confirmed remote id; inspect provider history before creating again")
    }
    const base = new URL(
      (job.kind === "image"
        ? this.config.baseUrl
        : (this.config.videoBaseUrl ?? "https://api.dev.runwayml.com/v1")
      ).replace(/\/$/, "") + "/",
    )
    if (base.protocol === "http:" && !this.allowLoopback)
      throw new Error("Managed host policy refuses loopback generation")
    if (base.protocol !== "http:" || !this.allowLoopback) context.checkNetwork?.(base.href)
    const key =
      process.env[
        job.kind === "image" ? this.config.apiKeyEnv : (this.config.videoKeyEnv ?? "RUNWAYML_API_SECRET")
      ]
    if (!key && base.protocol === "https:") throw new Error("Generation credential is unavailable")
    if (job.endpoint && job.endpoint !== base.href)
      throw new Error("Generation endpoint changed; restore the reviewed job configuration")
    job.endpoint = base.href
    if (p.action === "download" && (job.status !== "completed" || !job.outputUrl))
      throw new Error("Poll the video until completed before download")
    if (p.action === "create") {
      directory(this.root, true)
      atomic(join(this.root, `${job.id}.json`), JSON.stringify(job))
    }
    const broker = await startNetworkBroker(this.hosts, {
      loopbackOrigins: base.protocol === "http:" ? [base.origin] : [],
    })
    try {
      const endpoint =
        p.action === "create"
          ? job.kind === "image"
            ? "images/generations"
            : "image_to_video"
          : `tasks/${job.remote}`
      const url = p.action === "download" ? new URL(job.outputUrl!) : new URL(endpoint, base)
      if (
        url.username ||
        url.password ||
        url.hash ||
        !(url.protocol === "https:" || (url.protocol === "http:" && url.origin === base.origin))
      )
        throw new Error("Invalid artifact URL")
      if (!(this.allowLoopback && base.protocol === "http:" && url.origin === base.origin))
        context.checkNetwork?.(url.href)
      const response = await networkFetch(
        url,
        {
          method: p.action === "create" ? "POST" : "GET",
          headers:
            p.action === "download"
              ? {}
              : {
                  "content-type": "application/json",
                  ...(job.kind === "video" ? { "X-Runway-Version": "2024-11-06" } : {}),
                  ...(key ? { authorization: `Bearer ${key}` } : {}),
                },
          ...(p.action === "create"
            ? {
                body: JSON.stringify(
                  job.kind === "image"
                    ? { model: this.config.imageModel, prompt: p.prompt, n: 1, size: "1024x1024" }
                    : { model: this.config.videoModel, promptText: p.prompt, duration: 5, ratio: "1280:720" },
                ),
              }
            : {}),
          redirect: "error",
          proxy: broker.url,
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(120000)]),
        },
        { upload: p.action === "create" },
      )
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Generation HTTP ${response.status}; job ${job.id}; no retry`)
      }
      if (p.action === "download") {
        if (job.status !== "completed") {
          await response.body?.cancel()
          throw new Error("Poll the video until completed before download")
        }
        const content = await boundedBody(response, 32 * 1024 * 1024)
        if (content.subarray(4, 8).toString() !== "ftyp") throw new Error("Invalid MP4 artifact")
        job.artifact = `${job.id}.mp4`
        atomic(join(this.root, job.artifact), content)
      } else {
        const result = JSON.parse((await boundedBody(response, 12 * 1024 * 1024)).toString())
        if (job.kind === "image") {
          const encoded = result.data?.[0]?.b64_json
          if (typeof encoded !== "string" || encoded.length > 12 * 1024 * 1024)
            throw new Error("Missing or oversized generated image")
          const content = Buffer.from(encoded, "base64")
          if (!content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw new Error("Expected generated PNG")
          job.artifact = `${job.id}.png`
          atomic(join(this.root, job.artifact), content)
          job.status = "completed"
        } else {
          if (
            typeof result.id !== "string" ||
            !/^[a-f0-9-]{36}$/.test(result.id) ||
            (job.remote && job.remote !== result.id)
          )
            throw new Error("Invalid video job response")
          if (result.output?.[0] !== undefined) {
            if (typeof result.output[0] !== "string" || result.output[0].length > 4096)
              throw new Error("Invalid video artifact URL")
            job.outputUrl = result.output[0]
          }
          job.remote = result.id
          job.status =
            result.status === "SUCCEEDED"
              ? "completed"
              : ["FAILED", "CANCELLED"].includes(result.status)
                ? "failed"
                : "queued"
        }
      }
      atomic(join(this.root, `${job.id}.json`), JSON.stringify(job))
      return {
        text: JSON.stringify({ ...job, outputUrl: undefined, store: this.root }),
        label: "Generated media",
      }
    } finally {
      broker.close()
    }
  }
}
export function generationArtifact(root: string, job: string): { name: string; content: Buffer } {
  if (!/^[a-f0-9-]{36}$/.test(job)) throw new Error("Invalid job id")
  const record = json<Job>(join(root, `${job}.json`), 8192)
  if (
    record.id !== job ||
    record.status !== "completed" ||
    !record.artifact ||
    ![`${job}.mp4`, `${job}.png`].includes(record.artifact)
  )
    throw new Error("Completed artifact is unavailable")
  return { name: record.artifact, content: bytes(join(root, record.artifact), 32 * 1024 * 1024) }
}
