/** Public surface of the first-party CodeSplash engine. */
export * from "./auth.ts"
export * from "./catalog.ts"
export * from "./command-analysis.ts"
export * from "./contracts.ts"
export * from "./engine.ts"
export * from "./loop.ts"
// permissions.ts is re-exported by name: its standalone derivePersistableRule helper would
// collide with the loop's export of the same name (an ambiguous star export resolves to
// neither). Callers wanting the standalone helper import ./permissions.ts directly.
export {
  type CodesplashPermissionRuntime,
  createPermissionRuntime,
  describePermissionRules,
  type ParsedPermissionRule,
  type PermissionRuleSource,
  type PermissionRuntimeOptions,
  PLAN_FILE_RELATIVE_PATH,
  PROJECT_PERMISSIONS_RELATIVE_PATH,
  readPermissionGrants,
  removePermissionGrant,
  SENSITIVE_READ_PATTERNS,
} from "./permissions.ts"
export * from "./runner.ts"
export * from "./tools/plan-mode.ts"
export * from "./tools/registry.ts"
export * from "./tools/web-fetch.ts"
export * from "./tools/web-search.ts"
export * from "./transcript.ts"
