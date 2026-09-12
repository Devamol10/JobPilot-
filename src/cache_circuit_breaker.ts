import { cacheStore, MAX_CACHE_AGE_MINUTES } from "./cache_store";

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private currentState: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private lastTrippedTimestamp: number | null = null;

  private readonly FAILURE_THRESHOLD = 3;
  private readonly COOLDOWN_MS = 25 * 60 * 1000; // 25 minutes

  constructor() {
    this.syncFromStore();
  }

  private async syncFromStore() {
    try {
      const stored = await cacheStore.getBreakerState();
      this.currentState = stored.currentState;
      this.consecutiveFailures = stored.consecutiveFailures;
      this.lastTrippedTimestamp = stored.lastTrippedTimestamp;
    } catch (err) {}
  }

  private async persistState() {
    try {
      await cacheStore.saveBreakerState({
        currentState: this.currentState,
        consecutiveFailures: this.consecutiveFailures,
        lastTrippedTimestamp: this.lastTrippedTimestamp,
      });
    } catch (err) {}
  }

  public async canAttemptLiveScrape(): Promise<boolean> {
    await this.syncFromStore();

    if (this.currentState === "CLOSED") {
      return true;
    }

    if (this.currentState === "OPEN") {
      if (this.lastTrippedTimestamp && Date.now() - this.lastTrippedTimestamp >= this.COOLDOWN_MS) {
        console.log("[CircuitBreaker] Cooldown period expired (25 mins). Transitioning from OPEN -> HALF_OPEN for trial probe.");
        this.currentState = "HALF_OPEN";
        await this.persistState();
        return true;
      }
      return false;
    }

    if (this.currentState === "HALF_OPEN") {
      return true; // Trial probe allowed
    }

    return true;
  }

  public async recordSuccess(): Promise<void> {
    await cacheStore.resetFailureCounter();
    console.log(`[CircuitBreaker] Live scrape SUCCESS. Resetting failure counter. State -> CLOSED.`);
    this.consecutiveFailures = 0;
    this.currentState = "CLOSED";
    this.lastTrippedTimestamp = null;
    await this.persistState();
  }

  public async recordFailure(errorMsg?: string): Promise<number> {
    // Atomic Redis INCR counter increment
    const newCount = await cacheStore.incrFailureCounter();
    this.consecutiveFailures = newCount;

    console.log(`[CircuitBreaker] Live scrape FAILURE recorded (${newCount}/${this.FAILURE_THRESHOLD}). Error: ${errorMsg || "Unknown"}`);

    // Immediate threshold check on atomic INCR return value
    if (newCount >= this.FAILURE_THRESHOLD || this.currentState === "HALF_OPEN") {
      this.currentState = "OPEN";
      this.lastTrippedTimestamp = Date.now();
      console.log(`[CircuitBreaker TRIPPED] State -> OPEN (Failure count: ${newCount}). Pausing live scrapes for 25 minutes to protect server IP.`);
    }

    await this.persistState();
    return newCount;
  }

  public async recordBlockError(errorMsg?: string): Promise<number> {
    return this.recordFailure(errorMsg);
  }

  public async getStatus() {
    await this.syncFromStore();
    let cooldownRemainingSeconds = 0;
    if (this.currentState === "OPEN" && this.lastTrippedTimestamp) {
      const elapsed = Date.now() - this.lastTrippedTimestamp;
      cooldownRemainingSeconds = Math.max(0, Math.ceil((this.COOLDOWN_MS - elapsed) / 1000));
    }

    return {
      currentState: this.currentState,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.FAILURE_THRESHOLD,
      lastTrippedTimestamp: this.lastTrippedTimestamp,
      cooldownRemainingSeconds,
      maxCacheAgeMinutes: MAX_CACHE_AGE_MINUTES,
    };
  }

  // --- Test Helper Methods for Verification & Instant Testing ---
  public async testTripCircuitBreaker(): Promise<void> {
    this.consecutiveFailures = 3;
    this.currentState = "OPEN";
    this.lastTrippedTimestamp = Date.now();
    await this.persistState();
    console.log("[CircuitBreaker TEST] Instantly tripped breaker to OPEN.");
  }

  public async testFastForwardCooldown(): Promise<void> {
    if (this.currentState === "OPEN") {
      this.lastTrippedTimestamp = Date.now() - (26 * 60 * 1000); // 26 minutes ago
      this.currentState = "HALF_OPEN";
      await this.persistState();
      console.log("[CircuitBreaker TEST] Instantly fast-forwarded cooldown to HALF_OPEN.");
    }
  }

  public async resetCircuitBreaker(): Promise<void> {
    this.consecutiveFailures = 0;
    this.currentState = "CLOSED";
    this.lastTrippedTimestamp = null;
    await this.persistState();
    console.log("[CircuitBreaker TEST] Reset breaker to CLOSED.");
  }
}

export const circuitBreaker = new CircuitBreaker();
