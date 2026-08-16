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

export const SUPPORTED_CODEX_CLI_VERSION = "0.147.0"

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
        version: "0.0.0",
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
