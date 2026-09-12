import { exec, execSync } from "child_process";

async function runTwoProcessTest() {
  console.log("=========================================================================");
  console.log("         GENUINE TWO-PROCESS KILL-AND-RESTART INTEGRATION TEST           ");
  console.log("=========================================================================\n");

  const testOptions = {
    keywords: ["Full Stack Developer"],
    jobType: "fulltime",
    minRating: 3.5,
    minReviews: 50,
    minStipend: 2000,
    maxDaysOld: 14,
    maxPages: 5,
    headless: true,
  };

  // Step 1: Start Process 1 (Standalone Server)
  console.log("--- 1. STARTING PROCESS 1 (Standalone Server on Port 3000) ---");
  const p1 = exec("npx tsx src/server.ts", { cwd: "d:\\jobpilot" });
  console.log(`Process 1 PID: ${p1.pid}`);

  // Wait 3.5 seconds for Process 1 server to bind port 3000
  await new Promise((r) => setTimeout(r, 3500));

  try {
    // Directly seed cache entry via test helper / API prior to tripping breaker
    const { cacheStore } = await import("./cache_store");
    const cacheKey = cacheStore.generateCacheKey(testOptions);
    const testResultPayload = {
      jobs: [{ jobId: "persist_123", title: "Lead Architect", company: "Upstash Corp", score: 92, stipend: 50000, postedDaysAgo: 1, href: "https://www.naukri.com/lead-architect" }],
      diagnostics: [],
      logs: ["[System] Persistent cache seed."]
    };
    await cacheStore.setCache(cacheKey, testOptions, testResultPayload);

    // Trip breaker to OPEN on Process 1 via HTTP
    console.log("Tripping breaker to OPEN on Process 1 via HTTP POST /api/test/trip-breaker...");
    const tripRes1 = await fetch("http://localhost:3000/api/test/trip-breaker", { method: "POST" });
    const tripJson1 = await tripRes1.json();
    console.log("Process 1 Trip Breaker Response:", JSON.stringify(tripJson1, null, 2));

    // Get Status & Search payload from Process 1
    const statusRes1 = await fetch("http://localhost:3000/api/status");
    const statusJson1 = await statusRes1.json();
    console.log("\nRAW Status from PROCESS 1 (Before Kill):", JSON.stringify(statusJson1, null, 2));

    const searchRes1 = await fetch("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testOptions),
    });
    const searchJson1 = await searchRes1.json();
    console.log("RAW Search Payload from PROCESS 1 (Before Kill):", JSON.stringify(searchJson1, null, 2));
  } catch (err: any) {
    console.error("Process 1 HTTP Error:", err.message);
  }

  // Step 2: HARD KILL PROCESS 1
  console.log("\n--- 2. HARD KILLING PROCESS 1 (OS Process Termination) ---");
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${p1.pid} /t /f`);
    } else {
      p1.kill("SIGKILL");
    }
    console.log(`✅ Process 1 (PID ${p1.pid}) has been HARD KILLED.`);
  } catch (e) {
    console.log("Process kill command executed.");
  }

  await new Promise((r) => setTimeout(r, 2000));

  // Verify Process 1 is dead
  try {
    await fetch("http://localhost:3000/api/status");
    console.log("❌ ERROR: Process 1 is still alive!");
  } catch (e) {
    console.log("✅ Verified Process 1 is DEAD (Connection Refused).");
  }

  // Step 3: Start Process 2 (Fresh Process Invocation)
  console.log("\n--- 3. STARTING PROCESS 2 (Fresh Server Invocation on Port 3000) ---");
  const p2 = exec("npx tsx src/server.ts", { cwd: "d:\\jobpilot" });
  console.log(`Process 2 PID: ${p2.pid}`);

  // Wait 3.5 seconds for Process 2 server to bind port 3000
  await new Promise((r) => setTimeout(r, 3500));

  let statusJson2: any = null;
  let searchJson2: any = null;

  try {
    // Query Process 2 for Status over HTTP
    console.log("Querying PROCESS 2 for Status over HTTP GET /api/status...");
    const statusRes2 = await fetch("http://localhost:3000/api/status");
    statusJson2 = await statusRes2.json();
    console.log("RAW Status from PROCESS 2 (After Restart):", JSON.stringify(statusJson2, null, 2));

    // Query Process 2 for Search Results over HTTP POST /api/search
    console.log("Querying PROCESS 2 for Cached Search Data over HTTP POST /api/search...");
    const searchRes2 = await fetch("http://localhost:3000/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testOptions),
    });
    searchJson2 = await searchRes2.json();
    console.log("RAW Search Payload from PROCESS 2 (After Restart):", JSON.stringify(searchJson2, null, 2));
  } catch (err: any) {
    console.error("Process 2 HTTP Error:", err.message);
  }

  // Hard Kill Process 2
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${p2.pid} /t /f`);
    } else {
      p2.kill("SIGKILL");
    }
  } catch (e) {}

  console.log("\n--- 4. TWO-PROCESS PERSISTENCE EVALUATION ---");
  const isBreakerPersisted = statusJson2?.circuitBreaker?.currentState === "OPEN";
  const isCachePersisted = searchJson2?.isCached === true && searchJson2?.result?.jobs?.length > 0;

  console.log("Process 2 Circuit Breaker State (Must be OPEN):", statusJson2?.circuitBreaker?.currentState);
  console.log("Process 2 Search Response isCached (Must be true):", searchJson2?.isCached);
  console.log("Process 2 Cached Job Title:", searchJson2?.result?.jobs?.[0]?.title);

  if (isBreakerPersisted && isCachePersisted) {
    console.log("\n🎉 ✅ GENUINE TWO-PROCESS RESTART TEST PASSED! State and cache survived OS process termination across two separate PIDs!");
  } else {
    console.log("\n❌ GENUINE TWO-PROCESS RESTART TEST FAILED!");
  }

  console.log("\n=========================================================================");
}

runTwoProcessTest().catch(console.error);
