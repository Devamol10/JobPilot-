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
    if (details.postedDaysAgo === null || details.postedDaysAgo > options.maxDaysOld) {
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
    context = await chromium.launchPersistentContext(profileDir, {
      ...launchOptions,
    });
  } catch (err) {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
  });

  const allJobs: CombinedJob[] = [];

  for (const keyword of options.keywords) {
    log(`\n=== KEYWORD: "${keyword.toUpperCase()}" ===`);

    log(`Navigating to Naukri homepage...`);
    await page.goto("https://www.naukri.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const searchJobsBtn = page.getByRole("button", { name: "Search jobs here" })
      .or(page.locator('.qsb-title, .suggestor-input'))
      .first();

    if (await searchJobsBtn.isVisible().catch(() => false)) {
      await searchJobsBtn.click().catch(() => {});
      await page.waitForTimeout(800);
    }

    if (options.jobType === "internship" || options.jobType === "fulltime") {
      const jobTypeDropdown = page.locator("#jobType").locator("..");
      if (await jobTypeDropdown.isVisible().catch(() => false)) {
        await jobTypeDropdown.click().catch(() => {});
        await page.waitForTimeout(500);
        const targetOptionText = options.jobType === "internship" ? "Internship" : "Full Time";
        await page.getByText(targetOptionText, { exact: true }).click().catch(() => {});
        log(`Applied '${targetOptionText}' Job Type filter.`);
      }
    }

    const keywordInput = page.getByPlaceholder("Enter keyword / designation / companies")
      .or(page.locator('input[placeholder*="keyword"]'))
      .or(page.locator('.suggestor-input input'))
      .first();

    if (await keywordInput.isVisible().catch(() => false)) {
      await keywordInput.click().catch(() => {});
      await page.waitForTimeout(300);

      // Human character-by-character typing with random delay
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
        await page.waitForSelector(cardSelector, { timeout: 10000 });
      } catch (e) {
        log(`[Debug] Page ${pageNumber} → 0 listings extracted. Title: "${await page.title()}", URL: ${page.url()}`);
        
        // Take debug screenshot & HTML dump for exact root cause inspection
        const debugDir = path.join(__dirname, "../public/debug");
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
        
        const timestamp = Date.now();
        await page.screenshot({ path: path.join(debugDir, `debug_${timestamp}.png`) }).catch(() => {});
        log(`[Debug Artifact] Saved screenshot: /debug/debug_${timestamp}.png`);
        break;
      }

      const pageListings = await page.locator(cardSelector).evaluateAll((cards) => {
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

      log(`Page ${pageNumber} → ${pageListings.length} listings extracted`);
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
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(800);

          const pageBtn = page.getByRole("link", { name: String(nextPageNum), exact: true })
            .or(page.locator(`a:has-text("${nextPageNum}")`))
            .or(page.locator('a[class*="btn-secondary"]:has-text("Next"), a:has-text("Next"), button:has-text("Next")'))
            .first();

          if (await pageBtn.isVisible().catch(() => false)) {
            await pageBtn.click().catch(() => {});
            await page.waitForTimeout(3000);
            clicked = true;
            pageNumber++;
          }
        } catch (err) {}

        if (!clicked) {
          const currentUrl = page.url();
          const nextUrl = getNextPageUrl(currentUrl, pageNumber + 1);
          if (nextUrl !== currentUrl) {
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
