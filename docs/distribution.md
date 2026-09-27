# Distribution, enterprise credentials and platform controls

These surfaces extend the existing CLI and Bun SDK. Windows and Android/Termux are not promoted by
this work: the Windows native backend and Android install procedure still require real Windows/Termux host acceptance. Hosted
CodeSplash accounts, cloud execution and cross-device sync are a separate product decision.

## Signed standalone updates

`codesplash update status` reports the detected installation method. Homebrew, npm and Scoop
installations retain their package manager; this command does not silently replace their files.
For a standalone installation, create `updates.json` in the CodeSplash user config directory:

```json
{
  "version": 1,
  "root": "/absolute/path/to/dedicated/codesplash-install",
  "manifestUrl": "https://releases.example.com/stable/manifest.json",
  "keys": { "release-2026": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" },
  "policy": { "channel": "stable", "minimum": "0.1.4" },
  "configPath": "/absolute/path/to/config.toml"
}
```

Trust keys come from your release administrator. The example URL is not a CodeSplash release
service. `policy` also accepts `maximum` and an exact `pin`; `alpha` admits prereleases. Updates
require Ed25519 signatures, expiry, monotonic revision, the host target, bounded files and SHA-256
checksums. Release files are downloaded individually; executable installer scripts are not accepted.

```sh
codesplash update check
codesplash update apply --apply
codesplash update rollback --apply
codesplash update recover --finish --apply
# Alternatively abandon an interrupted activation:
codesplash update recover --rollback --apply
```

Use `INSTALL_ROOT/current/codesplash` as the launcher. Version directories retain the previous
installation. An activation journal coordinates the active pointer and data-only TOML key renames.
Recovery refuses to overwrite config changed by another writer. Rollback preserves the highest
accepted release revision and must still satisfy current managed version bounds. A pinned/minimum
policy can therefore refuse rollback. Old directories are retained; `disk` does not delete them.
The standalone path is locally tested on macOS/Linux; Windows activation remains unaccepted.

Release authors run `bun scripts/release-manifest.ts ASSET_DIR HTTPS_BASE_URL REVISION
PRIVATE_KEY_FILE KEY_ID OUTPUT_FILE` after building. The key is read from a file, never an argv
value. This writes a signed manifest and does not publish anything. Publish exactly the signed
files beneath that HTTPS base. OS signing/notarization remains separate from manifest signing.

## Fleet policy and feature controls

Fixed trust-descriptor locations are `/etc/codesplash-agent/fleet.json`, additionally
`/Library/Managed Preferences/com.codesplash.agent.fleet.json` on macOS, and
`C:\ProgramData\CodeSplash\fleet.json` on Windows. macOS also accepts a managed preferences plist
at `/Library/Managed Preferences/com.codesplash.agent.plist` whose `Fleet` string contains the JSON
descriptor. Unix system descriptors and their physical parent directories must be root-owned and not
group/world writable. Descriptor symlinks are refused. Windows system descriptors validate numeric administrator SIDs and reject writable or reparse-point
paths through their parent chain. A user descriptor may also live at `CONFIG_DIR/fleet.json`.
Changing the user config directory does not disable the fixed system locations.

A descriptor contains `version: 1`, pinned public `keys`, and an embedded signed `document` or
HTTPS `url`. Missing required documents, invalid signatures, expiry and incompatible versions
fail explicitly. `codesplash fleet refresh DESCRIPTOR --apply` is the only network refresh path;
`fleet status` reports revisions and fingerprints without keys. Administrators must arrange write
access for system-policy refresh. A rejected refresh preserves the last accepted cache.

The signed payload uses `kind: "fleet"`, `version: 1`, increasing `revision`, and millisecond
`issuedAt`/`expiresAt`. Its `constraints` use the managed schema (including plugin/MCP ceilings and
`featureIds`); multiple allowlists intersect, deny lists accumulate, and conflicting requirements
are rejected. `versions` sets the same bounds as update policy. Host administrators remain trusted;
this is not protection against an administrator replacing the executable or trust roots.

Optional signed `settings`:

- `disableFeatures`: advanced-tool kill switches, checked again at dispatch.
- `announcements`: bounded inert `{id,text,minimum?,maximum?}` notices.
- `campaign`: an opt-in `{id,theme}` default. User theme choices take precedence; no scripts run.
- `identityKinds`, `identityTenants`, `apiKeyProviders`: exact identity ceilings.
- `network`: `offline`, exact `allowedHosts` entries such as `api.openai.com:443`, `proxy`,
  `extraCA`, `requireExtraCA`, and `timeoutMs`.

`codesplash features list` exposes the lifecycle registry for eight advanced native tool groups.
Use `features set NAME on|off|default --apply`, `features announcements`, `features dismiss ID
--apply`, or `features campaigns on|off --apply`. New tools become visible when a session opens;
remote disablement is checked before existing advanced tools execute. This registry does not claim
that every third-party engine flag is remotely controllable.

