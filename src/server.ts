import express from "express";
import cors from "cors";
import path from "path";
import { runJobSearch, SearchOptions, SearchRunResult, StructuralBlockError } from "./browser_runner";
import { cacheStore, MAX_CACHE_AGE_MINUTES } from "./cache_store";
import { circuitBreaker } from "./cache_circuit_breaker";
import { canaryMonitor } from "./canary_health";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

let isRunning = false;
let currentLogs: string[] = [];
let lastResult: SearchRunResult | null = null;

// Health Check Endpoint (Basic service check)
app.get(["/api/health", "/health"], (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "JobPilot API Server",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memoryUsage: process.memoryUsage(),
  });
});

// Infrastructure Status Endpoint (Infrastructure & Server Health ONLY)
app.get("/api/status", async (req, res) => {
  const breakerStatus = await circuitBreaker.getStatus();
  const canaryStatus = canaryMonitor.getStatusInfo();
  const isRedisConfigured = cacheStore.isRedisConfigured();

  res.json({
    isRunning,
    uptime: Math.floor(process.uptime()),
    circuitBreaker: breakerStatus,
    canaryHealth: canaryStatus,
    redisConfigured: isRedisConfigured,
    cacheEntriesCount: cacheStore.getEntriesCount(),
  });
});

// Search Endpoint GET Handler (Search Progress & Results ONLY)
app.get("/api/search", (req, res) => {
  res.json({
    isRunning,
    logs: currentLogs,
    result: lastResult,
    message: "GET returns last search progress and results. POST /api/search to trigger a search run.",
  });
});

// Search Endpoint POST Handler (Trigger Search Run with Circuit Breaker & Redis Cache Fallback)
app.post("/api/search", async (req, res) => {
  if (isRunning) {
    return res.status(400).json({ error: "Search is already running in background!" });
  }

  const {
    keywords,
    jobType,
    minRating,
    minReviews,
    minStipend,
    maxDaysOld,
    maxPages,
    headless,
  } = req.body;

  const options: SearchOptions = {
    keywords: Array.isArray(keywords) && keywords.length > 0 ? keywords : ["Software Engineer"],
    jobType: jobType === "internship" || jobType === "fulltime" ? jobType : "fulltime",
    minRating: minRating !== undefined && minRating !== null && minRating !== "" ? Number(minRating) : null,
    minReviews: minReviews !== undefined && minReviews !== null && minReviews !== "" ? Number(minReviews) : null,
    minStipend: minStipend !== undefined && minStipend !== null && minStipend !== "" ? Number(minStipend) : null,
    maxDaysOld: maxDaysOld !== undefined && maxDaysOld !== null && maxDaysOld !== "" ? Number(maxDaysOld) : null,
    maxPages: Number(maxPages) || 5,
    headless: Boolean(headless),
  };

  const cacheKey = cacheStore.generateCacheKey(options);
  const canLiveScrape = await circuitBreaker.canAttemptLiveScrape();

  // If Circuit Breaker is OPEN, bypass live scrape and serve cached results (or staleness warning)
  if (!canLiveScrape) {
    const breakerState = await circuitBreaker.getStatus();
    currentLogs = [`[CircuitBreaker] Circuit Breaker is ${breakerState.currentState} (Cooldown active: ${breakerState.cooldownRemainingSeconds}s remaining). Bypassing live scrape.`];
    
    const { entry, isStaleCapExceeded, cacheAgeMinutes } = await cacheStore.getCache(cacheKey);

    if (entry && !isStaleCapExceeded) {
      currentLogs.push(`[Cache] Serving cached search results (${cacheAgeMinutes} mins old).`);
      lastResult = entry.result;
      return res.json({
        status: "completed",
        isCached: true,
        cacheAgeMinutes,
        circuitBreakerState: breakerState.currentState,
        options,
        result: entry.result,
      });
    }

    // Cache is missing or older than 180 minutes staleness cap
    currentLogs.push(`[Cache STALE CAP] No cache available or cache older than ${MAX_CACHE_AGE_MINUTES} mins.`);
    return res.status(200).json({
      status: "blocked",
      isCached: false,
      noFreshDataAvailable: true,
      circuitBreakerState: breakerState.currentState,
      message: "Naukri temporarily unreachable, no recent results available — try again later.",
      logs: currentLogs,
    });
  }

  // Live Scrape Execution (async fire-and-forget so frontend can poll for live progress)
  isRunning = true;
  currentLogs = [];
  lastResult = null;

  // Fire the scrape in background — do NOT await here
  (async () => {
    try {
      const result = await runJobSearch(options, (logMsg) => {
        currentLogs.push(logMsg);
      });

      await circuitBreaker.recordSuccess();
      await cacheStore.setCache(cacheKey, options, result);

      lastResult = result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isStructural = err instanceof StructuralBlockError || message.includes("blocked at IP level") || message.includes("STRUCTURAL BLOCK");

      if (isStructural) {
        await circuitBreaker.recordFailure(message);
      }

      currentLogs.push(`[ERROR] Live search failed: ${message}`);

      // Check if cached result exists to serve as fallback despite error
      const { entry: fallbackEntry, isStaleCapExceeded: fallbackStale } = await cacheStore.getCache(cacheKey);

      if (fallbackEntry && !fallbackStale) {
        currentLogs.push(`[Cache Fallback] Serving cached search results after live scrape block.`);
        lastResult = fallbackEntry.result;
      }
    } finally {
      isRunning = false;
    }
  })();

  return res.json({
    status: "started",
    message: "Search started. Poll GET /api/search for live progress.",
  });
});

// --- Circuit Breaker Test Endpoints (Gated for non-production environments) ---
const testRouteMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Forbidden: Test endpoints are disabled in production!" });
  }
  next();
};

app.post("/api/test/trip-breaker", testRouteMiddleware, async (req, res) => {
  await circuitBreaker.testTripCircuitBreaker();
  const status = await circuitBreaker.getStatus();
  res.json({ message: "Circuit breaker tripped to OPEN", breaker: status });
});

app.post("/api/test/fast-forward-breaker", testRouteMiddleware, async (req, res) => {
  await circuitBreaker.testFastForwardCooldown();
  const status = await circuitBreaker.getStatus();
  res.json({ message: "Circuit breaker fast-forwarded to HALF_OPEN", breaker: status });
});

app.post("/api/test/reset-breaker", testRouteMiddleware, async (req, res) => {
  await circuitBreaker.resetCircuitBreaker();
  const status = await circuitBreaker.getStatus();
  res.json({ message: "Circuit breaker reset to CLOSED", breaker: status });
});

// Start Canary Health Background Monitor
canaryMonitor.start(12);

const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log("\n==================================================");
  console.log(`🚀 JobPilot Web UI is live on port: ${PORT}`);
  console.log(`📡 Redis Configured: ${cacheStore.isRedisConfigured()}`);
  console.log("==================================================\n");
});

// Graceful shutdown handling for Render deployments
const gracefulShutdown = (signal: string) => {
  console.log(`\n[Server] Received ${signal}, starting graceful shutdown...`);
  
  // Stop background monitors
  canaryMonitor.stop();
  console.log("[Server] Canary monitor stopped.");

  // Close HTTP server
  server.close(() => {
    console.log("[Server] HTTP server closed.");
    process.exit(0);
  });

  // Force shutdown if it takes too long (e.g., 10 seconds)
  setTimeout(() => {
    console.error("[Server] Forcefully shutting down after 10s timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
