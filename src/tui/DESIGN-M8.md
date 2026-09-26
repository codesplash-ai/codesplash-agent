# M8 terminal experience — binding contracts

Baseline M7 runtime and ownership remain authoritative. M8 extends the human interface, not the
agent permission model. All eleven roadmap rows are delivered in ordered A–G tranches described
in the private plan. No server/daemon/M9 work is included.

## A — commands and editor

One command metadata module owns builtin names, help text, argument suggestions and matching;
the existing dispatcher remains responsible for execution. Palette and slash completion stage
text into the composer, never dispatch it. Unknown native resource commands keep their established
engine path. Palette navigation cannot answer a pending request, submit a queued prompt or lose
an existing draft. Selection replaces the draft only when completing that draft; Ctrl+P inserts
only into an empty composer, otherwise preserves the draft and reports how to stash it.

External editor uses VISUAL then EDITOR then a platform fallback. Parse argv without a shell;
reject shell operators. Only inherited user environment configures this command. Use a private
temporary directory/file, cap UTF-8 draft bytes, reject symlink/non-file/oversized output, suspend
and restore the renderer in finally, track the child and forward cleanup. A nonzero exit preserves
the original draft. An edited result applies only if the composer revision and text still match;
otherwise retain the current draft and surface the conflict. No result is sent automatically.
Only one editor can own the terminal; close/abort kills it and prevents late renderer revival.

Acceptance: real editor child success/failure/abort and cleanup; palette fuzzy/argument behavior;
rendered interaction while idle/busy/approval pending; existing queue/composer/approval regressions.

## B — input and terminal adapters

`[tui]` contains validated inert preferences, resolved by the existing layered config system.
User keybindings live in `keybindings.json` in the config directory, version 1, with contextual
bindings and up to three-key chords. Reload is automatic with validation; invalid edits preserve
the last valid map. Reject ambiguous prefixes and duplicate bindings within a context. More
specific contexts override global matches. Pending approvals/overlays never receive composer
actions. Escape and Ctrl+C retain their recovery meaning; remapping cannot trap the user.

Vim starts in INSERT. Escape enters NORMAL before interrupt when editing; NORMAL movement/edit
commands apply only to the composer, never approvals or overlays. Support h/j/k/l, w/b, 0/$,
i/a/A/I, x, dd, u and redo with the textarea's native UTF-8 edit buffer. Pasting inserts text.

Terminal capabilities come from renderer negotiation plus TERM/TERM_PROGRAM/tmux hints, with
explicit overrides and conservative fallback. Clipboard copy selects the last N assistant
messages (bounded), uses native clipboard when local/available, OSC52 otherwise with tmux wrapping,
and reports failure rather than claiming delivery. Terminal control text is sanitized and capped.

## C — rendering

