import Redis from "ioredis";
import { Redis as UpstashRedis } from "@upstash/redis";
import fs from "fs";
import path from "path";

export const MAX_CACHE_AGE_MINUTES = 180; // 3 hours staleness cap

export interface CacheEntry {
  timestamp: number;
  options: any;
  result: any;
}

export interface StoredBreakerState {
  currentState: "CLOSED" | "OPEN" | "HALF_OPEN";
  consecutiveFailures: number;
  lastTrippedTimestamp: number | null;
}

class CacheStore {
  private redisClient: Redis | UpstashRedis | null = null;
  private memoryCache = new Map<string, CacheEntry>();
  private memoryBreakerState: StoredBreakerState = {
    currentState: "CLOSED",
    consecutiveFailures: 0,
    lastTrippedTimestamp: null,
  };

  private filePath = path.join(process.cwd(), ".data", "cache_store.json");

  constructor() {
    this.initClient();
    this.loadFromFile();
  }

  private initClient() {
    const redisUrl = process.env.REDIS_URL;
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const isProduction = process.env.NODE_ENV === "production";

    if (upstashUrl && upstashToken) {
      console.log("[CacheStore] Connecting to Upstash Redis via REST API...");
      this.redisClient = new UpstashRedis({ url: upstashUrl, token: upstashToken });
    } else if (redisUrl) {
      console.log("[CacheStore] Connecting to Redis via TCP connection string...");
      try {
        this.redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
      } catch (err) {
        console.error("[CacheStore ERROR] Failed to initialize Redis client:", err);
        if (isProduction) {
          throw new Error("[FATAL] Redis initialization failed in production mode!");
        }
      }
    } else {
      if (isProduction) {
        const fatalMsg = "[FATAL] Missing Redis credentials in production mode! Set REDIS_URL or UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN.";
        console.error(fatalMsg);
        throw new Error(fatalMsg);
      }
      console.warn("[CacheStore WARNING] Neither REDIS_URL nor UPSTASH_REDIS_REST_URL environment variables are set. Using local file persistence (.data/cache_store.json).");
    }
  }

