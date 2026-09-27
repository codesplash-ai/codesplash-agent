/** Deliberately bounded SemVer: stable or alpha/beta/rc.NUMBER, no build metadata. */
export function versionParts(value: string): [number, number, number, string, number] {
  const match =
    /^(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})(?:-(alpha|beta|rc)\.(0|[1-9]\d{0,6}))?$/.exec(
      value,
    )
  if (!match) throw new Error("Unsupported version; expected bounded SemVer")
  return [+match[1]!, +match[2]!, +match[3]!, match[4] ?? "stable", +(match[5] ?? 0)]
}
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a),
    right = versionParts(b)
  for (const i of [0, 1, 2] as const) if (left[i] !== right[i]) return Math.sign(left[i] - right[i])
  const stages = ["alpha", "beta", "rc", "stable"]
  return Math.sign(stages.indexOf(left[3]) - stages.indexOf(right[3]) || left[4] - right[4])
}
export type VersionPolicy = { minimum?: string; maximum?: string; pin?: string; channel?: "stable" | "alpha" }
export function assertVersion(version: string, policy: VersionPolicy): void {
  versionParts(version)
  for (const item of [policy.minimum, policy.maximum, policy.pin]) if (item !== undefined) versionParts(item)
  if (policy.channel !== undefined && !["stable", "alpha"].includes(policy.channel))
    throw new Error("Invalid version channel")
  if (
    (policy.minimum && compareVersions(version, policy.minimum) < 0) ||
    (policy.maximum && compareVersions(version, policy.maximum) > 0) ||
    (policy.pin && version !== policy.pin) ||
    (policy.channel === "stable" && versionParts(version)[3] !== "stable")
  )
    throw new Error("Version is outside the required channel, pin or bounds")
}
