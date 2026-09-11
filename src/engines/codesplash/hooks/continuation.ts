/** One foreground turn owns these limits; provider retries and compaction cannot reset them. */
export class HookContinuationBudget {
  #count = 0
  #started: number | undefined
  #reserved = 0
  constructor(
    readonly limits: { maxCount: number; maxDurationMs: number; maxTokens: number },
    readonly now = Date.now,
  ) {}
  get active(): boolean {
    return this.#started !== undefined
  }
  get remainingMs(): number {
    return this.#started === undefined
      ? this.limits.maxDurationMs
      : Math.max(0, this.limits.maxDurationMs - (this.now() - this.#started))
  }
  canContinue(): boolean {
    return (
      this.#count < this.limits.maxCount && this.remainingMs > 0 && this.#reserved < this.limits.maxTokens
    )
  }
  continue(): boolean {
    if (!this.canContinue()) return false
    this.#started ??= this.now()
    this.#count++
    return true
  }
  reserve(tokens: number): boolean {
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 0 ||
      !this.active ||
      !this.remainingMs ||
      this.#reserved + tokens > this.limits.maxTokens
    )
      return false
    this.#reserved += tokens
    return true
  }
  chargeExcess(reserved: number, reported: number): void {
    if (!Number.isFinite(reported) || reported < 0) {
      this.#reserved = this.limits.maxTokens
      return
    }
    this.#reserved += Math.max(0, Math.ceil(reported) - reserved)
  }
}
