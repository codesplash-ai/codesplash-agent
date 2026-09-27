import { afterEach, expect, test } from "bun:test"
import { generateKeyPairSync, verify } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signDocument } from "../../src/core/distribution/signed.ts"
import { cloudBearer, refreshingToken, validateIdentity } from "../../src/core/identity/credentials.ts"
import { deviceLogin, deviceRefresh } from "../../src/core/identity/device.ts"
import { keyringSet, type SecretStore } from "../../src/core/identity/keyring.ts"
import { networkFetch } from "../../src/core/network.ts"
import type { ProviderStreamEvent } from "../../src/engines/codesplash/contracts.ts"
import { anthropicModels } from "../../src/engines/codesplash/providers/anthropic.ts"
import { createCloudProvider } from "../../src/engines/codesplash/providers/cloud.ts"

const originalFetch = globalThis.fetch,
  originalEnv = { ...process.env }
const roots: string[] = []
afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = { ...originalEnv }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function root() {
  const path = mkdtempSync(join(tmpdir(), "m11-identity-"))
  roots.push(path)
  process.env.CODESPLASH_AGENT_CONFIG_DIR = path
  return path
}
function fixture(fn: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(fn(new URL(input instanceof Request ? input.url : input), init ?? {}))) as typeof fetch
}
const result = (value = "token-secret", expires = 3600) =>
  Response.json({ access_token: value, expires_in: expires, token_type: "Bearer" })

