# Windows ACL helper deadline

`@anthropic-ai/sandbox-runtime@0.0.75.patch` extends only the four ACL setup/cleanup subprocess deadlines from 60 seconds to ten minutes. It does not change access rules, workload execution deadlines, executable integrity checks or error handling.

Measured on the disposable hosted Windows runner in diagnostic run 36563619900: grant 26.195s, revoke 7.080s, full-drive deny stamp 298.193s, restore 71.288s. The unmodified 60s deadline terminates valid initialization and cleanup. Five minutes leaves no useful headroom for the measured stamp. The outer supervisor transport reserves all four bounded phases in addition to the original workload deadline; each workload still receives its original `input.timeoutMs`.

Both Bun lockfile and the distribution CI Dockerfile include the patch. The diagnostic was successful, but is not enforcement acceptance; the native Windows gate must pass before this repair is accepted.
