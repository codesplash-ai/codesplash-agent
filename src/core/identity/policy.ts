import { configDirectory } from "../config.ts"
import { readFleetSources } from "../distribution/fleet.ts"
export function assertIdentityAllowed(
  kind: string,
  tenant?: string,
  provider?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const { payload } of readFleetSources(configDirectory(env))) {
    const p = payload.settings
    if (p?.identityKinds && !p.identityKinds.includes(kind))
      throw new Error("Identity method is disabled by managed policy")
    if (tenant && p?.identityTenants && !p.identityTenants.includes(tenant))
      throw new Error("Identity tenant is disabled by managed policy")
    if (kind === "api-key" && p?.apiKeyProviders && (!provider || !p.apiKeyProviders.includes(provider)))
      throw new Error("API-key login is disabled by managed policy")
  }
}
