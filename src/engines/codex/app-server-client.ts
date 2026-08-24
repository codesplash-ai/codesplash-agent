import { APP_VERSION } from "../../version.ts"
import {
  type CodexAppServerProcess,
  type CodexAppServerProcessOptions,
  spawnCodexAppServer,
} from "./app-server-process.ts"
import type { InitializeParams } from "./generated/InitializeParams.ts"
import type { InitializeResponse } from "./generated/InitializeResponse.ts"
import type { GetAccountParams } from "./generated/v2/GetAccountParams.ts"
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.ts"
import type { Model } from "./generated/v2/Model.ts"
import type { ModelListParams } from "./generated/v2/ModelListParams.ts"
import type { ModelListResponse } from "./generated/v2/ModelListResponse.ts"

/** The Codex CLI version this app is tested against; the generated protocol types come from it. */
export const SUPPORTED_CODEX_CLI_VERSION = "0.147.0"
/** The oldest Codex CLI whose app-server protocol this app can drive. */
export const MINIMUM_CODEX_CLI_VERSION = "0.147.0"

export type CodexVersionCompatibility = {
  compatible: boolean
  /** Set when the session may proceed but the CLI is newer than the tested baseline. */
  warning?: string
}

/** Versions newer than the tested baseline run with a warning; older than the minimum are refused. */
export function codexVersionCompatibility(version: string | undefined): CodexVersionCompatibility {
  if (!version) return { compatible: false }
  if (version === SUPPORTED_CODEX_CLI_VERSION) return { compatible: true }
  if (compareVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0) return { compatible: false }
  return {
    compatible: true,
    warning: `Codex CLI ${version} is newer than the tested baseline ${SUPPORTED_CODEX_CLI_VERSION}`,
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export class CodexAppServerClient {
  readonly process: CodexAppServerProcess
  #initialized = false

  constructor(options: CodexAppServerProcessOptions = {}) {
    this.process = spawnCodexAppServer(options)
  }

  async initialize(): Promise<InitializeResponse> {
    if (this.#initialized) throw new Error("Codex app-server client is already initialized")

    const params: InitializeParams = {
      clientInfo: {
        name: "codesplash-agent",
        title: "CodeSplash Agent",
        version: APP_VERSION,
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }

    const response = await this.process.connection.request<InitializeResponse>("initialize", params)
    await this.process.connection.notify("initialized")
    this.#initialized = true
    return response
  }

  async readAccount(params: GetAccountParams = { refreshToken: false }): Promise<GetAccountResponse> {
    if (!this.#initialized) throw new Error("Codex app-server client must be initialized first")
    return this.process.connection.request<GetAccountResponse>("account/read", params)
  }

  async listModels(): Promise<Model[]> {
    if (!this.#initialized) throw new Error("Codex app-server client must be initialized first")

    const models: Model[] = []
    let cursor: string | null = null
    do {
      const params: ModelListParams = { cursor, includeHidden: false }
      const response: ModelListResponse = await this.process.connection.request<ModelListResponse>(
        "model/list",
        params,
      )
      models.push(...response.data)
      cursor = response.nextCursor
    } while (cursor !== null)

    return models.filter((model) => !model.hidden)
  }

  close(): Promise<void> {
    return this.process.close()
  }
}
