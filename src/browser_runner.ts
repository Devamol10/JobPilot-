import { chromium, Page } from "playwright";
import { rankJobs, FinalRankedJob } from "./ranker";
import fs from "fs";
import os from "os";
import path from "path";

export class StructuralBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuralBlockError";
  }
}

export async function isGenuineBlock(page: Page, statusCode?: number): Promise<boolean> {
  if (statusCode === 403 || statusCode === 503) {
    return true;
  }

  const url = page.url();
  if (!url || url === "about:blank") {
    return false;
  }

  const title = (await page.title().catch(() => "")).trim().toLowerCase();
  const signatures = ["access denied", "just a moment", "attention required", "cf-browser-verification", "enable javascript"];
  if (signatures.some((s) => title.includes(s))) {
    return true;
  }

  const bodyText = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).trim().toLowerCase();
  if (signatures.some((s) => bodyText.includes(s))) {
    return true;
  }

  // Status 200 on naukri.com with no block signatures is a valid response, not an IP block!
  if (statusCode === 200 || url.includes("naukri.com")) {
    return false;
  }

  return false;
}

export function looksBlocked(title: string, statusCode?: number): boolean {
  const t = (title || "").trim().toLowerCase();
  const signatures = ["access denied", "just a moment", "attention required", "cf-browser-verification"];
  return signatures.some((s) => t.includes(s)) || statusCode === 403 || statusCode === 503;
}


export interface SearchOptions {
  keywords: string[];
  jobType: "all" | "internship" | "fulltime";
  minRating: number | null;
  minReviews: number | null;
  minStipend: number | null;
  maxDaysOld: number | null;
  maxPages: number;
  headless: boolean;
}

export interface FullJobDetails {
  rawText: string;
  description: string | null;
  role: string | null;
  industry: string | null;
  department: string | null;
  employmentType: string | null;
  roleCategory: string | null;
  keySkills: string[];
  postedAgeText: string | null;
  postedDaysAgo: number | null;
  isInternship: boolean;
}

export interface CombinedJob {
  title: string;
  company: string;
  href: string;
  rating: number | null;
  reviews: number | null;
  stipend: number | null;
  location: string;
  experience: string;
  role: string | null;
  industry: string | null;
  department: string | null;
  employmentType: string | null;
  roleCategory: string | null;
  postedAgeText: string | null;
  postedDaysAgo: number | null;
  description: string | null;
  keySkills: string[];
  fullText: string;
  matchedKeywords: string[];
  details?: FullJobDetails;
  score?: number;
}

export interface SearchDiagnostics {
  keyword: string;
  totalExtracted: number;
  pagesScanned: number;
  rejectionCounts: Record<string, number>;
  qualifiedCount: number;
}

export interface RejectedJob {
  title: string;
  company: string;
  href: string;
  rating: number | null;
  reviews: number | null;
  stipend: number | null;
  location: string;
  postedDaysAgo: number | null;
  postedAgeText: string | null;
  reasons: string[];
}

export interface SearchRunResult {
  jobs: FinalRankedJob[];
  rejectedJobs: RejectedJob[];
  diagnostics: SearchDiagnostics[];
  logs: string[];
}

export function parsePostedAgeText(text: string | null | undefined): number | null {
  if (!text) return null;
  const normalized = text.toLowerCase().trim();
  if (normalized === "today" || normalized === "just now" || /few hours?/.test(normalized)) {
    return 0;
  }
  const daysMatch = normalized.match(/(\d+)\+?\s*days?\s*ago/);
  if (daysMatch) return Number(daysMatch[1]);
  const weekMatch = normalized.match(/(\d+)\+?\s*weeks?\s*ago/);
  if (weekMatch) return Number(weekMatch[1]) * 7;
  const monthMatch = normalized.match(/(\d+)\+?\s*months?\s*ago/);
  if (monthMatch) return Number(monthMatch[1]) * 30;
  return null;
}

export function detectIsInternship(signals: {
  title?: string | null;
  experience?: string | null;
  employmentType?: string | null;
  bodyText?: string | null;
}): boolean {
  const combined = [signals.employmentType, signals.title, signals.experience, signals.bodyText]
    .filter(Boolean)
    .join("\n");
  return /\binternship\b/i.test(combined) || /\bintern\b/i.test(combined);
}