Theme JSON is user-owned, capped, and contains only known hexadecimal palette tokens. Invalid
themes leave a working palette and an error. Thinking show/collapse/hide affects presentation,
not retained events. Search stages navigation to matching retained items without altering content.
Closed Mermaid fences render via pinned beautiful-mermaid 1.1.3 ASCII mode (MIT; upstream
https://github.com/lukilabs/beautiful-mermaid); bounded source/output and plain fallback protect
unsupported diagrams. LaTeX renders a bounded Unicode mathematical subset; unsupported commands
retain their literal spelling, without evaluating macros, HTML, file reads or code.

Inline mode uses the renderer's supported split-footer/scrollback APIs, emits completed items once,
and keeps live content/input/requests in the footer. Switching modes preserves state and draft;
history replay is explicit and deduplicated per display epoch. Local image preview is explicitly
requested by the user, bounded and validated; no model-provided URL causes a network/file read.
Kitty uses renderer image support, iTerm2 uses its inline-file protocol in main scrollback, and
other terminals retain a visual block or filename fallback. Raw image/protocol bytes are never
model-generated escape sequences. Sources and unsupported rendering remain inspectable.

## D — attention and executable terminal integrations

Notifications are opt-in, focus-gated and deduplicated for actual completion/request transitions;
they contain generic state, not transcript/secret text. Title text is sanitized; title push/pop
restores the original. Motion controls govern the cursor/spinner/pet; sleep inhibition exists only
while a turn runs and releases on completion/close/error. Unsupported backends report diagnostics.

Status segments always leave policy indicators visible. Optional JSON-stdin status scripts are
specified in user-owned `terminal-integrations.json`, not project config. They remain inert until
the user reviews and accepts their exact command and config fingerprint in the TUI. Trust changes
invalidate on changed config/executable bytes. Scripts receive a minimal environment and redacted
state without transcript content, have a one-second timeout/output cap, never overlap, and their
process groups are terminated on completion, abort and session close. Invalid output cannot emit
terminal control sequences. Voice uses the same reviewed command boundary in G.

## E — settings and discovery

The settings panel groups/searches resolved configuration, shows source provenance and managed
locks, and edits only supported inert UI preferences in the user source with an expected source
fingerprint. It never persists the merged snapshot. Changes retain unknown fields/profiles, are
validated before writing, and re-resolve through the existing layer order. Higher-precedence values
remain visible even when a user default changes. Agent/policy settings are inspected and routed to
their existing controls rather than silently changing a live pinned session.

## F — ephemeral auxiliary work

Side questions use a fresh, bounded copy of visible conversation text and the selected native
provider, with no tools, private reasoning blocks, parent transcript writes or persistent child
identity. One session-owned auxiliary request is allowed at a time; 30-second/512-output-token
limits, sanitization and actual/unknown usage accounting reuse the summary contract. Interrupt,
close, a new foreground input and closing the side panel cancel owned work. Existing root work
may continue against its own transcript snapshot. Unsupported engines report their capability.

Prompt suggestions are opt-in, one request after a completed turn, never automatically submitted,
and are cancelled/discarded on a new draft/turn/request/context change. They perform no tools or
workspace speculation; the user may stage the result into an empty composer. Away summaries reuse
the M5 local outcome projection and display once on return without a model call.

## G — dictation and closure

Voice is an explicit local recorder → WAV → transcription-command pipeline. User-reviewed argv
contains a literal `{audio}` argument substitution (never shell interpolation). The recorder and
transcriber may be local tools such as FFmpeg and whisper.cpp; the harness does not send audio to
a provider itself. Credentials are not inherited by these UI commands. A private temporary WAV is
bounded/validated, cleaned on every path, and never included in session history. One owner, maximum
60 seconds capture and 120 seconds transcription; stop sends SIGINT to finalize WAV, cancel/close
kills process groups. Transcript output stages into the unchanged composer, never submits.

F4 holds on terminals reporting release events; otherwise F4 toggles. `/voice start|stop|cancel`
is the portable fallback. `/voice doctor` checks configured binaries, review state and an optional
explicitly reviewed microphone-diagnostic command. Report missing microphone/backend permission
as setup failure, without claiming recording or recognition occurred.

Realtime audio conversation remains an explicit exploratory no-go for this tranche: the current
provider/session contract is text/tool streaming, and the reviewed recorder pipeline is not a
full-duplex audio transport. Do not claim realtime support. Its follow-on requires an audio session
contract, playback/echo/interrupt ownership and separate provider/platform evidence.

Onboarding is dismissible and local, explains actual engine/auth choices and links to config/help.
Docs/release notes use bundled Markdown (included in compiled packages); tips are contextual and
disableable. The integration panel is one tabbed surface over existing MCP/plugin/hook/skill and
extension management methods, with explicit staged actions. It does not introduce new trust paths.

## Final inventory reconciliation

The detailed atlas also calls for operator/repeat Vim editing, notification idle delay, scroll/drag
preferences and session-spaced tips. Add delete/change word/line motions with dot replay of the
last supported change; unsupported Vim commands remain consumed in NORMAL mode. Notification delay
is validated (0–60 seconds) and measured since focus loss; titles distinguish action-required state.
Mouse scroll acceleration and opt-in selection-copy use renderer events and the same clipboard
boundary. Persist only a bounded user-local visit counter for tip spacing; no conversation data.
