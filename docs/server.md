# Server, editor and remote clients

The native daemon owns the model loop, permissions and durable session history. Browser, terminal,
ACP and MCP clients use that owner. Authentication does not grant workspace trust or bypass approval.
Trust a workspace locally through the normal native terminal flow before enabling project resources
or language services. The daemon reads that recorded decision when opening a session.

## Start and attach

```sh
codesplash serve --cwd /absolute/project --root /absolute/daemon --port 4096 --share manual
codesplash daemon status --root /absolute/daemon
codesplash daemon pair --root /absolute/daemon
codesplash attach THREAD_UUID --root /absolute/daemon --shared
```

Open the printed loopback URL and enter the pairing code or the token from the printed credential
file. Pairing codes expire after two minutes and work once; browser cookies expire after eight hours.
The token and daemon directory are private local files. Credentials never belong in URLs.
Use `--reader`, `--shared` or `--exclusive` for terminal attachment. `--steal` explicitly interrupts
current work, declines pending requests and revokes existing writers. Shared writers submit through
the same serial queue; readers cannot approve, interrupt, share or submit. Leases expire after 60
seconds and clients renew them. Losing the last writer interrupts its work.

Stop the foreground daemon with Ctrl+C. It holds an OS-backed lock for its history root. Restart
restores observation; a writer must explicitly resume the session. Pending/uncertain inputs do not
execute on reconnect. Snapshots/replay retain a bounded public window; full native history remains
in the private session store. Slow event consumers disconnect and must resnapshot. A connection
supports 4,096 request IDs or a 16 MiB request/result cache before reconnection is required.

A LAN listener requires a concrete interface and TLS: add `--listen 192.0.2.10 --tls-cert cert.pem
--tls-key key.pem`. Optional `--mdns` advertises `_codesplash._tcp.local` on that interface without
credentials. Configure certificates and network access as the operator; wildcard binds are rejected.

## Protocol clients

`codesplash serve --stdio --cwd DIR` serves native wire version 1 as bounded newline-delimited
JSON-RPC 2.0. HTTP uses `POST /rpc` and `GET /events` (SSE), authenticated with `Authorization: Bearer
TOKEN`. Initialize with `{version:1,client:"my-client",experimental:["sharing","tui-control"]}`.
Use the returned connection ID in `x-codesplash-connection`; SSE accepts the non-secret connection
ID in its query string. Request IDs are immutable idempotency keys within that connection.

Methods include `thread/list`, `thread/create`, `thread/resume`, `thread/snapshot`, `thread/replay`,
`lease/acquire|renew|release`, `turn/start|interrupt`, `request/respond`, `thread/close`,
`fuzzyFileSearch`, `tui/control`, and `share/create|revoke`. A turn submission ID uses the current
`inputEpoch` plus `.` and a unique suffix. Threads are restricted to the daemon's workspace roots.
Approval events contain the request ID, choices and optional typed form. Responses require a current
writer lease and a still-pending request. Public events omit reasoning, raw provider payloads,
extension UI and hook payloads, and apply credential redaction.

`codesplash generate OUTPUT_DIR` creates TypeScript request types, JSON Schema and OpenAPI without
overwriting files. Experimental controls require initialization opt-in. `POST /tui/prompt`,
`/tui/dialog` and `/tui/toast` accept `{requestId,threadId,lease,text}` and the same authentication
and connection header. Prompt control updates a draft; it does not submit work.

`codesplash acp --cwd DIR` implements ACP v1 over stdio: initialize, new/load session, text and
embedded text/resource-link prompts, streaming updates, permission requests and cancellation.
Client-supplied MCP execution, image prompts and user-input forms are not advertised as supported.
`codesplash mcp-server --cwd DIR` exposes `codesplash` and `codesplash-reply` using MCP 2025-11-25.
Clients with form elicitation can answer approval callbacks; other clients decline approval.
Both adapters inherit native restrictions and isolate stdio histories from the HTTP daemon.

## VS Code and file links

```sh
codesplash ide install code
# Or create a distributable local package:
codesplash ide package /tmp/codesplash.vsix
```

In VS Code, run **CodeSplash: Connect to Daemon**, select the local daemon directory and session,
then **Send Selection and Open Tab Context**, **Find File in Session**, or **Attach Terminal**.
The extension sends bounded explicit context and uses a shared lease. Approvals remain in the
attached terminal/browser. It does not execute project-provided configuration. `ide install` also
accepts `code-insiders` and `cursor`; it requires the editor's CLI. Terminal citations such as
`src/main.ts:12` become file hyperlinks in completed messages when the terminal supports OSC 8.

## Reviewed language services

