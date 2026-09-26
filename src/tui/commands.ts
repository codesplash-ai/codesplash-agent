export type SlashCommandName =
  | "hunks"
  | "accept-hunk"
  | "reject-hunk"
  | "feedback"
  | "share"
  | "unshare"
  | "voice"
  | "btw"
  | "suggest"
  | "config"
  | "integrations"
  | "docs"
  | "release-notes"
  | "onboarding"
  | "terminal"
  | "search"
  | "thinking"
  | "theme"
  | "screen"
  | "image"
  | "copy"
  | "keys"
  | "teams"
  | "dashboard"
  | "loop"
  | "tasks"
  | "cd"
  | "session-info"
  | "recap"
  | "rename"
  | "outcomes"
  | "pwd"
  | "export"
  | "help"
  | "new"
  | "resume"
  | "engine"
  | "model"
  | "mcp"
  | "hooks"
  | "plugins"
  | "extensions"
  | "permissions"
  | "usage"
  | "context"
  | "compact"
  | "commands"
  | "skills"
  | "personality"
  | "create-skill"
  | "remember"
  | "memory"
  | "history"
  | "queue"
  | "steer"
  | "interject"
  | "prompt-history"
  | "stash"
  | "acknowledge-fork"
  | "gc-recovery"
  | "tree"
  | "fork"
  | "rewind"
  | "checkpoints"
  | "checkpoint-diff"
  | "restore"
  | "recover-restore"
  | "pin-branch"
  | "pin-checkpoint"
  | "prune-branches"
  | "prune-checkpoints"
  | "quit"

export type ParsedSlashCommand =
  | { name: SlashCommandName; argument?: string }
  | { name: "unknown"; raw: string }

const slashCommandNames: readonly SlashCommandName[] = [
  "hunks",
  "accept-hunk",
  "reject-hunk",
  "feedback",
  "share",
  "unshare",
  "voice",
  "btw",
  "suggest",
  "config",
  "integrations",
  "docs",
  "release-notes",
  "onboarding",
  "terminal",
  "search",
  "thinking",
  "theme",
  "screen",
  "image",
  "copy",
  "keys",
  "cd",
  "session-info",
  "recap",
  "rename",
  "outcomes",
  "pwd",
  "export",
  "help",
  "new",
  "resume",
  "engine",
  "model",
  "teams",
  "dashboard",
  "tasks",
  "loop",
  "mcp",
  "hooks",
  "plugins",
  "extensions",
  "permissions",
  "usage",
  "context",
  "compact",
  "commands",
  "skills",
  "personality",
  "create-skill",
  "remember",
  "memory",
  "history",
  "queue",
  "steer",
  "interject",
  "prompt-history",
  "stash",
  "acknowledge-fork",
  "gc-recovery",
  "tree",
  "fork",
  "rewind",
  "checkpoints",
  "checkpoint-diff",
  "restore",
  "recover-restore",
  "pin-branch",
  "pin-checkpoint",
  "prune-branches",
  "prune-checkpoints",
  "quit",
]

const argumentsByCommand: Partial<Record<SlashCommandName, readonly string[]>> = {
  voice: ["start", "stop", "cancel", "doctor"],
  thinking: ["show", "collapse", "hide"],
  screen: ["alternate", "inline"],
  theme: ["dark", "light", "default"],
  mcp: ["status", "enable", "disable", "reconnect"],
  plugins: ["status", "reload"],
  extensions: ["status", "reload", "disable", "run"],
  hooks: ["status", "show", "reload", "disable", "receipts", "acknowledge"],
  personality: ["neutral", "concise", "explanatory"],
  memory: ["list", "show", "search", "edit", "forget", "accept", "status", "extract", "consolidate"],
  tasks: ["list", "output", "wait", "kill"],
  teams: ["list", "create", "coordinator", "panes", "close-panes", "delete"],
  loop: ["list", "stop", "5m", "1h"],
  stash: ["list", "save", "apply", "pop", "drop"],
  recap: ["--generate", "--since"],
  rename: ["--auto", "--generate"],
  export: ["--output", "--format", "--redact"],
}

export type CommandSuggestion = { value: string; description: string; score: number }

/** Prefixes rank first, then bounded subsequence matches. Never execute a suggestion. */
export function commandSuggestions(query: string, models: readonly string[] = []): CommandSuggestion[] {
  const source = query.trimStart().replace(/^\//, "").slice(0, 512)
  const split = source.indexOf(" ")
  let values: Array<{ value: string; description: string }>
  let needle: string
  if (split >= 0) {
    const name = source.slice(0, split).toLowerCase() as SlashCommandName
    needle = source
      .slice(split + 1)
      .trimStart()
      .toLowerCase()
    values = (name === "model" ? models : (argumentsByCommand[name] ?? [])).map((argument) => ({
      value: `/${name} ${argument}`,
      description: `Argument for /${name}`,
    }))
  } else {
    needle = source.toLowerCase()
    values = slashCommandNames.map((name) => ({
      value: `/${name}`,
      description:
        slashCommandHelp.find((item) => item.command.split(/[\s·]/).includes(`/${name}`))?.description ??
        name.replaceAll("-", " "),
    }))
  }
  return values
    .flatMap((item) => {
      const target = (split >= 0 ? item.value.slice(split + 2) : item.value.slice(1)).toLowerCase()
      let cursor = 0
      for (const character of target) if (character === needle[cursor]) cursor++
      if (cursor !== needle.length) return []
      return [{ ...item, score: (target.startsWith(needle) ? 0 : 100) + target.length - needle.length }]
    })
    .sort((a, b) => a.score - b.score || a.value.localeCompare(b.value))
    .slice(0, 60)
}

/** Returns undefined for ordinary prompts; commands start with "/" and a known word. */
export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return undefined
  const [word = "", ...rest] = trimmed.slice(1).split(/\s+/)
  const name = word.toLowerCase() as SlashCommandName
  if (!slashCommandNames.includes(name)) return { name: "unknown", raw: trimmed }
  return {
    name,
    argument:
      (["memory", "remember", "steer", "interject", "queue", "stash"].includes(name)
        ? trimmed.slice(word.length + 1).trim()
        : rest.join(" ")) || undefined,
  }
}

