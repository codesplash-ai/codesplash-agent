export type MemoryConfig = {
  enabled?: boolean
  autoLearn?: boolean
  embedding?: { url: string; model: string; keyEnvVar: string; dimensions: number; inputPerMTok?: number }
}
export type MemorySource = { id: string; hash: string; path?: string }
export type MemoryRecord = {
  id: string
  revision: number
  scope: "repo" | "worktree"
  worktree: string
  kind: "fact" | "candidate" | "note"
  source: "user" | "generated"
  reviewed?: boolean
  session: string
  sources: MemorySource[]
  created: string
  updated: string
  text: string
}
export type MemorySnapshot = { revision: string; records: MemoryRecord[]; processed: string[] }
export type MemoryIdentity = { key: string; worktree: string; repository?: string; location: string }
export type MemorySearch = {
  mode: "lexical" | "hybrid" | "fallback"
  reason?: string
  records: Array<{ record: MemoryRecord; score: number }>
}
export const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const MEMORY_BODY_BYTES = 4096
export const MEMORY_MAX_RECORDS = 2000
