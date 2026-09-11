# CodeSplash embedding SDK

Run with **Bun >=1.3.14** on macOS or Linux. The ESM exports are `codesplash-agent`,
`codesplash-agent/sdk` (same facade), and `codesplash-agent/extensions` (extension API types and
identifier helpers). Import is inert. Node can import the facade/types; starting a session or
reviewing an integration under Node throws an explicit Bun-required error. Internal paths are
not supported exports. The 0.x SDK may change in minor releases; extension API version is 1.

```ts
import { createAgentSession } from "codesplash-agent"
const session = await createAgentSession({ cwd: process.cwd() })
try {
  session.subscribe(event => {
    if (event.kind === "message.delta") process.stdout.write(event.payload.text)
  })
  const result = await session.prompt("Explain this project")
  console.log(result.status, session.usage)
} finally {
  await session.close()
}
```

This uses the native configured provider and credentials, just like the CLI. The numbered examples
instead supply a local scripted provider and disposable fixtures; no account or paid calls are needed.
Run `bun node_modules/codesplash-agent/examples/sdk/01-minimal.ts`, or copy the entire example directory
into an application that has installed `codesplash-agent`. Each example prints `SDK_EXAMPLE_OK`.

| Example | Exercises |
|---|---|
| 01-minimal.ts | Ephemeral prompt, event subscription and close |
| 02-recorded-resume.ts | Explicit recording root, lease release, replay and cumulative usage |
| 03-streaming-tool.ts | Schema validation, native approval, progress, file checkpoint targets |
| 04-mcp-resource-elicitation.ts | Real local HTTP/SSE MCP, deferred selection, resources, images and form response |
| 05-hook.ts | Fingerprint-reviewed native HTTP hook and input rewrite |
| 06-provider-auth.ts | Host provider/auth callback, credential redaction and unpriced usage |
| 07-ui-extension.ts | Owned status/widget/composer/dialog callbacks |
| 08-git-workflow.ts | Read-only Git status tool with fixed argv, deadline and output limit |

## Ownership and inputs

`createAgentSession` uses the native driver and the CLI/TUI session controller. Keep one owner and
always await `close()`; concurrent closes share completion. It installs no process signal handlers.
An optional creation `signal` fences startup and closes the live session on abort. Startup abort
waits for the engine's owned initialization to settle before returning; it never publishes the
cancelled session. Trusted host code must cooperate with cancellation.

`submit(input, intent?, submissionId?)` returns an input acknowledgment. `prompt(stringOrInput)`
submits and waits for its own input ID, returning `{id,status}`. Failure/cancellation/blocked or
uncertain status is explicit; a completed API call does not assert that every tool succeeded.
`waitForInput(id, signal?)` observes an existing input. Cancelling a wait stops waiting; call
`interrupt()` to cancel execution. Prompt refuses a paused queue before submitting.

`queue` returns the current snapshot. `inputs.pause/resume/edit/move/remove/retry/clearCompleted`
reuse the revision-checked M5 controls. Supply the snapshot revision when modifying it. Resume
holds recovered pending input for explicit review; uncertain effects require explicit acknowledgment
before retry. A resumed queue containing only finished inputs can accept a new prompt immediately.
No detached work, automatic retries of uncertain effects, or agent/subagent execution is added.

`subscribe` streams events; `subscribeState` observes copied reducer state; both return unsubscribe.
Exceptions in observers are isolated. `events()` creates an async iterator; call its `return()` if
abandoning it. There are at most eight feeds, 1,024 events/8 MiB buffered per feed, 128 event/state
listeners and 128 concurrent input waits. A slow feed fails explicitly without stopping recording.
The `state` and `usage` getters are snapshots. `onEvent` captures initial events as well.

## Approvals and configuration

Without a responder, approvals are declined and forms cancelled. Supply
`respond: async (request, signal) => ({choice: "accept", data: {...}})` only after the embedding
application has obtained the intended decision. Form fields are validated by the native engine.
The responder has a 30-second deadline and cancellation signal. `respond: "manual"` leaves requests
pending until `resolveRequest(request.id, decision)` or interrupt/close. Observers are not responders.

`config: {path, profile, overrides}` uses the same config resolver and managed ceiling as CLI.
`overrides` are bounded TOML assignments, e.g. `['permissions.mode="plan"','memory.enabled=false']`.
They are invocation-local and never saved. `workspaceTrusted` defaults to false; setting it true
explicitly authorizes trusted-project configuration. `trustDataDirectory` selects integration trust
storage, not a replacement for every application directory. Existing application config/data directory
environment variables still select user resources and memory. Credentials are not options data.

`tools` and `providers` are trusted application code registered as extension `sdk`. Use
`extensionToolId("sdk", name)` and `extensionModelId("sdk", providerName, modelName)` for identifiers.
`extensions: [{id,factory,flags?,overrides?}]` supplies version-1 factories. These use the same schema,
permission, checkpoint, auth redaction, usage, lifecycle and cleanup paths as file extensions.
They run with the embedding process's privileges; host callbacks are not an OS sandbox. Managed
extension IDs and disable settings still apply. `disableExtensions` is the recovery switch.
Provider-changing reload requires a new session. Tools must declare accurate effects and targets.

File integrations stay separate: call `reviewIntegration(options, kind, id)`, inspect its source and
fingerprint, then explicitly call `trustIntegration(options, kind, id, fingerprint)`. Kinds are `mcp`,
`hook`, and `extension`. The latter rechecks source identity before recording trust. Installing a
plugin does not grant execution trust.

## Recording and inspection

Default sessions do not persist conversation history. Set `persistence: {root}` to record with the
existing M5 store/recorder; `{root,resume:id}` reopens a native session. Configuration can prohibit
recording. Resume uses the recorded current workspace and rejects a conflicting explicit cwd.
Known non-bypass permission modes are retained unless an invocation override is supplied; current
managed policy remains authoritative. Missing native context produces a warning instead of claiming
that visible history is available to the model. `flush()` checks recorder failures; `close()` also
reports them after releasing ownership. History settings do not suppress explicitly requested tool,
package, credential or trust-store writes.

Model/context, compaction, history export, branch/checkpoint recovery, directory changes, presentation,
MCP/hooks/extensions/plugins and memory controls delegate to the native session and retain its idle,
trust, permission and recovery guards. UI operations require `interactive:true`; provide `onComposer`
for owned composer updates and a responder for dialogs. Status/widget text arrives in `extension.ui`.

The distributed SDK runs as JavaScript under Bun. The standalone CLI has separate compiled runtime
assets and acceptance. Compiling an arbitrary embedding application is not a supported SDK packaging
path: its entry point does not implement the CLI's internal sandbox worker dispatch.