export const slashCommandHelp: ReadonlyArray<{ command: string; description: string }> = [
  {
    command: "/voice start|stop|cancel|doctor",
    description: "Explicit dictation through reviewed local commands; F4 holds/toggles",
  },
  {
    command: "/btw QUESTION",
    description: "Ask an ephemeral question about a read-only conversation snapshot",
  },
  { command: "/suggest", description: "Stage the latest opt-in suggestion without sending it" },
  { command: "/config", description: "Search settings, inspect provenance and edit user UI preferences" },
  { command: "/integrations", description: "Manage MCP, plugins, hooks, skills and extensions" },
  { command: "/feedback", description: "Preview content-free diagnostics and export instructions" },
  { command: "/docs · /release-notes", description: "Browse bundled documentation and release notes" },
  { command: "/onboarding", description: "Show the first-run guide" },
  { command: "/terminal", description: "Review and trust user-owned status/voice integrations" },
  { command: "/search [text]", description: "Search and navigate the retained transcript" },
  {
    command: "/thinking show|collapse|hide",
    description: "Change thinking display without changing history",
  },
  { command: "/theme dark|light|default|NAME", description: "Select a built-in or user JSON theme" },
  {
    command: "/screen alternate|inline",
    description: "Switch in place to terminal scrollback or full screen",
  },
  { command: "/image PATH", description: "Preview an explicitly selected local image" },
  { command: "/copy [N]", description: "Copy the last N completed assistant messages" },
  { command: "/keys", description: "Show active keybindings and reload instructions" },
  { command: "/session-info [--copy]", description: "Inspect session identity, policy, recovery and usage" },
  {
    command: "/recap [--since SEQUENCE] [--generate]",
    description: "Local outcome recap; generation is explicit",
  },
  { command: "/rename TEXT|--auto|--generate", description: "Set or refresh the session title" },
  { command: "/outcomes", description: "Inspect typed local turn outcomes" },
  { command: "/pwd", description: "Show the effective working directory" },
  {
    command: "/cd PATH [--carry|--clear --apply --revision REVISION]",
    description: "Preview or apply an idle directory change",
  },
  { command: "/new", description: "Start a fresh session in this project" },
  { command: "/resume", description: "Open the session picker" },
  { command: "/engine", description: "Back to the engine screen (welcome)" },
  { command: "/model [name]", description: "List models, or switch for the next turn" },
  {
    command: "/mcp [status|enable ID|disable ID|reconnect ID]",
    description: "Inspect MCP clients or change active connections while idle",
  },
  { command: "/permissions", description: "Show permission mode, rules, sandbox, and trust" },
  {
    command: "/plugins [status|reload]",
    description: "Inspect pinned plugins and activate a reviewed generation",
  },
  {
    command: "/extensions [status|reload|disable ID|run ID/COMMAND ARGUMENT]",
    description: "Inspect trusted extensions and run their commands; Tab completes arguments",
  },
  {
    command: "/hooks [status|show ID|reload|disable ID|receipts|acknowledge KEY]",
    description: "Review lifecycle handlers, sharing, source trust and uncertain execution",
  },
  { command: "/usage", description: "Show token usage, context left, and estimated cost" },
  { command: "/context", description: "Inspect model context and available input budget (CodeSplash)" },
  { command: "/compact [instructions]", description: "Compact older model context (CodeSplash)" },
  { command: "/remember text", description: "Save a repository memory explicitly" },
  {
    command: "/memory [list|show|search|edit|forget|accept|status|extract|consolidate]",
    description: "Inspect and manage memory",
  },
  { command: "/commands · /skills", description: "List native templates or skills with source paths" },
  { command: "/skill name [arguments]", description: "Load a skill explicitly" },
  { command: "/personality neutral|concise|explanatory", description: "Set response style" },
  { command: "/create-skill name [--write]", description: "Preview or create a skill scaffold" },
  {
    command: "/export --output FILE [--format json|markdown|html] [--redact]",
    description: "Export sanitized portable history",
  },
  { command: "/history", description: "Show where this session is stored" },
  { command: "/queue", description: "Inspect, edit, reorder and review acknowledged input" },
  { command: "/steer text", description: "Steer at the next safe provider/tool boundary" },
  { command: "/interject text", description: "Interrupt, settle cleanup, then admit this prompt" },
  { command: "/prompt-history", description: "Recall accepted typed prompts; Ctrl+R" },
  {
    command: "/stash [list|save NAME TEXT|apply ID|pop ID|drop ID]",
    description: "Explicit draft stashes; Ctrl+S saves the composer",
  },
  {
    command: "/tree · /fork [NODE] · /rewind NODE",
    description: "Preserved conversation branches; Esc-Esc backtracks",
  },
  {
    command: "/checkpoints · /checkpoint-diff ID · /restore ID [PATH…]",
    description: "Inspect eligible file snapshots and preview restore",
  },
  {
    command: "/teams · /dashboard · /tasks · /loop · !command · !!command",
    description: "Live tasks; run a command with or without model context",
  },
  { command: "/help", description: "Toggle this overlay (also F1)" },
  { command: "/quit", description: "Quit the app" },
]
