import { chromium, Page } from "playwright";
import { rankJobs, FinalRankedJob } from "./ranker";
import fs from "fs";
import os from "os";
import path from "path";

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

export interface SearchRunResult {
  jobs: FinalRankedJob[];
  diagnostics: SearchDiagnostics[];
  logs: string[];
}

export function evaluateFullJobFilters(
  listing: { rating: number | null; reviews: number | null; stipend: number | null },
  details: FullJobDetails,
  options: SearchOptions
): { passed: boolean; rejectionReasons: string[] } {
  const rejectionReasons: string[] = [];

  if (options.minRating !== null) {
    if (listing.rating === null) {
      rejectionReasons.push("rating_unknown");
    } else if (listing.rating < options.minRating) {
      rejectionReasons.push(`rating_below_${options.minRating}`);
    }
  }

  if (options.minReviews !== null) {
    if (listing.reviews === null) {
      rejectionReasons.push("reviews_unknown");
    } else if (listing.reviews < options.minReviews) {
      rejectionReasons.push(`reviews_below_${options.minReviews}`);
    }
  }

  if (options.minStipend !== null) {
    if (listing.stipend !== null && listing.stipend < options.minStipend) {
      rejectionReasons.push(`stipend_below_${options.minStipend}`);
    }
  }

  if (options.maxDaysOld !== null) {
    // Some API records intentionally expose no trustworthy post date (for
    // example createdDate: 0). Unknown is not evidence that a role is stale.
    if (details.postedDaysAgo !== null && details.postedDaysAgo > options.maxDaysOld) {
      rejectionReasons.push(`freshness_older_than_${options.maxDaysOld}_days`);
    }
  }

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

    const postedAgeText = postedStat?.querySelector("span")?.textContent?.trim() ?? null;

    let postedDaysAgo: number | null = null;
    if (postedAgeText) {
      const text = postedAgeText.toLowerCase();
      if (text === "today" || text === "just now") {
        postedDaysAgo = 0;
      } else {
        const daysMatch = text.match(/(\d+)\s+days?\s+ago/);
        const weekMatch = text.match(/(\d+)\+?\s+weeks?\s+ago/);
        if (daysMatch) {
          postedDaysAgo = Number(daysMatch[1]);
        } else if (weekMatch) {
          postedDaysAgo = Number(weekMatch[1]) * 7;
        }
      }
    }

    return {
      rawText: bodyText,
      description: descriptionEl ? (descriptionEl.textContent || "").trim() : null,
      role: detailMap["Role"] ?? null,
      industry: detailMap["Industry Type"] ?? null,
      department: detailMap["Department"] ?? null,
      employmentType: detailMap["Employment Type"] ?? null,
      roleCategory: detailMap["Role Category"] ?? null,
      keySkills,
      postedAgeText,
      postedDaysAgo,
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

import { chromium as extraChromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

extraChromium.use(stealthPlugin());

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
  const postedText = text(first(job?.createdDate, job?.postedDate, job?.postedDateText, job?.footerPlaceholderLabel, ""));
  const postedMatch = postedText.match(/(\d+)\s*days?\s*ago/i);
  const salaryText = text(first(job?.salary, job?.salaryDetail, job?.salaryText, job?.salary3, placeholder("salary"), ""));

  return {
    title: text(first(job?.jobTitle, job?.title, job?.designation, "")),
    company: text(first(job?.companyName, job?.compName, job?.company?.name, "")),
    rating: number(first(job?.ambitionBoxData?.AggregateRating, job?.companyRating, job?.rating, job?.company?.rating)),
    reviews: number(first(job?.ambitionBoxData?.ReviewsCount, job?.companyReviews, job?.reviews, job?.reviewCount, job?.company?.reviews)),
    postedDaysAgo: postedMatch ? Number(postedMatch[1]) : (/today|just now|few hours?/i.test(postedText) ? 0 : null),
    stipend: /unpaid/i.test(salaryText) ? 0 : (/(month|stipend)/i.test(salaryText) ? number(salaryText) : null),
    experience: text(first(job?.experienceText, job?.experience, job?.exp, placeholder("experience"), "")),
    location: text(first(job?.location, job?.jobLocation, job?.locationText, placeholder("location"), "")),
    href,
    // Detail pages can be blocked or incomplete; preserve the API description
    // as a reliable fallback for qualification.
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

  let context;
  const launchOptions = {
    headless: options.headless,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--window-size=1920,1080",
    ],
    viewport: { width: 1280, height: 800 },
  };

  const profileDir = path.join(os.tmpdir(), "jobpilot-browser-profile");
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  try {
    context = await extraChromium.launchPersistentContext(profileDir, {
      ...launchOptions,
    });
  } catch (err) {
    context = await extraChromium.launchPersistentContext(profileDir, launchOptions);
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
  });

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

    await page.goto(directUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // If still hit Access Denied, try homepage fallback navigation with human-like interactions
    const initialTitle = await page.title();
    if (initialTitle.toLowerCase().includes("access denied") || initialTitle.toLowerCase().includes("just a moment")) {
      log(`[Warning] Direct navigation hit Cloudflare protection ("${initialTitle}"). Attempting fallback navigation via homepage...`);
      await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);

      const searchJobsBtn = page.getByRole("button", { name: "Search jobs here" })
        .or(page.locator('.qsb-title, .suggestor-input'))
        .first();

      if (await searchJobsBtn.isVisible().catch(() => false)) {
        await searchJobsBtn.click().catch(() => {});
        await page.waitForTimeout(800);
      }

      const keywordInput = page.getByPlaceholder("Enter keyword / designation / companies")
        .or(page.locator('input[placeholder*="keyword"]'))
        .or(page.locator('.suggestor-input input'))
        .first();

      if (await keywordInput.isVisible().catch(() => false)) {
        await keywordInput.click().catch(() => {});
        await page.waitForTimeout(300);
        for (const char of keyword) {
          await keywordInput.press(char);
          await page.waitForTimeout(40 + Math.floor(Math.random() * 60));
        }
        await page.waitForTimeout(600);

        const searchBtn = page.getByRole("button", { name: "Search", exact: true })
          .or(page.locator('button:has-text("Search"), .qsbSubmit'))
          .first();

        if (await searchBtn.isVisible().catch(() => false)) {
          await searchBtn.click().catch(() => {});
          await page.waitForTimeout(4000);
        }
      }
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

    const cardSelector = ".srp-jobtuple-wrapper, div.cust-job-tuple, article.jobTuple, div.jobTuple, [data-job-id], div.srp-tuple-box, .styles_job-listing-container__tuple, div.tuple";

    while (pageNumber <= options.maxPages) {
      try {
        // API capture is authoritative. This probe is only a diagnostic fallback.
        if (!apiListingsByPage.has(pageNumber)) {
          await page.waitForSelector(cardSelector, { timeout: 100 });
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

          const daysAgoMatch = fullText.match(/(\d+)\s*days?\s*ago/i);
          const postedDaysAgo = daysAgoMatch ? parseInt(daysAgoMatch[1], 10) : (fullText.includes("today") || fullText.includes("just now") ? 0 : null);

          let stipend: number | null = null;
          if (/unpaid/i.test(fullText)) {
            stipend = 0;
          } else {
            const stipendMatch = fullText.match(/(?:₹|Rs\.?|INR)?\s*([\d,]+)\s*(?:\/\s*month|per month)/i);
            if (stipendMatch) {
              stipend = parseInt(stipendMatch[1].replace(/,/g, ""), 10);
            }
          }

          const experienceEl = card.querySelector(".exp, .exp-wrap");
          const locationEl = card.querySelector(".loc, .loc-wrap");

          return {
            title,
            company,
            rating: ratingEl ? parseFloat(ratingEl.textContent || "") : null,
            reviews: parsedReviews,
            postedDaysAgo,
            stipend,
            experience: experienceEl ? (experienceEl.textContent || "").trim() : "",
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

      // CHANGE: Early exit during pagination if any card on current page exceeds maxDaysOld
      if (options.maxDaysOld !== null) {
        const olderJob = pageListings.find(
          (j) => j.postedDaysAgo !== null && j.postedDaysAgo > options.maxDaysOld!
        );
        if (olderJob) {
          log(`[Early Stop] Card "${olderJob.title}" is ${olderJob.postedDaysAgo} days old (> ${options.maxDaysOld} max limit). Since search is sorted by Date, all subsequent pages will be older. Stopping pagination at Page ${pageNumber}.`);
          break;
        }
      }

      if (pageNumber < options.maxPages) {
        const nextPageNum = pageNumber + 1;
        let clicked = false;
        try {
          await page.evaluate(() => window.scrollBy({ top: 400 + Math.random() * 300, behavior: "smooth" }));
          await page.waitForTimeout(500);
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(800);

          const nextHref = await page.locator('a.styles_btn-secondary__2AsIP, a[class*="pagination"]:has-text("Next"), a:has-text("Next")')
            .first()
            .getAttribute("href")
            .catch(() => null);

          const pageBtn = page.getByRole("link", { name: String(nextPageNum), exact: true })
            .or(page.locator(`a:has-text("${nextPageNum}")`))
            .or(page.locator('a[class*="btn-secondary"]:has-text("Next"), a:has-text("Next"), button:has-text("Next")'))
            .first();

          if (await pageBtn.isVisible().catch(() => false)) {
            log(`[Pagination] Randomized human delay before clicking page ${nextPageNum}...`);
            await humanDelay(3500, 6500);
            await pageBtn.click().catch(() => {});
            await page.waitForTimeout(3000);
            clicked = true;
            pageNumber++;
          } else if (nextHref) {
            log(`[Pagination] Found DOM next href link (${nextHref}). Navigating with human delay...`);
            await humanDelay(3500, 6500);
            const absoluteNextUrl = nextHref.startsWith("http") ? nextHref : new URL(nextHref, page.url()).toString();
            await page.goto(absoluteNextUrl, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(3000);
            clicked = true;
            pageNumber++;
          }
        } catch (err) {}

        if (!clicked) {
          const currentUrl = page.url();
          const nextUrl = getNextPageUrl(currentUrl, pageNumber + 1);
          if (nextUrl !== currentUrl) {
            log(`[Pagination] Fallback URL navigation to page ${pageNumber + 1}...`);
            await humanDelay(3500, 6500);
            pageNumber++;
            await page.goto(nextUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
            await page.waitForTimeout(2500);
          } else {
            break;
          }
        }
      } else {
        break;
      }
    }

    const uniqueListingMap = new Map<string, any>();
    for (const item of allJobListings) {
      if (item.href && !uniqueListingMap.has(item.href)) {
        uniqueListingMap.set(item.href, item);
      }
    }
    const jobListings = Array.from(uniqueListingMap.values());

    const rejectionCounts: Record<string, number> = {};
    const evaluatedListings = jobListings.map((job) => {
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
        if (job.stipend !== null && job.stipend < options.minStipend) reasons.push(`stipend_below_${options.minStipend}`);
      }

      if (reasons.length > 0) {
        for (const r of reasons) rejectionCounts[r] = (rejectionCounts[r] || 0) + 1;
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
      if (details.postedDaysAgo === null && targetJob.postedDaysAgo !== null) {
        details.postedDaysAgo = targetJob.postedDaysAgo;
        details.postedAgeText = `${targetJob.postedDaysAgo} days ago (API)`;
      }
      log(`[QUALIFY] "${targetJob.title}" -> rating=${targetJob.rating ?? "unknown"}, reviews=${targetJob.reviews ?? "unknown"}, ageDays=${details.postedDaysAgo ?? "unknown"}, descLen=${details.description?.length ?? 0}`);
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

        if (options.maxDaysOld !== null && details.postedDaysAgo !== null && details.postedDaysAgo > options.maxDaysOld) {
          log(`[Early Exit] Job is ${details.postedDaysAgo} days old (> ${options.maxDaysOld} max limit). Stopping further checks for "${keyword}".`);
          break;
        }
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

  await context.close();

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

  log(`\n[Search Completed] Total Qualified & Ranked Jobs: ${finalRanked.length}`);

  return {
    jobs: finalRanked,
    diagnostics,
    logs,
  };
}