test("refresh shares concurrent work, refreshes before expiry and does not retain failed refresh", async () => {
  let now = 0,
    calls = 0,
    fail = false
  const get = refreshingToken(
    async () => {
      calls++
      await Promise.resolve()
      if (fail) throw new Error("failed")
      return { value: `token-${calls}`, expiresAt: now + 120000 }
    },
    () => now,
  )
  expect(await Promise.all([get(), get(), get()])).toEqual(["token-1", "token-1", "token-1"])
  now = 70000
  fail = true
  await expect(get()).rejects.toThrow("failed")
  fail = false
  expect(await get()).toBe("token-3")
  expect(await get()).toBe("token-3")
  expect(calls).toBe(3)
})
test("OpenAI exchanges a bounded workload file at the official endpoint; secrets never enter errors", async () => {
  const path = join(root(), "subject.jwt")
  writeFileSync(path, "subject-secret")
  let calls = 0
  fixture((url, init) => {
    calls++
    expect(url.href).toBe("https://auth.openai.com/oauth/token")
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: "subject-secret",
      identity_provider_id: "idp-test",
      service_account_id: "sa-test",
    })
    return result()
  })
  const identity = {
    kind: "openai-workload" as const,
    tokenFile: path,
    identityProviderId: "idp-test",
    serviceAccountId: "sa-test",
  }
  const get = cloudBearer(identity)
  expect(await Promise.all([get(), get()])).toEqual(["token-secret", "token-secret"])
  expect(calls).toBe(1)
  fixture(() => new Response("subject-secret", { status: 401 }))
  await expect(cloudBearer(identity)()).rejects.toThrow("Identity exchange failed (HTTP 401)")
  fixture(() => new Response("subject-secret"))
  await expect(cloudBearer(identity)()).rejects.toThrow("Invalid identity response")
  expect(() => validateIdentity({ ...identity, tokenFile: "relative" })).toThrow("absolute")
  expect(() => createCloudProvider(identity, { baseUrl: "https://evil.example", models: [] })).toThrow(
    "official",
  )
})
test("Vertex signs service-account assertions and sends native Messages SSE to its scoped endpoint", async () => {
  const path = join(root(), "account.json"),
    pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      client_email: "test@project.iam.gserviceaccount.com",
      private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
  )
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path
  fixture((url, init) => {
    if (url.hostname === "oauth2.googleapis.com") {
      const jwt = new URLSearchParams(String(init.body)).get("assertion")!,
        parts = jwt.split(".")
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          pair.publicKey,
          Buffer.from(parts[2]!, "base64url"),
        ),
      ).toBe(true)
      expect(JSON.parse(Buffer.from(parts[1]!, "base64url").toString()).aud).toBe(
        "https://oauth2.googleapis.com/token",
      )
      return result()
    }
    expect(url.href).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/project/locations/us-central1/publishers/anthropic/models/claude-test:streamRawPredict",
    )
    const body = JSON.parse(String(init.body))
    expect(body.anthropic_version).toBe("vertex-2023-10-16")
    expect(body.model).toBeUndefined()
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-secret")
    return new Response(
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
    )
  })
  const model = { ...anthropicModels[0]!, id: "claude-test" },
    client = createCloudProvider(
      { kind: "vertex", region: "us-central1", project: "project" },
      { models: [model] },
    )
  const events: ProviderStreamEvent[] = []
  for await (const event of client.stream(
    { model, system: "", messages: [], tools: [] },
    new AbortController().signal,
  ))
    events.push(event)
  expect(events).toContainEqual({ type: "text_delta", text: "hello" })
  expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
})
test("Azure device flow handles pending/slowdown, stores only refresh in OS store and rotates it", async () => {
  const path = root(),
    memory = new Map<string, string>()
  const store: SecretStore = {
    get: async (o) => memory.get(o.name) ?? null,
    set: async (o) => {
      memory.set(o.name, o.value)
    },
    delete: async (o) => memory.delete(o.name),
  }
  const identity = {
    kind: "azure" as const,
    authMode: "device" as const,
    tenant: "tenant-1",
    clientId: "client-1",
  }
  let polls = 0,
    refreshCalls = 0
  const sleeps: number[] = [],
    shown: string[] = []
  fixture((url, init) => {
    if (url.pathname.endsWith("devicecode"))
      return Response.json({
        device_code: "device-secret",
        user_code: "TEST-CODE",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 1,
      })
    const fields = new URLSearchParams(String(init.body))
    if (fields.get("grant_type") === "refresh_token") {
      refreshCalls++
      expect(fields.get("refresh_token")).toBe("refresh-secret")
      return Response.json({
        access_token: "access-2",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-2",
      })
    }
    polls++
    return polls < 3
      ? Response.json(
          { error: polls === 1 ? "authorization_pending" : "slow_down", error_description: "device-secret" },
          { status: 400 },
        )
      : Response.json({
          access_token: "access-secret",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-secret",
        })
  })
  await deviceLogin(identity, (uri, code) => shown.push(uri, code), {
    root: path,
    store,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  expect(shown).toEqual(["https://microsoft.com/devicelogin", "TEST-CODE"])
  expect(sleeps).toEqual([1000, 1000, 6000])
  expect([...memory.values()]).toEqual(["refresh-secret"])
  expect(
    (await Promise.all(Array.from({ length: 8 }, () => deviceRefresh(identity, path, store)))).map(
      (t) => t.value,
    ),
  ).toEqual(Array(8).fill("access-2"))
  expect(refreshCalls).toBe(1)
  expect([...memory.values()]).toEqual(["refresh-2"])
  await expect(
    keyringSet("test", "key-secret", path, {
      ...store,
      set: async () => {
        throw new Error("key-secret")
      },
    }),
  ).rejects.toThrow("no plaintext fallback")
})
test("managed destinations, offline, required CA and identity restrictions cannot be relaxed by environment", async () => {
  const path = root(),
    key = generateKeyPairSync("ed25519")
  writeFileSync(
    join(path, "fleet.json"),
    JSON.stringify({
      version: 1,
      keys: { t: key.publicKey.export({ type: "spki", format: "pem" }).toString() },
      document: signDocument(
        {
          version: 1,
          kind: "fleet",
          revision: 1,
          issuedAt: Date.now() - 1000,
          expiresAt: Date.now() + 3600000,
          settings: {
            identityKinds: ["vertex"],
            network: { allowedHosts: ["allowed.example:443"], requireExtraCA: true },
          },
        },
        "t",
        key.privateKey,
      ),
    }),
  )
  let calls = 0
  fixture(() => {
    calls++
    return result()
  })
  await expect(networkFetch("https://denied.example")).rejects.toThrow("managed network")
  await expect(networkFetch("https://allowed.example")).rejects.toThrow("Required additional CA")
  const get = cloudBearer({ kind: "azure", tenant: "tenant", clientId: "client" })
  expect(() => get()).toThrow("disabled by managed policy")
  expect(calls).toBe(0)
})

test("Bedrock signs with workload credentials and decodes a real AWS binary event stream", async () => {
  const { EventStreamCodec } = await import("@smithy/core/event-streams")
  const path = join(root(), "aws.jwt")
  writeFileSync(path, "aws-subject-secret")
  process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/fixture"
  let exchanges = 0,
    requests = 0
  const codec = new EventStreamCodec(
    (bytes) => Buffer.from(bytes).toString(),
    (text) => Buffer.from(text),
  )
  const frames = [
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bedrock hello" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ].map((frame) =>
    codec.encode({
      headers: {
        ":message-type": { type: "string", value: "event" },
        ":event-type": { type: "string", value: "chunk" },
        ":content-type": { type: "string", value: "application/json" },
      },
      body: Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(frame)).toString("base64") })),
    }),
  )
  fixture((url, init) => {
    if (url.hostname === "sts.us-east-1.amazonaws.com") {
      exchanges++
      expect(String(init.body)).toContain("aws-subject-secret")
      return new Response(
        `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIATEST123456789012</AccessKeyId><SecretAccessKey>secret-test-key</SecretAccessKey><SessionToken>session-test-token</SessionToken><Expiration>${new Date(Date.now() + 3600000).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
        { headers: { "content-type": "text/xml" } },
      )
    }
    requests++
    expect(url.hostname).toBe("bedrock-runtime.us-east-1.amazonaws.com")
    expect(new Headers(init.headers).get("authorization")).toContain(
      "AWS4-HMAC-SHA256 Credential=ASIATEST123456789012/",
    )
    expect(new Headers(init.headers).get("x-amz-security-token")).toBe("session-test-token")
    const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString())
    expect(body.anthropic_version).toBe("bedrock-2023-05-31")
    expect(body.stream).toBeUndefined()
    return new Response(Buffer.concat(frames), {
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    })
  })
  const model = { ...anthropicModels[0]!, id: "anthropic.claude-test-v1" },
    client = createCloudProvider(
      { kind: "bedrock", region: "us-east-1", tokenFile: path },
      { models: [model] },
    )
  const run = async () => {
    const events: ProviderStreamEvent[] = []
    for await (const event of client.stream(
      { model, system: "", messages: [], tools: [] },
      new AbortController().signal,
    ))
      events.push(event)
    expect(events).toContainEqual({ type: "text_delta", text: "bedrock hello" })
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" })
  }
  await Promise.all([run(), run()])
  expect(exchanges).toBe(1)
  expect(requests).toBe(2)
})