export function parseStipendFromSignals(signals: {
  salaryText?: string | null;
  bodyText?: string | null;
  monthlySalary?: number | null;
}): number | null {
  const combined = `${signals.salaryText || ""}\n${signals.bodyText || ""}`;
  if (/\bunpaid\b/i.test(combined)) return 0;

  const salaryText = signals.salaryText || "";
  if (/(month|stipend|\/\s*mo)/i.test(salaryText)) {
    const match = salaryText.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }

  if (signals.bodyText) {
    const stipendMatch = signals.bodyText.match(
      /(?:₹|Rs\.?|INR)?\s*([\d,]+)\s*(?:\/\s*month|per month)/i
    );
    if (stipendMatch) return parseInt(stipendMatch[1].replace(/,/g, ""), 10);
  }

  return signals.monthlySalary && signals.monthlySalary > 0 ? signals.monthlySalary : null;
}

function evaluateListingFilters(
  job: {
    rating: number | null;
    reviews: number | null;
    stipend: number | null;
    postedDaysAgo: number | null;
    title?: string;
    experience?: string;
    isInternship?: boolean;
  },
  options: SearchOptions
): string[] {
  const reasons: string[] = [];

  if (options.minRating !== null) {
    if (job.rating === null) reasons.push("rating_unknown");
    else if (job.rating < options.minRating) reasons.push(`rating_below_${options.minRating}`);
  }

  if (options.minReviews !== null) {
    if (job.reviews === null) reasons.push("reviews_unknown");
    else if (job.reviews < options.minReviews) reasons.push(`reviews_below_${options.minReviews}`);
  }

  if (options.minStipend !== null) {
    if (job.stipend === null) reasons.push("stipend_unknown");
    else if (job.stipend < options.minStipend) reasons.push(`stipend_below_${options.minStipend}`);
  }

  if (options.maxDaysOld !== null) {
    if (job.postedDaysAgo === null) reasons.push("freshness_unknown");
    else if (job.postedDaysAgo > options.maxDaysOld) {
      reasons.push(`freshness_older_than_${options.maxDaysOld}_days`);
    }
  }

  if (options.jobType === "internship" && !job.isInternship) {
    reasons.push("job_type_not_internship");
  }
  if (options.jobType === "fulltime" && job.isInternship) {
    reasons.push("job_type_internship");
  }

  return reasons;
}

export function evaluateFullJobFilters(
  listing: {
    rating: number | null;
    reviews: number | null;
    stipend: number | null;
    title?: string;
    experience?: string;
    isInternship?: boolean;
  },
  details: FullJobDetails,
  options: SearchOptions
): { passed: boolean; rejectionReasons: string[] } {
  const isInternship =
    details.isInternship ||
    listing.isInternship ||
    detectIsInternship({
      title: listing.title,
      experience: listing.experience,
      employmentType: details.employmentType,
      bodyText: details.rawText,
    });

  const mergedListing = {
    ...listing,
    stipend: listing.stipend ?? parseStipendFromSignals({ bodyText: details.rawText }),
    postedDaysAgo: details.postedDaysAgo,
    isInternship,
  };

  const rejectionReasons = evaluateListingFilters(mergedListing, options);

  if (!details.description || details.description.length < 20) {
    rejectionReasons.push("missing_or_short_description");
  }

  return {
    passed: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

async function extractJobDetails(page: Page): Promise<FullJobDetails> {
  return await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const descriptionEl = document.querySelector(".styles_JDC__dang-inner-html__h0K4t");

    const details = Array.from(
      document.querySelectorAll(".styles_other-details__oEN4O .styles_details__Y424J")
    ).map((el) => {
      const label = el.querySelector("label")?.textContent?.trim().replace(/:$/, "") || "";
      const value = el.querySelector("span")?.textContent?.trim().replace(/,\s*$/, "") || "";
      return { label, value };
    });

    const detailMap = Object.fromEntries(details.map(({ label, value }) => [label, value]));

    const keySkills = Array.from(
      document.querySelectorAll(".styles_key-skill__GIPn_ a span")
    )
      .map((el) => el.textContent?.trim())
      .filter((text): text is string => Boolean(text));

    const postedStat = Array.from(
      document.querySelectorAll(".styles_jhc__stat__PgY67")
    ).find((el) => el.querySelector("label")?.textContent?.trim() === "Posted:");

    // Campus and regular Naukri job pages use different markup. Fall back to
    // visible page text so "Posted: 3+ weeks ago" is never silently unknown.
    const postedFromBody = bodyText.match(/Posted:\s*([^\n|]+)/i)?.[1]?.trim() ?? null;
    const postedAgeText = postedStat?.querySelector("span")?.textContent?.trim() ?? postedFromBody;

    const parsePostedAgeText = (text: string | null | undefined): number | null => {
      if (!text) return null;
      const normalized = text.toLowerCase().trim();
      if (normalized === "today" || normalized === "just now" || /few hours?/.test(normalized)) {
        return 0;
      }
      const daysMatch = normalized.match(/(\d+)\+?\s*days?\s*ago/);
      if (daysMatch) return Number(daysMatch[1]);
      const weekMatch = normalized.match(/(\d+)\+?\s*weeks?\s*ago/);
      if (weekMatch) return Number(weekMatch[1]) * 7;
      const monthMatch = normalized.match(/(\d+)\+?\s*months?\s*ago/);
      if (monthMatch) return Number(monthMatch[1]) * 30;
      return null;
    };

    const detectIsInternship = (title: string, experience: string, employmentType: string, pageText: string) => {
      const combined = [employmentType, title, experience, pageText].filter(Boolean).join("\n");
      return /\binternship\b/i.test(combined) || /\bintern\b/i.test(combined);
    };

    const pageTitle =
      document.querySelector("h1, .styles_jd-header-title__rYwM3, [class*='job-title']")?.textContent?.trim() || "";
    const postedDaysAgo = parsePostedAgeText(postedAgeText);
    const employmentType = detailMap["Employment Type"] ?? null;

    return {
      rawText: bodyText,
      description: descriptionEl ? (descriptionEl.textContent || "").trim() : null,
      role: detailMap["Role"] ?? null,
      industry: detailMap["Industry Type"] ?? null,
      department: detailMap["Department"] ?? null,
      employmentType,
      roleCategory: detailMap["Role Category"] ?? null,
      keySkills,
      postedAgeText,
      postedDaysAgo,
      isInternship: detectIsInternship(pageTitle, detailMap["Experience"] || "", employmentType || "", bodyText),
    };
  });
}

