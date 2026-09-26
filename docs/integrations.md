# CI and chat integrations

Integration workers own isolated native sessions and durable delivery ledgers. Only explicitly
allowlisted senders and conversations run work. Remote text enters as literal, untrusted user input;
it cannot invoke local slash commands or grant trust. Approval/user-input requests are declined.
Configure native model credentials and permission rules locally for the worker. No connector is
started merely by installing CodeSplash.

## GitHub App and Actions

`codesplash integrations github /absolute/operator.json` listens on loopback port 4097. Place an
operator-controlled TLS ingress in front of it. Configure your GitHub App's issue-comment webhook
at `/github/webhook`, subscribe to issue comments, and grant only the repository access needed.
A comment beginning with or containing `@codesplash` from an allowed actor creates a native turn and
posts its redacted answer back to that issue/PR. Bot messages, other repositories and other actors
are ignored. Webhooks must carry a valid HMAC signature and delivery ID.

```json
{
  "cwd":"/absolute/project", "root":"/absolute/github-worker", "port":4097,
  "appId":"12345", "privateKeyEnv":"CODESPLASH_GITHUB_PRIVATE_KEY",
  "webhookSecretEnv":"CODESPLASH_GITHUB_WEBHOOK_SECRET",
  "policy":{
    "repository":"OWNER/REPO", "repositoryId":"123456", "ref":"refs/heads/main",
    "workflowRef":"OWNER/REPO/.github/workflows/reusable.yml@refs/heads/main",
    "workflowSha":"REPLACE_WITH_40_CHARACTER_COMMIT_SHA", "audience":"codesplash",
    "installationId":12345, "allowedActors":["YOUR_LOGIN"]
  }
}
```

`/github/oidc` accepts a GitHub Actions OIDC token and returns a short-lived App installation token
restricted to the configured repository. Signature verification uses GitHub's fixed JWKS endpoint.
Issuer, audience, repository ID/name, branch, reusable `job_workflow_ref`/`job_workflow_sha`, actor,
expiry and event type must match. Use a pinned reusable workflow; pull_request and pull_request_target
claims are rejected. Used token IDs are retained on disk until expiry, including across worker restarts.

The composite action in `integrations/github/action.yml` runs an **already installed, pinned**
CodeSplash binary with `prompt-file`, optional `oidc-exchange-url`/`oidc-audience`, and `output-file`.
Use a commit-pinned action reference, protected workflow and operator-controlled prompt file. The
optional exchange requires `id-token: write` and exports `GH_TOKEN` for subsequent workflow steps;
the action's model run is read-only. It does not automatically check out or execute a PR head.
Avoid interpolating issue/PR text into shell source. Model credentials come from protected job secrets.
The GitLab recipe in `integrations/gitlab/codesplash.yml` follows the same installed-CLI/prompt-file
pattern with a protected, manual web-triggered job and result artifact.

## Slack Socket Mode

Enable Socket Mode and the `app_mention` event in your Slack app. Supply an app-level token with
`connections:write` and a bot token with `app_mentions:read` and `chat:write`. Invite the app only to
intended channels. Configure exact workspace, channel and user IDs:

```json
{
  "cwd":"/absolute/project", "root":"/absolute/slack-worker",
  "appTokenEnv":"CODESPLASH_SLACK_APP_TOKEN", "botTokenEnv":"CODESPLASH_SLACK_BOT_TOKEN",
  "policy":{"team":"T123","channels":["C123"],"users":["U123"]}
}
```

Run `codesplash integrations slack /absolute/operator.json`. Socket Mode uses outbound authenticated
connections and reconnects with bounded backoff. Replies stay in the originating thread, suppress
unfurls and neutralize broadcast mention markup. Event IDs deduplicate redeliveries.

Both connectors record admission before execution and record reply uncertainty before posting.
After a crash, queued/running/reply-uncertain entries require operator review; they never automatically
repeat model effects or external posts. Inspect `integration-github.json` or `integration-slack.json`
under the worker root, together with its session history. Resolve the outcome before deliberately
submitting a new delivery. Rotate a full ledger only after that review.

## GitHub PR checkout and linked session import

```sh
codesplash pr https://github.com/OWNER/REPO/pull/123
codesplash pr https://github.com/OWNER/REPO/pull/123 --apply --trust
# Add --import-session to import the one HTTPS share link in the PR body.
```

The first command previews metadata using your GitHub CLI authentication. Apply fetches the exact PR
head, verifies it still matches the reviewed metadata, and creates an isolated managed worktree.
It leaves your current checkout intact and does not execute repository hooks/install scripts.
Native trust, bash/worktree policy and protected paths still apply. Linked-session import retains
foreign provenance and does not execute imported actions. A checkout can remain if later import
fails; inspect it through `codesplash worktree list`.

External deployment needs your App installation, CI secrets/permissions, Slack app and TLS ingress.
Repository acceptance uses local protocol fixtures; it does not send live GitHub/Slack messages.

References: [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc),
[Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).