## Enterprise provider identities

Custom providers retain their existing `protocol`, `baseUrl` and `models` configuration and may
add an `identity` table. Credentials never belong in TOML. Supported explicit paths are:

| Kind | Protocol | Identity fields / credential source |
| --- | --- | --- |
| `bedrock` | `anthropic` | `region`; AWS access-key/session environment, or `tokenFile` plus `AWS_ROLE_ARN` |
| `vertex` | `anthropic` | `project`, `region`; `GOOGLE_APPLICATION_CREDENTIALS` service-account JSON, or `tokenFile` and IAM `audience` |
| `azure` | `openai` | `tenant`, `clientId`; workload `tokenFile` or `clientSecretEnv` (default `AZURE_CLIENT_SECRET`) |
| `azure` device | `openai` | Explicit `tenant`, registered public `clientId`, `authMode = "device"` |
| `openai-workload` | `openai` | `tokenFile`, `identityProviderId`, `serviceAccountId` |

Azure uses an official `https://RESOURCE.openai.azure.com/openai/v1` or
`https://RESOURCE.services.ai.azure.com/openai/v1` endpoint. OpenAI workload credentials only go to
`https://api.openai.com`. Bedrock and Vertex construct official region/project endpoints and
currently map the Anthropic Messages protocol. Bedrock uses the AWS SDK for request signing and
stream decoding. Google service-account assertions, OIDC exchanges and Azure token requests use
fixed provider token endpoints through the shared transport. Arbitrary credential commands and
metadata/CLI credential discovery are not implemented.

```toml
[providers.enterprise]
protocol = "openai"
baseUrl = "https://RESOURCE.openai.azure.com/openai/v1"
api = "responses"
[providers.enterprise.identity]
kind = "azure"
tenant = "TENANT_ID"
clientId = "REGISTERED_CLIENT_ID"
authMode = "device"
[[providers.enterprise.models]]
id = "YOUR_DEPLOYMENT"
contextWindow = 128000
maxOutputTokens = 8192
```

Run `codesplash identity login enterprise` when ready to authorize the device. Login displays the
provider's verification page and code, honors pending/slowdown/expiry, and stores the refresh token
in the OS credential store. `identity logout enterprise` removes the local credential. Refresh is
bounded; concurrent device refresh shares one request within a process, and a local ownership
lease serializes OS-store rotation with other processes and logout. No refresh token is written to
the lease file. Tenant/provider permissions are enforced by the
identity service; the client does not treat unverified JWT claims as authorization.

Native OpenAI/Anthropic API-key login remains available. `codesplash login openai --keyring` reads
an API key from hidden terminal input or stdin and stores it in the OS credential store. An
unavailable/locked store fails; it never silently falls back to plaintext. Without `--keyring`,
the existing owner-only file store remains explicit. Exported environment credentials take
precedence. Credentials hydrated from storage are removed from model command environments.
There is no native subscription-login flow that borrows another product's private CLI tokens.
Cloud protocol fixtures do not establish live tenant/provider acceptance.