function getNextPageUrl(urlStr: string, nextPage: number): string {
  try {
    const url = new URL(urlStr);
    url.pathname = url.pathname.replace(/(?:-\d+)?$/, `-${nextPage}`);
    return url.toString();
  } catch (e) {
    return urlStr;
  }
}

// Manual stealth scripts injected via addInitScript (no playwright-extra needed)
// This avoids the __name is not defined error caused by esbuild/tsx bundler
// leaking helper functions into Playwright's browser-context serialization.

async function solveWithFlareSolverr(targetUrl: string): Promise<{ cookies?: any[]; userAgent?: string; html?: string } | null> {
  const flaresolverrUrl = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
  try {
    const res = await fetch(flaresolverrUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: "request.get",
        url: targetUrl,
        maxTimeout: 60000,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (data.status === "ok" && data.solution) {
      return {
        cookies: data.solution.cookies,
        userAgent: data.solution.userAgent,
        html: data.solution.response,
      };
    }
  } catch (err) {
    // FlareSolverr not running locally/unreachable, fallback to stealth
  }
  return null;
}

function constructDirectNaukriUrl(keyword: string, jobType: string): string {
  const formattedKeyword = keyword.trim().toLowerCase().replace(/\s+/g, "-");
  if (jobType === "internship") {
    return `https://www.naukri.com/${formattedKeyword}-internship-jobs`;
  }
  return `https://www.naukri.com/${formattedKeyword}-jobs`;
}

// Normalise API records once, so downstream filters do not depend on React DOM.
function listingFromApiJob(job: any): any {
  const first = (...values: any[]) => values.find((v) => v !== undefined && v !== null && v !== "");
  const text = (v: any) => typeof v === "string" ? v : (v == null ? "" : String(v));
  const number = (v: any): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const match = text(v).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  };
  const placeholder = (kind: string) => {
    const item = Array.isArray(job?.placeholders)
      ? job.placeholders.find((p: any) => text(p?.type || p?.key || p?.name).toLowerCase() === kind)
      : null;
    return first(item?.label, item?.value, item?.text);
  };
  const url = text(first(job?.jdURL, job?.jdUrl, job?.jobUrl, job?.jobURL, job?.url, job?.seoUrl, ""));
  const href = url && !/^https?:\/\//i.test(url)
    ? `https://www.naukri.com${url.startsWith("/") ? "" : "/"}${url}`
    : url;
  const postedText = text(first(job?.footerPlaceholderLabel, job?.postedDateText, job?.postedDate, ""));
  const relativePostedDays = parsePostedAgeText(postedText);
  const createdDate = number(job?.createdDate);
  const createdAtMs = createdDate && createdDate > 0
    ? (createdDate < 100_000_000_000 ? createdDate * 1000 : createdDate)
    : null;
  const createdDaysAgo = createdAtMs && createdAtMs <= Date.now()
    ? Math.floor((Date.now() - createdAtMs) / 86_400_000)
    : null;
  const salaryText = text(first(
    job?.salary,
    job?.salaryText,
    job?.salary3,
    job?.stipend,
    job?.stipendText,
    job?.compensation,
    placeholder("salary"),
    placeholder("stipend"),
    job?.salaryDetail?.label,
    job?.salaryDetail?.text,
    ...(Array.isArray(job?.placeholders)
      ? job.placeholders.map((p: any) => text(first(p?.label, p?.value, p?.text)))
      : [])
  ));
  const rawMonthlySalary = number(first(job?.salaryDetail?.minSalaryPerMonth, job?.salaryDetail?.maxSalaryPerMonth));
  const monthlySalary = rawMonthlySalary && rawMonthlySalary > 0 ? rawMonthlySalary : null;
  const title = text(first(job?.jobTitle, job?.title, job?.designation, ""));
  const experience = text(first(job?.experienceText, job?.experience, job?.exp, placeholder("experience"), ""));
  const employmentType = text(first(job?.employmentType, job?.jobType, job?.type, ""));

  return {
    title,
    company: text(first(job?.companyName, job?.compName, job?.company?.name, "")),
    rating: number(first(job?.ambitionBoxData?.AggregateRating, job?.companyRating, job?.rating, job?.company?.rating)),
    reviews: number(first(job?.ambitionBoxData?.ReviewsCount, job?.companyReviews, job?.reviews, job?.reviewCount, job?.company?.reviews)),
    postedAgeText: postedText || null,
    postedDaysAgo: relativePostedDays ?? createdDaysAgo,
    postedFromRelativeText: relativePostedDays !== null,
    stipend: parseStipendFromSignals({
      salaryText: /\bunpaid\b/i.test(JSON.stringify(job)) ? `Unpaid\n${salaryText}` : salaryText,
      monthlySalary,
    }),
    experience,
    isInternship: detectIsInternship({
      title,
      experience,
      employmentType,
      bodyText: salaryText,
    }),
    location: text(first(job?.location, job?.jobLocation, job?.locationText, placeholder("location"), "")),
    href,
    jobId: text(first(job?.jobId, job?.jobID, job?.id, href)),
    apiDescription: text(first(job?.jobDescription, job?.description, job?.jobDesc, "")),
    fullText: JSON.stringify(job),
  };
}

