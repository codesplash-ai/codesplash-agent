# M9 native server contract

The daemon owns native SDK sessions and their recorders. Clients own connections and bounded,
expiring writer leases. A connection grants no workspace trust. The daemon operator chooses
workspace roots, configuration, history storage and executable integrations at startup. Network
requests cannot enable extensions, trust a workspace, widen permissions or supply executable
configuration. Replay and imported conversations are evidence, never commands.

Wire version 1 uses JSON-RPC 2.0 over newline-delimited stdio or authenticated HTTP. Initialize
negotiates version and experimental capabilities before other methods. Every mutation is serialized;
request IDs are idempotency keys within a connection. Turns enqueue work and return immediately.
Approval requests arrive as events and require a current writer lease to answer. Exclusive leases
exclude shared writers; an explicit steal interrupts work, invalidates old leases and declines
outstanding requests before changing ownership. Readers can replay redacted events and snapshots.

Public events omit raw provider data, reasoning, extension UI payloads and hook payloads; conversation text is credential-redacted. Sequence
gaps are intentional; cursors track the source log rather than a filtered count. Slow streams close
with an explicit replay requirement. Snapshot and replay use the same public projection. Native
transcripts remain private in the ordinary session store. Restart requires explicit resume and holds
queued work; restarting or reconnecting never resubmits prompts.

HTTP binds authenticated loopback by default. Host and Origin are checked, request bodies and
connection counts are bounded, credentials are never accepted in URLs, and browser credentials use
HttpOnly SameSite=Strict cookies. Pairing codes are short-lived, single use and locally issued.
Sharing is a separate opt-in bearer capability: exports are redacted, immutable and revocable, with
an operator kill switch. Import previews provenance before applying through the native importer.

All adapters use the same protocol owner. ACP advertises only supported capabilities; MCP invokes
native sessions with explicit approval callbacks. Managed language servers and formatters require
operator-owned, reviewed descriptors and verified downloads; project files cannot install them.
Desktop remains an explicitly exploratory companion that attaches to this daemon.