  private loadFromFile() {
    try {
      const dataDir = path.dirname(this.filePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.breakerState) this.memoryBreakerState = parsed.breakerState;
        if (parsed.cacheEntries && typeof parsed.cacheEntries === "object") {
          for (const [k, v] of Object.entries(parsed.cacheEntries)) {
            this.memoryCache.set(k, v as CacheEntry);
          }
        }
      }
    } catch (e) {}
  }

  private saveToFile() {
    try {
      const dataDir = path.dirname(this.filePath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const cacheEntriesObj = Object.fromEntries(this.memoryCache.entries());
      const payload = {
        breakerState: this.memoryBreakerState,
        cacheEntries: cacheEntriesObj,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (e) {}
  }

  public generateCacheKey(options: any): string {
    const keywordsStr = Array.isArray(options.keywords)
      ? [...options.keywords].sort().join(",")
      : String(options.keywords || "");
    const jobType = String(options.jobType || "all");
    const minRating = options.minRating !== null && options.minRating !== undefined && options.minRating !== "" ? String(options.minRating) : "any";
    const minReviews = options.minReviews !== null && options.minReviews !== undefined && options.minReviews !== "" ? String(options.minReviews) : "any";
    const minStipend = options.minStipend !== null && options.minStipend !== undefined && options.minStipend !== "" ? String(options.minStipend) : "any";
    const maxDaysOld = options.maxDaysOld !== null && options.maxDaysOld !== undefined && options.maxDaysOld !== "" ? String(options.maxDaysOld) : "any";

    const raw = `${keywordsStr}_${jobType}_${minRating}_${minReviews}_${minStipend}_${maxDaysOld}`;
    return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  }

  public async setCache(key: string, options: any, result: any): Promise<void> {
    const entry: CacheEntry = {
      timestamp: Date.now(),
      options,
      result,
    };

    this.memoryCache.set(key, entry);
    this.saveToFile();

    if (this.redisClient) {
      try {
        const redisKey = `jobpilot:cache:${key}`;
        const serialized = JSON.stringify(entry);
        if ("set" in this.redisClient) {
          await (this.redisClient as any).set(redisKey, serialized, { ex: 86400 });
        }
      } catch (err) {
        console.error("[CacheStore] Redis setCache error:", err);
      }
    }
  }

  public async getCache(key: string): Promise<{
    entry: CacheEntry | null;
    isStaleCapExceeded: boolean;
    cacheAgeMinutes: number | null;
  }> {
    let entry: CacheEntry | null = this.memoryCache.get(key) || null;

    if (!entry && this.redisClient) {
      try {
        const redisKey = `jobpilot:cache:${key}`;
        let rawData: string | null = null;
        if ("get" in this.redisClient) {
          const res = await (this.redisClient as any).get(redisKey);
          rawData = typeof res === "string" ? res : (res ? JSON.stringify(res) : null);
        }
        if (rawData) {
          entry = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
          if (entry) this.memoryCache.set(key, entry);
        }
      } catch (err) {
        console.error("[CacheStore] Redis getCache error:", err);
      }
    }

    if (!entry) {
      return { entry: null, isStaleCapExceeded: false, cacheAgeMinutes: null };
    }

    const ageMs = Date.now() - entry.timestamp;
    const cacheAgeMinutes = Math.floor(ageMs / 60000);
    const isStaleCapExceeded = cacheAgeMinutes > MAX_CACHE_AGE_MINUTES;

    return {
      entry: isStaleCapExceeded ? null : entry,
      isStaleCapExceeded,
      cacheAgeMinutes,
    };
  }

  public async saveBreakerState(state: StoredBreakerState): Promise<void> {
    this.memoryBreakerState = { ...state };
    this.saveToFile();

    if (this.redisClient) {
      try {
        const redisKey = "jobpilot:circuit_breaker";
        if ("set" in this.redisClient) {
          await (this.redisClient as any).set(redisKey, JSON.stringify(state));
        }
      } catch (err) {
        console.error("[CacheStore] Redis saveBreakerState error:", err);
      }
    }
  }

  public async getBreakerState(): Promise<StoredBreakerState> {
    this.loadFromFile();
    if (this.redisClient) {
      try {
        const redisKey = "jobpilot:circuit_breaker";
        let rawData: any = null;
        if ("get" in this.redisClient) {
          rawData = await (this.redisClient as any).get(redisKey);
        }
        if (rawData) {
          const parsed = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
          this.memoryBreakerState = parsed;
        }
      } catch (err) {
        console.error("[CacheStore] Redis getBreakerState error:", err);
      }
    }
    return this.memoryBreakerState;
  }

  public async incrFailureCounter(): Promise<number> {
    if (this.redisClient) {
      try {
        const redisKey = "jobpilot:failure_counter";
        if ("incr" in this.redisClient) {
          const newCount = await (this.redisClient as any).incr(redisKey);
          const countNum = Number(newCount);
          this.memoryBreakerState.consecutiveFailures = countNum;
          this.saveToFile();
          return countNum;
        }
      } catch (err) {
        console.error("[CacheStore] Redis INCR error:", err);
      }
    }

    this.memoryBreakerState.consecutiveFailures++;
    this.saveToFile();
    return this.memoryBreakerState.consecutiveFailures;
  }

  public async resetFailureCounter(): Promise<void> {
    this.memoryBreakerState.consecutiveFailures = 0;
    this.saveToFile();

    if (this.redisClient) {
      try {
        const redisKey = "jobpilot:failure_counter";
        if ("del" in this.redisClient) {
          await (this.redisClient as any).del(redisKey);
        } else if ("set" in this.redisClient) {
          await (this.redisClient as any).set(redisKey, 0);
        }
      } catch (err) {
        console.error("[CacheStore] Redis resetFailureCounter error:", err);
      }
    }
  }

  public getEntriesCount(): number {
    return this.memoryCache.size;
  }

  public isRedisConfigured(): boolean {
    return Boolean(process.env.REDIS_URL || (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN));
  }
}

export const cacheStore = new CacheStore();
