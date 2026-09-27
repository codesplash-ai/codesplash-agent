# Android / Termux installation gate

Android is experimental. The supported Bun artifacts target Linux libc, so this route uses a
Linux userland inside Termux. PRoot does not provide a security boundary. Android kernels commonly
refuse the namespaces required by the local tool sandbox; a successful CLI launch does not establish
local agent execution support. Use `attach` to an explicitly configured daemon on a supported host
when local sandbox enforcement is unavailable. Never resolve that refusal by automatically enabling
full access.

Install Termux from its maintained distribution, then follow the
[PRoot-Distro installation instructions](https://github.com/termux/proot-distro#installation).
For the current OCI-based PRoot-Distro CLI:

```sh
pkg install proot-distro
proot-distro install ubuntu:24.04 --name codesplash
proot-distro login codesplash
```

Inside that userland, install `ca-certificates`, `unzip`, `git`, `bubblewrap`, `socat` and `ripgrep`
with the distro package manager. Install Bun **1.3.14** for the matching Linux CPU using the
[official Bun installation instructions](https://bun.com/docs/installation). Keep the checkout,
config, data and temporary files in the Linux userland, away from Android shared storage.
Shared storage does not provide the filesystem permissions and link behavior needed by the agent.

From a reviewed CodeSplash source checkout:

```sh
bun install --frozen-lockfile --backend=copyfile
bun run build
bun dist/cli.js --version
bun dist/cli.js --doctor
bun scripts/m11-termux-smoke.ts
```

The gate requires an actual Android kernel and records its identity, CLI launch, local-storage
transactions and the observed sandbox capability. A local denial is an accepted *capability limit*,
not evidence that the sandbox works. A host-side Linux test or an environment variable pretending
to be Termux cannot satisfy the Android host gate. Retain the gate's JSON output with the source
manifest before changing the advertised support table.

No Android device was available for this implementation; these steps are an installation procedure
awaiting that gate, not a claim of a tested phone installation. Clipboard/notification integration
requires separately installed Termux:API and is not enabled implicitly.
