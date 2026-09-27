import { Readable } from "node:stream"
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime"
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts"
import type { CloudIdentity } from "../../../core/identity/credentials.ts"
import { cloudBearer } from "../../../core/identity/credentials.ts"
import { assertIdentityAllowed } from "../../../core/identity/policy.ts"
import { networkFetch } from "../../../core/network.ts"
import { bytes } from "../../../core/session/files.ts"
import type { ModelInfo, ProviderClient } from "../contracts.ts"
import { buildRequestBody, mapMessagesStream } from "./anthropic.ts"
import { createOpenAiProvider, type OpenAiProviderOptions } from "./openai.ts"

type AwsRequest = {
  protocol: string
  hostname: string
  port?: number
  path: string
  query?: Record<string, string | string[] | null>
  method: string
  headers: Record<string, string>
  body?: unknown
}
/** Keep credential exchanges and signed model traffic under the same host transport policy. */
export const awsNetworkHandler = {
  async handle(request: AwsRequest, options?: { abortSignal?: AbortSignal }) {
    const url = new URL(
      `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}`,
    )
    for (const [key, value] of Object.entries(request.query ?? {}))
      for (const item of Array.isArray(value) ? value : [value ?? ""]) url.searchParams.append(key, item)
    if (
      request.body !== undefined &&
      typeof request.body !== "string" &&
      !(request.body instanceof Uint8Array)
    )
      throw new Error("Unsupported AWS request body")
    const r = await networkFetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body as BodyInit | undefined,
      signal: options?.abortSignal,
    })
    return {
      response: {
        statusCode: r.status,
        headers: Object.fromEntries(r.headers),
        body: r.body
          ? Readable.fromWeb(r.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>)
          : Readable.from([]),
      },
    }
  },
}
function awsCredentials(identity: CloudIdentity) {
  let current:
    | { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }
    | undefined
  let pending: Promise<NonNullable<typeof current>> | undefined
  return async () => {
    assertIdentityAllowed("bedrock")
    if (!identity.tokenFile) {
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
      if (!accessKeyId || !secretAccessKey)
        throw new Error(
          "Bedrock requires AWS environment credentials or a workload token file and AWS_ROLE_ARN",
        )
      return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN }
    }
    if (current?.expiration && current.expiration.getTime() > Date.now() + 60000) return current
    pending ??= (async () => {
      const role = process.env.AWS_ROLE_ARN
      if (!role) throw new Error("Bedrock workload identity requires AWS_ROLE_ARN")
      const client = new STSClient({
        region: identity.region,
        requestHandler: awsNetworkHandler,
        maxAttempts: 1,
      })
      try {
        const result = await client.send(
          new AssumeRoleWithWebIdentityCommand({
            RoleArn: role,
            RoleSessionName: "codesplash",
            WebIdentityToken: bytes(identity.tokenFile!, 65536).toString().trim(),
          }),
        )
        const c = result.Credentials
        if (
          !c?.AccessKeyId ||
          !c.SecretAccessKey ||
          !c.SessionToken ||
          !c.Expiration ||
          c.Expiration.getTime() <= Date.now() + 5000
        )
          throw new Error("Invalid AWS credentials")
        current = {
          accessKeyId: c.AccessKeyId,
          secretAccessKey: c.SecretAccessKey,
          sessionToken: c.SessionToken,
          expiration: c.Expiration,
        }
        return current
      } finally {
        client.destroy()
      }
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
}
export function createCloudProvider(
  identity: CloudIdentity,
  options: OpenAiProviderOptions & { models: ModelInfo[] },
): ProviderClient {
  const bearer = identity.kind === "bedrock" ? undefined : cloudBearer(identity)
  if (identity.kind === "azure" || identity.kind === "openai-workload") {
    const url = new URL(options.baseUrl!)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (identity.kind === "openai-workload"
        ? url.origin !== "https://api.openai.com"
        : !/^[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname))
    )
      throw new Error("Cloud credentials require the provider's official HTTPS endpoint")
    return createOpenAiProvider({ ...options, token: bearer })
  }
  const credentials = identity.kind === "bedrock" ? awsCredentials(identity) : undefined
  return {
    id: "anthropic",
    models: options.models,
    async *stream(request, signal) {
      const body = buildRequestBody(request)
      delete body.model
      try {
        if (identity.kind === "vertex") {
          body.anthropic_version = "vertex-2023-10-16"
          const host =
            identity.region === "global"
              ? "aiplatform.googleapis.com"
              : `${identity.region}-aiplatform.googleapis.com`
          const url = `https://${host}/v1/projects/${identity.project}/locations/${identity.region}/publishers/anthropic/models/${encodeURIComponent(request.model.id)}:streamRawPredict`
          const r = await networkFetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${await bearer!()}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          })
          if (!r.ok) {
            await r.body?.cancel()
            throw new Error("Vertex request failed")
          }
          yield* mapMessagesStream(r, signal)
        } else {
          body.anthropic_version = "bedrock-2023-05-31"
          delete body.stream
          const client = new BedrockRuntimeClient({
            region: identity.region,
            credentials,
            requestHandler: awsNetworkHandler,
            maxAttempts: 1,
          })
          try {
            const r = await client.send(
              new InvokeModelWithResponseStreamCommand({
                modelId: request.model.id,
                contentType: "application/json",
                accept: "application/json",
                body: Buffer.from(JSON.stringify(body)),
              }),
              { abortSignal: signal },
            )
            if (!r.body) throw new Error("Bedrock returned no stream")
            const events = r.body
            async function* sse() {
              for await (const event of events) {
                if (!event.chunk?.bytes) throw new Error("Bedrock stream failed")
                if (event.chunk.bytes.byteLength > 8 * 1024 * 1024)
                  throw new Error("Bedrock event exceeds limit")
                yield Buffer.from(`data: ${Buffer.from(event.chunk.bytes).toString()}\n\n`)
              }
            }
            const response = new Response(Readable.toWeb(Readable.from(sse())) as unknown as ReadableStream)
            yield* mapMessagesStream(response, signal)
          } finally {
            client.destroy()
          }
        }
      } catch {
        if (signal.aborted) yield { type: "done", stopReason: "aborted" }
        else throw new Error(`${identity.kind} request failed; check identity, deployment and network policy`)
      }
    },
  }
}