export async function runJobSearch(
  options: SearchOptions,
  logCallback?: (msg: string) => void
): Promise<SearchRunResult> {
  const logs: string[] = [];
  const diagnostics: SearchDiagnostics[] = [];

  const log = (msg: string) => {
    logs.push(msg);
    console.log(msg);
    if (logCallback) logCallback(msg);
  };

  log(`[JobPilot Engine] Starting search run...`);
  log(`[Config] Keywords: ${options.keywords.join(", ")} | Headless: ${options.headless}`);
  log(`[Config] Filters: Rating >= ${options.minRating ?? "Any"}, Reviews >= ${options.minReviews ?? "Any"}, Stipend >= ₹${options.minStipend ?? "Any"}, Max Age <= ${options.maxDaysOld ?? "Any"} days`);

  let browser;
  let context;
  
  try {
    if (process.env.BRIGHTDATA_WS_URL) {
      log(`[Proxy] Connecting to BrightData Scraping Browser over CDP...`);
      browser = await chromium.connectOverCDP(process.env.BRIGHTDATA_WS_URL);
      // BrightData Scraping Browser provides a default context
      context = browser.contexts()[0]; 
      if (!context) {
        context = await browser.newContext();
      }
    } else {
      const proxyConfig = process.env.PROXY_URL ? { server: process.env.PROXY_URL } : undefined;
      if (proxyConfig) {
        log(`[Proxy] Using configured standard proxy: ${process.env.PROXY_URL}`);
      }
      browser = await chromium.launch({ headless: options.headless, proxy: proxyConfig });
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });
    }
  } catch (err: any) {
    log(`[Error] Browser initialization failed: ${err.message}. Falling back to default headless launch.`);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  }

  // Stealth polyfill for esbuild __name helper inside browser context
  await context.addInitScript(() => {
    if (typeof (window as any).__name === "undefined") {
      (window as any).__name = (target: any, value: string) => target;
    }
  });

  // Manual stealth: hide webdriver flag, fake plugins/languages, patch permissions
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // Fake chrome runtime
    if (!(window as any).chrome) {
      (window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    }

    // Fake plugins array
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map(() => ({ name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" })),
    });

    // Fake languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-IN", "en-US", "en"],
    });

    // Hide permissions query automation detection
    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      (window.navigator.permissions as any).query = (params: any) =>
        params.name === "notifications"
          ? Promise.resolve({ state: "denied" } as PermissionStatus)
          : originalQuery(params);
    }
  });

  const page = await context.newPage();

  // JSON responses are the primary listing source; React card rendering is
  // asynchronous and selector-dependent.
  const apiListingsByPage = new Map<number, any[]>();
  let apiRawSampleLogged = false;
  // Diagnostics Network Response Listener with API body jobCount inspector
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/jobapi/") || url.includes("naukri.com/search") || url.includes("cloud-block") || url.includes("challenge")) {
      log(`[NETWORK LOG] ${response.status()} — ${url}`);
    }
    if (url.includes("/jobapi/v3/search") || url.includes("/jobapi/")) {
      try {
        const body = (await response.json()) as any;
        if (url.includes("/jobapi/v3/search")) {
          const apiPageNo = Number(new URL(url).searchParams.get("pageNo") || "1");
          const apiJobs = Array.isArray(body?.jobDetails) ? body.jobDetails : [];
          if (apiJobs.length > 0) {
            apiListingsByPage.set(apiPageNo, apiJobs.map(listingFromApiJob));
            log(`[API CAPTURE] pageNo=${apiPageNo} -> ${apiJobs.length} jobs captured`);
            if (!apiRawSampleLogged) {
              apiRawSampleLogged = true;
              log(`[API RAW SAMPLE] ${JSON.stringify(apiJobs[0], null, 2)}`);
            }
          }
        }
        const pageNo = new URL(url).searchParams.get("pageNo") || "1";
        const count = body?.jobDetails?.length ?? body?.noOfJobs ?? "N/A";
        log(`[API BODY LOG] pageNo=${pageNo} → jobCount=${count}`);
      } catch (e) {
        // ignore non-json responses
      }
    }
  });

  const humanDelay = (minMs = 3000, maxMs = 7000) =>
    new Promise((res) => setTimeout(res, minMs + Math.random() * (maxMs - minMs)));

  const allJobs: CombinedJob[] = [];
  const allRejectedJobs: RejectedJob[] = [];

  for (const keyword of options.keywords) {
    apiListingsByPage.clear();
    apiRawSampleLogged = false;
    log(`\n=== KEYWORD: "${keyword.toUpperCase()}" ===`);

    const directUrl = constructDirectNaukriUrl(keyword, options.jobType);
    log(`Attempting stealth direct navigation: ${directUrl}`);

    // Try FlareSolverr first if available
    const flareSolution = await solveWithFlareSolverr(directUrl);
    if (flareSolution?.cookies && flareSolution.cookies.length > 0) {
      log(`[FlareSolverr] Solved Cloudflare challenge! Injecting ${flareSolution.cookies.length} cookies.`);
      const formattedCookies = flareSolution.cookies.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
        path: c.path || "/",
      }));
      await context.addCookies(formattedCookies).catch(() => {});
    }

    const navResponse = await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2000);

    const initialStatus = navResponse?.status();
    const isDirectBlocked = await isGenuineBlock(page, initialStatus);

    if (isDirectBlocked) {
      const initialTitle = await page.title().catch(() => "");
      log(`[Warning] Direct navigation blocked (Title: "${initialTitle}", Status: ${initialStatus ?? "N/A"}). Retrying via homepage...`);
      const hpResponse = await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(2500);

      const hpStatus = hpResponse?.status();
      const isHpBlocked = await isGenuineBlock(page, hpStatus);

      if (isHpBlocked) {
        const hpTitle = await page.title().catch(() => "");
        log(`[STRUCTURAL BLOCK] Homepage is also blocked (Title: "${hpTitle}", Status: ${hpStatus ?? "N/A"}). Server IP flagged — naukri.com blocked at IP level.`);
        throw new StructuralBlockError("naukri.com blocked at IP level — run client-side or use proxy");
      }
    }

    const cardSelector = ".srp-jobtuple-wrapper, div.cust-job-tuple, article.jobTuple, div.jobTuple, [data-job-id], div.srp-tuple-box, .styles_job-listing-container__tuple, div.tuple";

    // If direct navigation yielded 0 listings, trigger Fallback Tier 3 query search URL
    const initialTuplesCount = await page.locator(cardSelector).count().catch(() => 0);
    if (initialTuplesCount === 0 && !apiListingsByPage.has(1)) {
      const queryUrl = `https://www.naukri.com/jobs-in-india?k=${encodeURIComponent(keyword)}${options.jobType === "internship" ? "&jobType=internship" : ""}`;
      log(`[Navigation Fallback Tier 3] Direct navigation yielded 0 listings. Navigating to Query Search SRP: ${queryUrl}`);
      await page.goto(queryUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(3000);
    }

    try {
      const sortDropdown = page.locator("button, div, span").filter({ hasText: /^Sort by:/i }).first();
      if (await sortDropdown.isVisible().catch(() => false)) {
        await sortDropdown.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.getByText("Date", { exact: true }).click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(2000);
        log("Applied 'Sort by: Date' filter.");
      }
    } catch (err) {}

    const allJobListings: any[] = [];
    let pageNumber = 1;

    while (pageNumber <= options.maxPages) {
      try {
        // API capture is authoritative. This probe is only a diagnostic fallback.
        if (!apiListingsByPage.has(pageNumber)) {
          await page.waitForSelector(cardSelector, { timeout: 8000 });
        }
      } catch (e) {
        log(`[Debug] Page ${pageNumber} → 0 listings extracted. Title: "${await page.title()}", URL: ${page.url()}`);
        
        // Take debug screenshot & HTML dump for exact root cause inspection
        const debugDir = path.join(__dirname, "../public/debug");
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        
        const timestamp = Date.now();
        await page.screenshot({ path: path.join(debugDir, `debug_${timestamp}.png`) }).catch(() => {});
        log(`[Debug Artifact] Saved screenshot: /debug/debug_${timestamp}.png`);
        // Do not stop: the API response can arrive before React renders cards.
      }

      let pageListings = apiListingsByPage.get(pageNumber) || await page.locator(cardSelector).evaluateAll((cards) => {
        return cards.map((card) => {
          const titleEl = (card.querySelector('a[href*="/job-listings-"], a[href*="/job/"], a.title, .title, h2, h3, div[class*="title"]') || card.querySelector('a')) as HTMLAnchorElement | null;
          const title = titleEl ? (titleEl.textContent || "").trim() : "";
          const href = titleEl ? titleEl.href : "";

          const companyEl = card.querySelector(".comp-name, .company-name, [class*='company'], [class*='compName'], [class*='org']") || card.querySelector("a[href*='-jobs-']");
          const company = companyEl ? (companyEl.textContent || "").trim() : "";

          const ratingEl = card.querySelector(".rating, .main-2");
          const reviewsEl = card.querySelector('a[href*="ambitionbox.com/reviews"]');
          const reviewsText = reviewsEl ? (reviewsEl.textContent || "").trim() : "";

          const fullText = (card as HTMLElement).innerText || "";
          const reviewsMatch = reviewsText.match(/([\d,]+)\s*Reviews?/i);
          const fullTextReviewsMatch = fullText.match(/([\d,]+)\s*Reviews?/i);
          const parsedReviews = reviewsMatch
            ? parseInt(reviewsMatch[1].replace(/,/g, ""), 10)
            : (fullTextReviewsMatch ? parseInt(fullTextReviewsMatch[1].replace(/,/g, ""), 10) : null);

          const postedAgeText =
            fullText.match(/(\d+\+?\s*(?:days?|weeks?|months?)\s*ago|today|just now)/i)?.[0] ?? null;
          const parsePostedAgeText = (text: string | null | undefined): number | null => {
            if (!text) return null;
            const normalized = text.toLowerCase().trim();
            if (normalized === "today" || normalized === "just now" || /few hours?/.test(normalized)) {
              return 0;
            }
            const daysMatch = normalized.match(/(\d+)\+?\s*days?\s*ago/);
            if (daysMatch) return Number(daysMatch[1]);
            const weekMatch = normalized.match(/(\d+)\+?\s*weeks?\s*ago/);
            if (weekMatch) return Number(weekMatch[1]) * 7;
            const monthMatch = normalized.match(/(\d+)\+?\s*months?\s*ago/);
            if (monthMatch) return Number(monthMatch[1]) * 30;
            return null;
          };
          const postedDaysAgo = parsePostedAgeText(postedAgeText);
          const stipendMatch = fullText.match(/(?:₹|Rs\.?|INR)?\s*([\d,]+)\s*(?:\/\s*month|per month)/i);
          const stipend = /\bunpaid\b/i.test(fullText)
            ? 0
            : (stipendMatch ? parseInt(stipendMatch[1].replace(/,/g, ""), 10) : null);

          const experienceEl = card.querySelector(".exp, .exp-wrap");
          const locationEl = card.querySelector(".loc, .loc-wrap");
          const experience = experienceEl ? (experienceEl.textContent || "").trim() : "";

          return {
            title,
            company,
            rating: ratingEl ? parseFloat(ratingEl.textContent || "") : null,
            reviews: parsedReviews,
            postedAgeText,
            postedDaysAgo,
            postedFromRelativeText: postedDaysAgo !== null,
            stipend,
            experience,
            isInternship: /\binternship\b/i.test(`${title}\n${experience}\n${fullText}`) || /\bintern\b/i.test(`${title}\n${experience}\n${fullText}`),
            location: locationEl ? (locationEl.textContent || "").trim() : "",
            href,
            fullText,
          };
        });
      });

      // Prefer the response captured before this React rendering probe.
      const capturedApiListings = apiListingsByPage.get(pageNumber);
      if (capturedApiListings) pageListings = capturedApiListings;

      log(`Page ${pageNumber} → ${pageListings.length} listings extracted`);
      const apiListings = apiListingsByPage.get(pageNumber);
      if (apiListings) {
        pageListings = apiListings;
        log(`[Listing Source] Page ${pageNumber}: API JSON (${pageListings.length} jobs)`);
      } else {
        log(`[Listing Source] Page ${pageNumber}: DOM fallback (${pageListings.length} jobs)`);
      }
      if (pageListings.length === 0) break;

      allJobListings.push(...pageListings);

      if (pageNumber < options.maxPages) {
        const currentUrl = page.url();
        const nextUrl = getNextPageUrl(currentUrl, pageNumber + 1);
        
        if (nextUrl !== currentUrl) {
          log(`[Pagination] URL sequential navigation to page ${pageNumber + 1}...`);
          await humanDelay(3500, 6500);
          pageNumber++;
          await page.goto(nextUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(2500);
        } else {
          log(`[Pagination] Cannot determine next URL from ${currentUrl}, stopping pagination.`);
          break;
        }
      } else {
        break;
      }
    }

    const uniqueListingMap = new Map<string, any>();
    for (const item of allJobListings) {
      const listingKey = item.jobId || item.href;
      if (listingKey && !uniqueListingMap.has(listingKey)) {
        uniqueListingMap.set(listingKey, item);
      }
    }
    const jobListings = Array.from(uniqueListingMap.values());

    // Sort merged results by posted date (newest first, i.e. lowest postedDaysAgo) before age filter evaluation
    jobListings.sort((a, b) => {
      const ageA = a.postedDaysAgo !== null && a.postedDaysAgo !== undefined ? a.postedDaysAgo : 999;
      const ageB = b.postedDaysAgo !== null && b.postedDaysAgo !== undefined ? b.postedDaysAgo : 999;
      return ageA - ageB;
    });

    const rejectionCounts: Record<string, number> = {};
    const evaluatedListings = jobListings.map((job) => {
      const reasons = evaluateListingFilters(job, options);

      if (reasons.length > 0) {
        for (const r of reasons) rejectionCounts[r] = (rejectionCounts[r] || 0) + 1;
        
        allRejectedJobs.push({
          title: job.title,
          company: job.company,
          href: job.href,
          rating: job.rating,
          reviews: job.reviews,
          stipend: job.stipend,
          location: job.location,
          postedDaysAgo: job.postedDaysAgo ?? null,
          postedAgeText: job.postedAgeText ?? null,
          reasons: reasons,
        });
      }

      return { job, passed: reasons.length === 0 };
    });

    const qualifiedListings = evaluatedListings.filter((e) => e.passed).map((e) => e.job);

    log(`Total Extracted: ${jobListings.length} cards | Pre-qualified: ${qualifiedListings.length}`);

    const targetJobs = qualifiedListings.length > 0
      ? qualifiedListings.slice(0, 5)
      : jobListings.slice(0, 5);

    let keywordQualified = 0;
    for (const targetJob of targetJobs) {
      if (!targetJob.href) continue;

      log(`Inspecting full job: "${targetJob.title}"`);
      await page.goto(targetJob.href, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(1500);

      const details = await extractJobDetails(page);
      if ((!details.description || details.description.length < 20) && targetJob.apiDescription) {
        details.description = targetJob.apiDescription;
        details.rawText = `${details.rawText}\n${targetJob.apiDescription}`;
        log(`[Details Fallback] Using API description for "${targetJob.title}".`);
      }
      const detailStipend = parseStipendFromSignals({ bodyText: details.rawText });
      if (targetJob.stipend === null && detailStipend !== null) {
        targetJob.stipend = detailStipend;
      }
      if (details.postedDaysAgo === null && targetJob.postedFromRelativeText && targetJob.postedDaysAgo !== null) {
        details.postedDaysAgo = targetJob.postedDaysAgo;
        details.postedAgeText = targetJob.postedAgeText || `${targetJob.postedDaysAgo} days ago (API)`;
      }
      if (!details.isInternship && targetJob.isInternship) {
        details.isInternship = true;
      }
      log(`[QUALIFY] "${targetJob.title}" -> rating=${targetJob.rating ?? "unknown"}, reviews=${targetJob.reviews ?? "unknown"}, stipend=${targetJob.stipend ?? "unknown"}, ageDays=${details.postedDaysAgo ?? "unknown"}, internship=${details.isInternship || targetJob.isInternship}, descLen=${details.description?.length ?? 0}`);
      const evalResult = evaluateFullJobFilters(targetJob, details, options);

      if (evalResult.passed) {
        log(`✓ QUALIFIED JOB: "${targetJob.title}" at ${targetJob.company}`);
        keywordQualified++;
        allJobs.push({
          title: targetJob.title,
          company: targetJob.company,
          href: targetJob.href,
          rating: targetJob.rating,
          reviews: targetJob.reviews,
          stipend: targetJob.stipend,
          location: targetJob.location,
          experience: targetJob.experience,
          role: details.role,
          industry: details.industry,
          department: details.department,
          employmentType: details.employmentType,
          roleCategory: details.roleCategory,
          postedAgeText: details.postedAgeText,
          postedDaysAgo: details.postedDaysAgo,
          description: details.description,
          keySkills: details.keySkills,
          fullText: targetJob.fullText,
          matchedKeywords: [keyword],
          details,
        });
      } else {
        log(`✗ Rejected "${targetJob.title}": ${evalResult.rejectionReasons.join(", ")}`);
        for (const r of evalResult.rejectionReasons) {
          rejectionCounts[r] = (rejectionCounts[r] || 0) + 1;
        }
        allRejectedJobs.push({
          title: targetJob.title,
          company: targetJob.company,
          href: targetJob.href,
          rating: targetJob.rating,
          reviews: targetJob.reviews,
          stipend: targetJob.stipend,
          location: targetJob.location,
          postedDaysAgo: details.postedDaysAgo ?? targetJob.postedDaysAgo ?? null,
          postedAgeText: details.postedAgeText ?? targetJob.postedAgeText ?? null,
          reasons: evalResult.rejectionReasons,
        });
      }
    }

    diagnostics.push({
      keyword,
      totalExtracted: jobListings.length,
      pagesScanned: pageNumber,
      rejectionCounts,
      qualifiedCount: keywordQualified,
    });
  }

  // Deduplicate and rank
  const jobMap = new Map<string, CombinedJob>();
  for (const job of allJobs) {
    if (jobMap.has(job.href)) {
      const existing = jobMap.get(job.href)!;
      for (const kw of job.matchedKeywords) {
        if (!existing.matchedKeywords.includes(kw)) existing.matchedKeywords.push(kw);
      }
    } else {
      jobMap.set(job.href, { ...job });
    }
  }

  const uniqueJobs = Array.from(jobMap.values());
  const finalRanked = rankJobs(uniqueJobs, 20);

  // Deduplicate rejected jobs and ensure they aren't in the final qualified list
  const rejectedJobMap = new Map<string, RejectedJob>();
  for (const rJob of allRejectedJobs) {
    if (jobMap.has(rJob.href)) continue; // Skip if it ultimately qualified (e.g., via another keyword)
    if (rejectedJobMap.has(rJob.href)) {
      const existing = rejectedJobMap.get(rJob.href)!;
      for (const r of rJob.reasons) {
        if (!existing.reasons.includes(r)) existing.reasons.push(r);
      }
    } else {
      rejectedJobMap.set(rJob.href, { ...rJob });
    }
  }
  const uniqueRejectedJobs = Array.from(rejectedJobMap.values());

  log(`\n[Search Completed] Total Qualified & Ranked Jobs: ${finalRanked.length}`);

  // Browser shutdown is cleanup, not part of producing the result. A cleanup
  // failure must not discard already-qualified jobs before the API returns.
  await browser?.close().catch((err) => {
    log(`[Warning] Browser cleanup failed after ranking: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    jobs: finalRanked,
    rejectedJobs: uniqueRejectedJobs,
    diagnostics,
    logs,
  };
}
