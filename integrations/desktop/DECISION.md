# Desktop exploration decision

Use the native daemon as the stable owner and keep Electron as a replaceable client. The prototype
starts a loopback sidecar when necessary and leaves it running when its window closes, so the TUI
can attach to the same session. It uses the daemon's browser authentication, not a second credential
store. External links display provenance before selecting an existing local session. Link registration
is explicit (`--register-deep-links`); links contain neither tokens nor prompts.

Do not ship a signed desktop package in M9. The prototype establishes the process/ownership and
handoff design; desktop distribution requires a pinned Electron release, signing/notarization,
installer/uninstaller ownership, OS URL-handler acceptance and update policy. Those are a separate
product/distribution decision. No desktop installation or URL registration occurs during CLI use.

Run with an explicitly installed Electron runtime:
`electron integrations/desktop --daemon-root /absolute/daemon --workspace /absolute/project`.
Use `codesplash daemon pair --root /absolute/daemon` for browser login. Attach the TUI with
`codesplash attach UUID --root /absolute/daemon --shared`. This prototype has no Node integration,
no remote navigation and no automatic submission from a deep link.