Provider contracts: [OpenAI workload exchange](https://developers.openai.com/api/reference/workload-identity-federation),
[AWS Messages](https://docs.aws.amazon.com/bedrock/latest/userguide/api-inference-examples-claude-messages-code-examples.html),
[Vertex Claude](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude),
[Azure Entra](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id),
[Azure device flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).

## Network and sandbox controls

`codesplash --offline COMMAND ...` (or `CODESPLASH_OFFLINE=1`) refuses governed outbound requests before I/O. `CODESPLASH_PROXY` selects an
HTTP(S) proxy. Bun's standard HTTP_PROXY/HTTPS_PROXY/NO_PROXY behavior remains available for direct
HTTP requests. The native broker can chain CONNECT through the explicit proxy while retaining its
own destination/DNS checks. `CODESPLASH_HTTP_TIMEOUT_MS` accepts 100–300000 milliseconds.
`CODESPLASH_EXTRA_CA` adds a PEM CA bundle to platform trust. A malformed optional bundle produces
a diagnostic and uses platform trust; `CODESPLASH_REQUIRE_EXTRA_CA=1` instead fails closed. TLS
verification stays enabled. Upload circuit breaking stops repeated failing telemetry, feedback and generation uploads;
it does not replay an uncertain upload. Model-tool networking still requires sandbox grants.
These host HTTP controls do not sandbox arbitrary external programs or other engines' transports.

Custom `[sandbox]` `denyRead` and `denyWrite` accept absolute paths/globs. A glob is converted to
its literal containing directory, denying siblings as well as all future matches. This conservative
kernel restriction avoids calling a one-time filesystem scan a durable deny rule. For example,
`/repo/secrets/**/*.pem` denies the entire `/repo/secrets` tree. Root-wide globs are rejected.
`codesplash sandbox --deny-read PATH --deny-write PATH -- CMD ...` applies these controls to a whole
command process tree. Use `isolate` below for the separate first-party startup boundary.

On Linux cgroup v2, `[sandbox.limits] memoryMiB = 512` and `processes = 64` require a delegated
user systemd manager. The supervisor enters a scope with MemoryMax, zero swap allowance, TasksMax,
OOM kill policy and group teardown. Unsupported hosts refuse configured limits. Existing reviewed
container environments retain their no-network/no-host-mount, capability, PID, memory and deadline
limits. Windows uses the pinned restricted-token/WFP backend described below; micro-VM routing is described below.

## Explicit startup hardening

Start with `codesplash --harden ...` or `CODESPLASH_HARDEN=1`. On macOS and GNU/Linux ARM64/x64,
the process disables core dumps and debugger attachment before opening credentials or sessions;
Linux also sets and verifies `no_new_privs` on the calling thread. Unsupported platforms or failed
kernel calls refuse startup. `--harden --build-info` reports the applied controls. Loader/startup
environment variables are removed before child launch; these controls take effect after the runtime
has loaded and do not undo code already loaded by the OS. They are process hardening, not the
remaining whole-agent filesystem/network isolation or a guarantee about other pre-existing threads.

## Other distribution surfaces

- `codesplash disk`: bounded owned config/data accounting, skipping symlinks and duplicate inodes.
- `codesplash --build-info`: machine-readable build name, command, variant, support URL and version.
- Fixed argv0 aliases: `codesplash-sandbox`, `codesplash-key-proxy`, `codesplash-wrap`.
- `codesplash key-proxy --config FILE`: loopback-only, capability-authenticated provider proxy.
  Config is `{version:1,provider:"openai",secret:"NAMED_OS_SECRET",origin:"https://api.openai.com"}`.
  Only fixed provider POST routes are allowed. A private connection file supplies the temporary
  client credential; the upstream key stays in the proxy. Closing the command removes that file.
- `codesplash wrap [--clipboard] -- CMD ...`: owned sandboxed PTY/stdin/resize/cleanup. Clipboard
  writes require the flag; clipboard queries, incoming passthrough strings and proprietary clipboard
  controls are not relayed. Only validated OSC 52 writes and ordinary title/path/hyperlink OSCs
  pass. tmux OSC 52 wrapping is supported.
- `bun scripts/build-release.ts --unsigned --brand-config FILE`: build-time name/command/variant/
  support URL for forks. Runtime workspace files cannot rebrand the executable. Internal variants
  cannot use the public signing path; fork package-manager names and trust roots remain operator-owned.
- `bun run docs:build`: offline public docs package under `out/docs`. Only allowlisted public
  sources are read. `bun scripts/build-docs.ts OUTPUT PUBLIC_STATS_JSON` adds an explicitly selected
  aggregate snapshot, discarding model names, project paths and other fields. Nothing is uploaded.
- `packaging/ci/Dockerfile`: Bun-pinned non-root CI image definition. Native Linux sandbox tests
  still require host support for unprivileged namespaces; denied kernel features fail explicitly.

Automation uses the existing `run --output-format json|stream-json`, `--input-format stream-json`,
finite turn/budget limits and `--no-history` flags. New status commands emit JSON. Internal worker
flags are implementation details and are not a public automation API.


## Package-manager updates

Add `manager` to `updates.json` to preserve manager ownership:

```json
"manager": {
  "kind": "npm",
  "executable": "/absolute/path/to/npm",
  "installRoot": "/absolute/path/to/npm-global-prefix"
}
```

`kind` is `npm`, `homebrew` or `scoop`. For Homebrew, `installRoot` is the
`Cellar/codesplash-agent` directory; for Scoop it is `apps/codesplash-agent`. The executable is the
reviewed absolute manager executable (Scoop's `scoop.ps1`). The usual `apply`, `recover` and
`rollback` commands use a separate durable package journal and preserve the signed revision floor.
Config edits by another writer stop recovery. A detected manager installation refuses standalone
update configuration.

For npm, signed `npmArtifacts` must include the current and target tarballs, each with `version`,
HTTPS `url`, `size` and `sha256`. Both are verified and cached before installation. npm runs with
`--ignore-scripts --offline`; dependency cache misses fail explicitly. Release authors can add
`--npm-artifacts DESCRIPTORS.json` to the manifest builder; the descriptor array contains `version`,
local `path` and HTTPS `url`, and the builder computes hashes and sizes. No package is published.

Homebrew/Scoop must offer the exact signed version in their reviewed formula/manifest. Existing
version directories are retained for rollback. Homebrew activation uses its fixed Keg API and
Scoop uses its versioned reset command. Their normal package integrity checks remain enabled.
Offline policy refuses these external manager invocations. Scoop execution still requires a real Windows host gate; npm and Homebrew upgrade/rollback
have actual isolated-prefix tests.

## Whole-agent startup filesystem isolation

Create a profile outside the workspace; all roots must already exist and use physical absolute paths:

```json
{
  "version": 1,
  "workspace": "/absolute/project",
  "configDirectory": "/absolute/codesplash-config",
  "dataDirectory": "/absolute/codesplash-data",
  "readRoots": [],
  "environment": ["ANTHROPIC_API_KEY"]
}
```

Run `codesplash isolate PROFILE.json -- run -p "inspect this project" --trust`, or use another public
agent command. Seatbelt (macOS) or bubblewrap (Linux) confines the first-party process before its
Bun runtime loads credentials or opens sessions. It can read its reviewed config, write its state
and workspace, and read the system/runtime installation. It cannot write its config or installation.
Environment credentials are passed only by explicit name; loader and directory overrides are refused.
The first-party agent retains network access under the normal managed transport policy. This outer
layer is filesystem isolation, not an additional kernel network allowlist.

A private parent supervisor starts each stricter tool sandbox; macOS forbids nested Seatbelt
initialization. Requests cannot widen the startup filesystem grants, grant tools access to agent
config/state, or select a plan file outside the workspace. Supervisor temporary files are owned
outside the confined process. Ordinary commands, streaming subprocesses and PTYs use the same
bridge, and connection closure cancels owned work. Real macOS/Linux tests cover host-file denial,
state writes, tool-state denial and the process transports. Windows startup isolation refuses explicitly.

## Dedicated ephemeral micro-VMs

An `--environments FILE` entry can select a Linux-host QEMU `microvm` machine:

```json
{
  "id": "isolated-vm",
  "transport": "microvm",
  "executable": "/usr/bin/qemu-system-x86_64",
  "kernel": "/absolute/boot/kernel",
  "kernelSha256": "REPLACE_WITH_64_HEX_SHA256",
  "initrd": "/absolute/boot/initrd",
  "initrdSha256": "REPLACE_WITH_64_HEX_SHA256",
  "memoryMiB": 256,
  "accelerator": "tcg",
  "bootTimeoutMs": 60000
}
```

Use an x86-64 Linux kernel and initramfs containing `/bin/busybox` with sh, mount, timeout and reboot
applets. Boot assets are size bounded, hash checked and copied to an owned invocation directory.
`tcg` supports software emulation; `kvm` requires host KVM support and never falls back silently.
The runtime and boot files must stay outside model-writable roots. Each approved command gets a new
guest with one CPU, bounded memory, no NIC, host mount, persistent disk or monitor socket. Work runs
in guest `/workspace`; files disappear at shutdown and are never imported into the host automatically.
Guest deadlines, cancellation and host process cleanup are bounded. Console text is untrusted tool
output. The actual QEMU gate covers host-file/network denial, ephemeral state and teardown.

The implementation follows the [QEMU microvm boot/shutdown contract](https://www.qemu.org/docs/master/system/i386/microvm.html)
and [Linux concatenated initramfs format](https://www.kernel.org/doc/html/latest/driver-api/early-userspace/buffer-format.html).
Run `bun scripts/m11-microvm-smoke.ts BOOT_ASSET_DIRECTORY` on Linux with reviewed `kernel`/`initrd` files.

## Native Windows acceptance

Windows x64 remains experimental until its real-host gates pass. `windows-sandbox install --apply`
explicitly provisions the pinned upstream sandbox account and WFP filters through UAC;
`windows-sandbox status` inspects setup, `verify` proves denied direct egress, and
`uninstall --apply` removes the setup. Provisioning is never an implicit tool side effect.
The package pins the helper's SHA-256 and refuses missing/changed helpers. It uses restricted tokens,
filesystem ACL grants/denials, WFP and owned job objects. Inability to apply any required boundary
stops execution. ACL stamping at drive roots can require administrator rights. CodeSplash serializes
its Windows sandboxes because overlapping profiles share the upstream account; do not concurrently
share that account with other sandbox-runtime applications.

Local session transactions use NTFS handle-relative opens, reject reparse points, and hold ancestor
handles without delete sharing. Remote filesystems are refused. Data files are flushed before atomic
activation; Windows directory-fsync guarantees differ from POSIX. The native FFI adapter currently
requires x64; ARM64 refuses these operations. System policy checks use numeric SIDs rather than
localized account names. The CI gate exercises native transactions, provisions the disposable runner,
verifies WFP, then probes native denial/cancellation and removes setup in an `always()` step.
No Windows acceptance or first-class support promotion is inferred from macOS/Linux tests.

For Android, see the [Termux installation and capability gate](termux.md).
