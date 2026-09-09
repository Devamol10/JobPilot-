import express from "express";
import cors from "cors";
import path from "path";
import { runJobSearch, SearchOptions, SearchRunResult } from "./browser_runner";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

let isRunning = false;
let currentLogs: string[] = [];
let lastResult: SearchRunResult | null = null;

app.get("/api/status", (req, res) => {
  res.json({
    isRunning,
    logs: currentLogs,
    result: lastResult,
  });
});

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

  isRunning = true;
  currentLogs = [];
  lastResult = null;

  res.json({ status: "started", options });

  // Run asynchronously in background
  runJobSearch(options, (logMsg) => {
    currentLogs.push(logMsg);
  })
    .then((result) => {
      lastResult = result;
      isRunning = false;
    })
    .catch((err) => {
      currentLogs.push(`[ERROR] Search failed: ${err.message || err}`);
      isRunning = false;
    });
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 JobPilot Web UI is live at: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
