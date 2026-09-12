import { Redis } from "@upstash/redis";
import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";

// Manual .env loader fallback if process.env isn't populated by parent
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valParts] = trimmed.split("=");
      if (key && valParts.length > 0) {
        let val = valParts.join("=").trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key.trim()] = val;
      }
    }
  }
}

loadEnv();

async function runUpstashLiveTest() {
  console.log("=========================================================================");
  console.log("    LIVE UPSTASH REDIS CLOUD & RESTART PERSISTENCE INTEGRATION TEST      ");
  console.log("=========================================================================\n");

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  console.log(`[Config] UPSTASH_REDIS_REST_URL: ${url}`);
  console.log(`[Config] Token Present: ${Boolean(token)}\n`);

  if (!url || !token) {
    throw new Error("Upstash Redis credentials missing from environment!");
  }

  const redis = new Redis({ url, token });

  // 1. Direct Write to Upstash Redis
  console.log("--- 1. DIRECT WRITE TO UPSTASH REDIS CLOUD ---");
  const testBreakerState = {
    currentState: "OPEN",
    consecutiveFailures: 3,
    lastTrippedTimestamp: Date.now(),
  };

  const testCacheKey = "jobpilot:cache:full_stack_developer_fulltime_3_5_50_2000_14";
  const testCacheData = {
    timestamp: Date.now(),
    options: { keywords: ["Full Stack Developer"], jobType: "fulltime", minRating: 3.5, minReviews: 50, minStipend: 2000, maxDaysOld: 14 },
    result: {
      jobs: [
        {
          jobId: "upstash_live_999",
          title: "Principal Cloud Engineer",
          company: "Upstash Production Corp",
          score: 98,
          stipend: 75000,
          postedDaysAgo: 1,
          href: "https://www.naukri.com/upstash-live-job",
        },
      ],
      diagnostics: [],
      logs: ["[Upstash Live] Direct cloud seed successful."],
    },
  };

  await redis.set("jobpilot:circuit_breaker", JSON.stringify(testBreakerState));
  await redis.set(testCacheKey, JSON.stringify(testCacheData), { ex: 86400 });
  console.log("✅ Written 'jobpilot:circuit_breaker' and cache key to Upstash Redis Cloud.\n");

  // 2. Fetch RAW Keys via Upstash REST API (Simulating Upstash Console / CLI query)
  console.log("--- 2. RAW UPSTASH REST API / CONSOLE OUTPUT ---");
  
  // List Keys matching 'jobpilot:*'
  const keysRes = await fetch(`${url}/keys/jobpilot:*`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keysJson = await keysRes.json();
  console.log("RAW Upstash Console GET /keys/jobpilot:* Response:");
  console.log(JSON.stringify(keysJson, null, 2));

  // Get 'jobpilot:circuit_breaker' raw string
  const cbRes = await fetch(`${url}/get/jobpilot:circuit_breaker`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const cbJson = await cbRes.json();
  console.log("\nRAW Upstash Console GET /get/jobpilot:circuit_breaker Response:");
  console.log(JSON.stringify(cbJson, null, 2));

  // Get Cache Key raw string
  const cacheRes = await fetch(`${url}/get/${testCacheKey}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const cacheJson = await cacheRes.json();
  console.log(`\nRAW Upstash Console GET /get/${testCacheKey} Response (Truncated preview):`);
  console.log(JSON.stringify(cacheJson, null, 2).substring(0, 400) + "...}\n");

  // 3. Genuine Two-Process Kill-and-Restart Test backed by Upstash Redis
  console.log("--- 3. GENUINE TWO-PROCESS RESTART TEST WITH UPSTASH REDIS ---");

  // Launch Process 1
  console.log("Starting Process 1 (Port 3000)...");
  const envVars = { ...process.env, UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token };
  const p1 = exec("npx tsx src/server.ts", { cwd: process.cwd(), env: envVars });
  console.log(`Process 1 PID: ${p1.pid}`);

  await new Promise((r) => setTimeout(r, 4000));

  let status1: any;
  try {
    const r = await fetch("http://localhost:3000/api/status");
    status1 = await r.json();
    console.log("Process 1 HTTP Status:", JSON.stringify(status1, null, 2));
  } catch (e: any) {
    console.error("Process 1 status error:", e.message);
  }

  // Hard Kill Process 1
  console.log(`\nHard killing Process 1 (PID ${p1.pid})...`);
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${p1.pid} /t /f`);
    } else {
      p1.kill("SIGKILL");
    }
  } catch (e) {}

  await new Promise((r) => setTimeout(r, 2000));

  // Confirm process is dead
  try {
    await fetch("http://localhost:3000/api/status");
    console.error("❌ Process 1 still responding!");
  } catch (e) {
    console.log("✅ Verified Process 1 is DEAD (Connection Refused).");
  }

  // Launch Process 2
  console.log("\nStarting Process 2 (Port 3000)...");
  const p2 = exec("npx tsx src/server.ts", { cwd: process.cwd(), env: envVars });
  console.log(`Process 2 PID: ${p2.pid}`);

  await new Promise((r) => setTimeout(r, 4000));

  let status2: any;
  let search2: any;

  try {
    const rStatus = await fetch("http://localhost:3000/api/status");
    status2 = await rStatus.json();
    console.log("Process 2 HTTP Status (Read from Upstash):", JSON.stringify(status2, null, 2));

    const rSearch = await fetch("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords: ["Full Stack Developer"],
        jobType: "fulltime",
        minRating: 3.5,
        minReviews: 50,
        minStipend: 2000,
        maxDaysOld: 14,
      }),
    });
    search2 = await rSearch.json();
    console.log("Process 2 HTTP Search (Read from Upstash):", JSON.stringify(search2, null, 2));
  } catch (e: any) {
    console.error("Process 2 error:", e.message);
  }

  // Hard Kill Process 2
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${p2.pid} /t /f`);
    } else {
      p2.kill("SIGKILL");
    }
  } catch (e) {}

  console.log("\n=========================================================================");
  console.log("                  EVALUATION OF UPSTASH PERSISTENCE                      ");
  console.log("=========================================================================");
  console.log("1. Upstash Redis Configured Flag:", status2?.redisConfigured);
  console.log("2. Circuit Breaker State (Must be OPEN):", status2?.circuitBreaker?.currentState);
  console.log("3. Search Response isCached (Must be true):", search2?.isCached);
  console.log("4. Retrieved Job Title:", search2?.result?.jobs?.[0]?.title);
  console.log("=========================================================================\n");
}

runUpstashLiveTest().catch(console.error);
