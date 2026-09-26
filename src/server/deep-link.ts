export function parseDeepLink(source: string) {
  if (source.length > 4096) throw new Error("Deep link exceeds limit")
  const url = new URL(source)
  if (
    url.protocol !== "codesplash:" ||
    url.hostname !== "session" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url.pathname)
  )
    throw new Error("Expected codesplash://session/LOCAL_SESSION_UUID without commands or credentials")
  return {
    threadId: url.pathname.slice(1),
    provenance:
      "External CodeSplash link. The sender is not authenticated. Opening this link only selects a local session; it cannot submit work or grant permissions.",
  }
}
