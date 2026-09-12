export type TaskRequest =
  | { action: "list" }
  | { action: "output"; id: string; cursor?: number; limit?: number }
  | { action: "wait"; ids: string[]; all?: boolean; timeoutMs?: number }
  | { action: "kill" | "forget"; id: string }
  | { action: "stdin"; id: string; text: string }
  | { action: "resize"; id: string; cols: number; rows: number }
  | { action: "background" }