Language execution is opt-in: install an operator-owned descriptor and locally trust the workspace.
For example, a preinstalled language server descriptor:

```json
{"id":"typescript","languageId":"typescript","extensions":[".ts",".tsx"],"kind":"lsp","command":["/absolute/typescript-language-server","--stdio"]}
```

```sh
codesplash lsp review /absolute/typescript.json
codesplash lsp install /absolute/typescript.json --sha256 REVIEW_FINGERPRINT
codesplash lsp list
```

Review binds descriptor content, executable bytes, and absolute file arguments such as launch scripts.
For managed downloads, use `command:["{binary}","--stdio"]` and a `download` object containing
`url` (HTTPS), `sha256` (the exact downloaded bytes) and optional `compression:"gzip"`. Download
occurs on first use after review, rejects redirects/checksum mismatches, and repairs modified cached
binaries. Verified download bytes are staged in a private, read-only launch directory so the server
cannot read the app-data store. Local commands and their dependencies still need sandbox read access.
This is an explicit descriptor mechanism, not a bundled server catalog or a project package
installer. Review the server and its dependency/configuration loading behavior before enabling it.

The `lsp` tool supports `definition`, `references`, `hover`, `diagnostics` and `symbols`; positions
are zero-based UTF-16. Servers run through native read-only sandbox duplex transport. Workspace
read roots, denied paths and permission rules apply. Server-initiated edits/commands are rejected.
Post-edit tool results include current versioned diagnostics; unversioned/stale diagnostics are
omitted with a pending indication. Symbol results are cached by content hash.

Descriptors with `kind:"formatter"` run a reviewed command on stdin and write its stdout back through
the native file tool inside the original edit's checkpoint. `{file}` substitutes the canonical path.
Formatting needs workspace-write and explicit allow decisions for formatter/write_file; ask/deny
rules prevent automatic formatting. Failure, concurrent edits, truncation or redaction preserve the
original edit. A `kind:"tree-sitter"` descriptor can run a reviewed tree-sitter query command with
`{file}` as the optional symbol backend when no LSP matches. Its captures use the same hash cache and
read policy. Project text never becomes a shell command.

## Sharing and import

Sharing defaults to **disabled**. Choose `--share manual`, `auto` or `disabled` at daemon startup.
In an attached terminal use `/share` and `/unshare SHARE_ID`; the browser offers Share and Revoke
last share. Auto mode creates a new immutable export after each newly completed turn. Exports omit
images and redact known credentials, paths and personal details using native portable-export rules.
Redaction is best effort: review the content before distributing a bearer link. Anyone with a link
can read it until revocation. The daemon must remain reachable to serve it.

```sh
codesplash session import https://your-daemon/share/CAPABILITY/bundle
# Review the preview and its digest, then use --apply --sha256 DIGEST.
```

Import permits HTTPS or loopback HTTP, follows no redirects, limits downloads, validates the portable
bundle, and preserves foreign provenance. It never resumes effects. `CODESPLASH_DISABLE_SHARING=1`
or a file named `disabled` inside the daemon's `shares` directory immediately disables creation and
retrieval. Revocation removes the stored export; auto mode does not revoke older exports for you.

## Headless execution controls

`run --input-format stream-json` consumes one `{ "type":"user", "text":"..." }` frame at a time,
waiting for each turn before the next. Input is bounded by frame and native prompt limits; output
backpressure has a timeout. A failed frame/turn stops the stream. Recovery queues remain held.
`--output-schema JSON` (or `@FILE`) validates the final response as JSON without retrying effects;
`--output-last-message FILE` atomically replaces a file only after successful validation.

`--tools a,b` and `--exclude-tools c,d` constrain actual tool dispatch. `--agent ID` uses an existing
reviewed native child role, with ordinary approval/scoping. `--max-budget-usd N` reserves cumulative
estimated model cost across root and child work and restores recorded spend on resume. Missing prices,
missing usage or uncertain reservations stop further model work; embeddings are disabled under this
ceiling. Catalog estimates are not a provider billing guarantee. The SDK exposes these as `execution`,
`agent` and `outputSchema`; schema validation applies to `prompt`, which requires one active prompt
at a time. Low-level `submit`/`waitForInput` callers own result validation.

## CI, chat and desktop

See [integration setup](integrations.md) for operator configs, pinned CI recipes and PR import.
The [desktop prototype decision](../integrations/desktop/DECISION.md) documents the bounded Electron
exploration. `codesplash open codesplash://session/UUID` previews external provenance; `--attach`
selects a local reader. Deep links cannot carry prompts, credentials or permission changes. Signed
GUI distribution and OS handler installation are not shipped in M9.

Protocol references: [ACP](https://agentclientprotocol.com/protocol/v1/initialization),
[MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
