import { expect, test } from "bun:test"
import { createHmac, generateKeyPairSync, sign } from "node:crypto"
import { join } from "node:path"
import { ChatBridge } from "../../src/integrations/bridge.ts"
import {
  GithubApp,
  type GithubPolicy,
  verifyGithubOidc,
  verifyGithubWebhook,
} from "../../src/integrations/github.ts"
import { SlackSocketBridge } from "../../src/integrations/slack.ts"
import { Hub } from "../../src/server/hub.ts"
import { fixture } from "./fixture.ts"

test("GitHub OIDC verifies signatures and exact pinned workflow claims, not decoded JWT claims", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const policy: GithubPolicy = {
    repository: "owner/repo",
    repositoryId: "12",
    ref: "refs/heads/main",
    workflowRef: "owner/repo/.github/workflows/agent.yml@refs/heads/main",
    workflowSha: "a".repeat(40),
    audience: "codesplash",
    installationId: 123,
    allowedActors: ["maintainer"],
  }
  const seconds = Math.floor(Date.now() / 1000)
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: policy.audience,
    repository: policy.repository,
    repository_id: policy.repositoryId,
    ref: policy.ref,
    job_workflow_ref: policy.workflowRef,
    job_workflow_sha: policy.workflowSha,
    actor: "maintainer",
    event_name: "workflow_dispatch",
    iat: seconds,
    exp: seconds + 300,
    jti: "unique",
  }
  const jwt = (value: unknown) => {
    const content = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url")}.${Buffer.from(JSON.stringify(value)).toString("base64url")}`
    return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`
  }
  const fetcher = (async () =>
    Response.json({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" }],
    })) as unknown as typeof fetch
  expect((await verifyGithubOidc(jwt(claims), policy, fetcher)).jti).toBe("unique")
  for (const patch of [
    { repository_id: "99" },
    { actor: "outsider" },
    { job_workflow_sha: "b".repeat(40) },
    { event_name: "pull_request_target" },
    { exp: seconds - 1 },
  ])
    await expect(verifyGithubOidc(jwt({ ...claims, ...patch }), policy, fetcher)).rejects.toThrow("claims")
  const token = jwt(claims).split(".")
  token[1] = Buffer.from(JSON.stringify({ ...claims, repository_id: "99" })).toString("base64url")
  await expect(verifyGithubOidc(token.join("."), policy, fetcher)).rejects.toThrow("signature")
  const body = '{"action":"created"}',
    signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`
  expect(verifyGithubWebhook(body, signature, "secret")).toBe(true)
  expect(verifyGithubWebhook(`${body} `, signature, "secret")).toBe(false)
  const f = await fixture(),
    hub = await Hub.open(f.options),
    bridge = new ChatBridge(hub, join(f.cwd, "github.json"), f.cwd)
  let exchanges = 0
  const options = {
    policy,
    appId: "123",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    webhookSecret: "secret",
    bridge,
    fetcher: (async (url: string | URL | Request) => {
      if (String(url).includes("jwks")) return fetcher(url)
      exchanges++
      return Response.json({
        token: "fixture-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      })
    }) as unknown as typeof fetch,
  }
  const exchange = () =>
    new Request("http://127.0.0.1/github/oidc", {
      method: "POST",
      body: JSON.stringify({ token: jwt(claims) }),
    })
  try {
    expect((await new GithubApp(options).route(exchange())).status).toBe(200)
    expect((await new GithubApp(options).route(exchange())).status).toBe(403)
    expect(exchanges).toBe(1)
  } finally {
    await bridge.close()
    await hub.close()
    await f.clean()
  }
})
test("chat and Slack deduplicate deliveries, enforce allowlists and retain uncertain replies", async () => {
  const f = await fixture(),
    hub = await Hub.open(f.options),
    path = join(f.cwd, "chat.json"),
    bridge = new ChatBridge(hub, path, f.cwd)
  await bridge.start()
  const replies: unknown[] = [],
    acks: unknown[] = []
  const slack = new SlackSocketBridge({
    appToken: "fixture",
    botToken: "fixture",
    bridge,
    policy: { team: "T", channels: ["C"], users: ["U"] },
    fetcher: (async (_url: string | URL | Request, options?: RequestInit) => {
      replies.push(JSON.parse(options!.body as string))
      return Response.json({ ok: true })
    }) as unknown as typeof fetch,
  })
  const envelope = {
    envelope_id: "envelope",
    type: "events_api",
    payload: {
      event_id: "event",
      team_id: "T",
      event: { type: "app_mention", user: "U", channel: "C", ts: "123.456", text: "@codesplash hello" },
    },
  }
  try {
    await slack.envelope(envelope, (v) => acks.push(v))
    await slack.envelope(envelope, (v) => acks.push(v))
    expect(replies).toHaveLength(1)
    expect(f.calls()).toBe(1)
    expect(acks).toHaveLength(2)
    expect(replies[0]).toMatchObject({ channel: "C", thread_ts: "123.456", parse: "none" })
    await slack.envelope(
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          event_id: "outsider",
          event: { ...envelope.payload.event, user: "outsider" },
        },
      },
      () => {},
    )
    expect(f.calls()).toBe(1)
    await expect(
      bridge.deliver(
        { delivery: "uncertain", conversation: "new", text: "test", provenance: "fixture" },
        async () => {
          throw new Error("delivery uncertain")
        },
      ),
    ).rejects.toThrow("uncertain")
    const after = f.calls()
    expect(
      await bridge.deliver(
        { delivery: "uncertain", conversation: "new", text: "test", provenance: "fixture" },
        async () => {},
      ),
    ).toMatchObject({ duplicate: true, status: "reply-uncertain" })
    expect(f.calls()).toBe(after)
  } finally {
    slack.close()
    await bridge.close()
    await hub.close()
    await f.clean()
  }
})
