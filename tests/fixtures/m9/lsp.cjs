let pending = Buffer.alloc(0)
const documents = new Map()
function send(value) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...value }))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (true) {
    const end = pending.indexOf("\r\n\r\n")
    if (end < 0) return
    const size = Number(/Content-Length: (\d+)/.exec(pending.subarray(0, end).toString())[1])
    if (pending.length < end + 4 + size) return
    const message = JSON.parse(pending.subarray(end + 4, end + 4 + size).toString())
    pending = pending.subarray(end + 4 + size)
    const d = message.params?.textDocument
    if (message.method === "initialize")
      send({
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
          },
        },
      })
    else if (message.method === "textDocument/didOpen") {
      documents.set(d.uri, { text: d.text, version: d.version })
      send({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: d.uri,
          version: d.version,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 2,
              message: "fixture diagnostic",
            },
          ],
        },
      })
    } else if (message.method === "textDocument/didChange") {
      documents.set(d.uri, { text: message.params.contentChanges[0].text, version: d.version })
      send({
        method: "textDocument/publishDiagnostics",
        params: { uri: d.uri, version: d.version, diagnostics: [] },
      })
    } else if (message.method === "textDocument/hover")
      send({ id: message.id, result: { contents: { kind: "plaintext", value: documents.get(d.uri)?.text } } })
    else if (message.method === "textDocument/documentSymbol")
      send({
        id: message.id,
        result: [
          {
            name: "example",
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        ],
      })
    else if (message.id !== undefined)
      send({
        id: message.id,
        result: [
          { uri: d?.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        ],
      })
  }
})
