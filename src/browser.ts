import { chromium } from "playwright";
import { rankJobs } from "./ranker";

// CHANGE: Full Job Page Extracted Data interface
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

// CHANGE: Combined normalized job schema matching domain hierarchy
export interface CombinedJob {
  // Basic info
  title: string;
  company: string;
  href: string;

  // Company signals
  rating: number | null;
  reviews: number | null;

  // Compensation
  stipend: number | null;

  // Job metadata
  location: string;
  experience: string;
  role: string | null;
  industry: string | null;
  department: string | null;
  employmentType: string | null;
  roleCategory: string | null;

  // Freshness
  postedAgeText: string | null;
  postedDaysAgo: number | null;

  // Semantic content
  description: string | null;
  keySkills: string[];
  fullText: string;

  // Search traceability
  matchedKeywords: string[];

  // Raw full details reference
  details?: FullJobDetails;

  // Computed ranking score
  score?: number;
}

// CHANGE: add deterministic ranking score
export function scoreJob(job: CombinedJob): number {
  // Rating → higher is better
  const ratingScore =
    job.rating === null
      ? 0
      : ((job.rating - 3.5) / (5 - 3.5)) * 100;

  // Reviews → logarithmic score
  const reviewScore =
    job.reviews === null
      ? 0
      : Math.min(
          100,
          (Math.log10(job.reviews) / Math.log10(10000)) * 100
        );

  // Stipend → cap influence at ₹50,000
  const stipendScore =
    job.stipend === null
      ? 0
      : Math.min(100, (job.stipend / 50000) * 100);

  // Freshness → newer is better
  const freshnessScore =
    job.postedDaysAgo === null
      ? 0
      : Math.max(0, ((14 - job.postedDaysAgo) / 14) * 100);

  // More matching search keywords = broader coverage
  const keywordScore = Math.min(
    100,
    job.matchedKeywords.length * 50
  );

  // CHANGE: weighted final score
  const score =
    ratingScore * 0.30 +
    reviewScore * 0.20 +
    stipendScore * 0.25 +
    freshnessScore * 0.15 +
    keywordScore * 0.10;

  return Math.round(score * 100) / 100;
}

// CHANGE: Reusable full job page hard-filters function checking ALL hard constraints strictly
export function evaluateFullJobFilters(
  listing: { rating: number | null; reviews: number | null; stipend: number | null },
  details: FullJobDetails
): {
  passed: boolean;
  rejectionReasons: string[];
} {
  const rejectionReasons: string[] = [];

  // CHANGE: Rating hard filter (Rating >= 3.5)
  if (listing.rating === null) {
    rejectionReasons.push("rating_unknown");
  } else if (listing.rating < 3.5) {
    rejectionReasons.push("rating_below_3.5");
  }

  // CHANGE: Reviews hard filter (Reviews >= 50)
  if (listing.reviews === null) {
    rejectionReasons.push("reviews_unknown");
  } else if (listing.reviews < 50) {
    rejectionReasons.push("reviews_below_50");
  }

  // CHANGE: Stipend hard filter (Stipend > ₹2,000)
  if (listing.stipend !== null && listing.stipend <= 2000) {
    rejectionReasons.push("stipend_not_above_2000");
  }

  // CHANGE: Freshness hard filter (Age <= 14 days)
  if (details.postedDaysAgo === null || details.postedDaysAgo > 14) {
    rejectionReasons.push("freshness_older_than_14_days_or_unknown");
  }

  // CHANGE: Description present validation
  if (!details.description || details.description.length < 20) {
    rejectionReasons.push("missing_or_short_description");
  }

  return {
    passed: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

// CHANGE: full job page se normalized details extract karne wala function
async function extractJobDetails(page: import("playwright").Page): Promise<FullJobDetails> {
  return await page.evaluate(() => {
    const bodyText = document.body.innerText;

    // CHANGE: Naukri ke actual description DOM container ko target karo
    const descriptionEl = document.querySelector(
      ".styles_JDC__dang-inner-html__h0K4t"
    );

    // CHANGE: yaha Naukri ke structured "other details" extract karo
    const details = Array.from(
      document.querySelectorAll(
        ".styles_other-details__oEN4O .styles_details__Y424J"
      )
    ).map((el) => {
      const label =
        el.querySelector("label")?.textContent?.trim().replace(/:$/, "") || "";

      const value =
        el.querySelector("span")?.textContent?.trim().replace(/,\s*$/, "") || "";

      return { label, value };
    });

    // CHANGE: label/value pairs ko lookup object mein convert karo
    const detailMap = Object.fromEntries(
      details.map(({ label, value }) => [label, value])
    );

    // CHANGE: Naukri ke Key Skills extract karo
    const keySkills = Array.from(
      document.querySelectorAll(".styles_key-skill__GIPn_ a span")
    )
      .map((el) => el.textContent?.trim())
      .filter((text): text is string => Boolean(text));

    // CHANGE: Naukri se exact "Posted:" text extract karo
    const postedStat = Array.from(
      document.querySelectorAll(".styles_jhc__stat__PgY67")
    ).find((el) => {
      const label = el.querySelector("label")?.textContent?.trim();
      return label === "Posted:";
    });

    // CHANGE: "3+ weeks ago" jaisa actual age text nikalo
    const postedAgeText =
      postedStat?.querySelector("span")?.textContent?.trim() ?? null;

    // CHANGE: posting age ko days mein normalize karo
    let postedDaysAgo: number | null = null;

    if (postedAgeText) {
      const text = postedAgeText.toLowerCase();

      if (text === "today") {
        postedDaysAgo = 0;
      } else {
        const daysMatch = text.match(/(\d+)\s+days?\s+ago/);
        const weekMatch = text.match(/(\d+)\+?\s+weeks?\s+ago/);

        if (daysMatch) {
          postedDaysAgo = Number(daysMatch[1]);
        } else if (weekMatch) {
          const weeks = Number(weekMatch[1]);

          // CHANGE: 2+ weeks = freshness filter fail
          if (weeks < 2) {
            postedDaysAgo = weeks * 7;
          }
        }
      }
    }

    return {
      // CHANGE: complete page text preserve karo
      rawText: bodyText,

      // CHANGE: clean description extract karo
      description: descriptionEl
        ? (descriptionEl.textContent || "").trim()
        : null,

      // CHANGE: structured Naukri fields
      role: detailMap["Role"] ?? null,
      industry: detailMap["Industry Type"] ?? null,
      department: detailMap["Department"] ?? null,
      employmentType: detailMap["Employment Type"] ?? null,
      roleCategory: detailMap["Role Category"] ?? null,

      // CHANGE: extracted key skills return karo
      keySkills,

      // CHANGE: normalized posting age return karo
      postedAgeText,
      postedDaysAgo,
    };
  });
}

// CHANGE: Single keyword search, extraction, and filtering workflow function
function getNextPageUrl(urlStr: string, nextPage: number): string {
  try {
    const url = new URL(urlStr);
    url.pathname = url.pathname.replace(/(?:-\d+)?$/, `-${nextPage}`);
    return url.toString();
  } catch (e) {
    return urlStr;
  }
}

async function searchKeyword(
  page: import("playwright").Page,
  keyword: string
): Promise<CombinedJob[]> {
  console.log(`\n=== ${keyword.toUpperCase()} ===`);

  await page.goto("https://www.naukri.com/jobs", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", {
    name: "Search jobs here",
  }).click();
  await page.waitForTimeout(1000);

  const jobTypeDropdown = page.locator("#jobType").locator("..");
  await jobTypeDropdown.click();
  await page.waitForTimeout(500);

  await page.getByText("Internship", { exact: true }).click();

  const keywordInput = page.getByPlaceholder(
    "Enter keyword / designation / companies"
  );
  await keywordInput.fill(keyword);

  const locationInput = page.getByPlaceholder("Enter location");
  await locationInput.fill("");

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForTimeout(3000);

  // CHANGE: Strictly select "Sort by: Date" filter after search
  try {
    const sortDropdown = page.locator('button, div, span').filter({ hasText: /^Sort by:/i }).first();
    await sortDropdown.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.getByText("Date", { exact: true }).click({ timeout: 5000 });
    await page.waitForTimeout(3000);
    console.log("Successfully applied 'Sort by: Date' filter on Naukri SRP.");
  } catch (err) {
    console.log("UI Sort click fallback: Applying sort=f URL parameter...");
    try {
      const url = new URL(page.url());
      url.searchParams.set("sort", "f");
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log("Could not apply date sort parameter.");
    }
  }

  console.log("Initial Search URL:", page.url());

  const allJobListings: any[] = [];
  let pageNumber = 1;
  const maxPagesToScan = 5;

  while (pageNumber <= maxPagesToScan) {
    try {
      await page.waitForSelector(".srp-jobtuple-wrapper", { timeout: 8000 });
    } catch (e) {
      console.log(`PAGE ${pageNumber} → 0 listings extracted (selector timeout)`);
      break;
    }

    const pageListings = await page.locator(".srp-jobtuple-wrapper").evaluateAll((cards) => {
      return cards.map((card) => {
        const titleEl = card.querySelector('a[href*="/job-listings-"]') as HTMLAnchorElement | null;
        const title = titleEl ? (titleEl.textContent || "").trim() : "";
        const href = titleEl ? titleEl.href : "";

        const companyEl = card.querySelector(".comp-name, .company-name") || card.querySelector("a[href*='-jobs-']");
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

    console.log(`PAGE ${pageNumber} → ${pageListings.length} listings extracted`);

    if (pageListings.length === 0) {
      break;
    }

    allJobListings.push(...pageListings);

    // Try navigating to next page by clicking page number on UI
    if (pageNumber < maxPagesToScan) {
      const nextPageNum = pageNumber + 1;
      let clicked = false;

      try {
        // Scroll down to reveal pagination bar
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);

        // Target exact page number link or Next button
        const pageBtn = page.getByRole("link", { name: String(nextPageNum), exact: true })
          .or(page.locator(`a:has-text("${nextPageNum}")`))
          .or(page.locator('a[class*="btn-secondary"]:has-text("Next"), a:has-text("Next"), button:has-text("Next")'))
          .first();

        if (await pageBtn.isVisible().catch(() => false)) {
          console.log(`Clicking Page ${nextPageNum} button on UI...`);
          await pageBtn.click().catch(() => {});
          await page.waitForTimeout(3500);
          clicked = true;
          pageNumber++;
        }
      } catch (err) {
        console.log(`UI page click attempt for Page ${nextPageNum} fell through.`);
      }

      if (!clicked) {
        // Fallback: Direct URL navigation if UI click was not available
        const currentUrl = page.url();
        const nextUrl = getNextPageUrl(currentUrl, pageNumber + 1);

        if (nextUrl !== currentUrl) {
          console.log(`Navigating to Page ${nextPageNum} URL fallback...`);
          pageNumber++;
          await page.goto(nextUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(3000);
        } else {
          break;
        }
      }
    } else {
      break;
    }
  }

  // Deduplicate all extracted listings by unique href before target selection
  const uniqueListingMap = new Map<string, any>();
  for (const item of allJobListings) {
    if (item.href) {
      if (!uniqueListingMap.has(item.href)) {
        uniqueListingMap.set(item.href, item);
      }
    }
  }
  const jobListings = Array.from(uniqueListingMap.values());

  const evaluatedListingJobs = jobListings.map((job) => {
    const reasons: string[] = [];

    if (job.rating === null) {
      reasons.push("rating_unknown");
    } else if (job.rating < 3.5) {
      reasons.push("rating_below_3.5");
    }

    if (job.reviews === null) {
      reasons.push("reviews_unknown");
    } else if (job.reviews < 50) {
      reasons.push("reviews_below_50");
    }

    if (job.stipend !== null && job.stipend <= 2000) {
      reasons.push("stipend_not_above_2000");
    }

    return {
      job,
      passed: reasons.length === 0,
      rejectionReasons: reasons,
    };
  });

  // CHANGE: rejection reasons ka aggregate count nikalo
  const rejectionCounts: Record<string, number> = {};

  for (const result of evaluatedListingJobs) {
    if (!result.passed) {
      for (const reason of result.rejectionReasons) {
        rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
      }
    }
  }

  console.log(
    `TOTAL EXTRACTED: ${jobListings.length} cards across ${pageNumber} page(s)`
  );
  console.log(
    `FILTER DIAGNOSTICS FOR "${keyword}":`,
    JSON.stringify(rejectionCounts, null, 2)
  );

  const qualifiedListingJobs = evaluatedListingJobs
    .filter((result) => result.passed)
    .map((result) => result.job);

  console.log(`Qualified listings count for "${keyword}": ${qualifiedListingJobs.length}`);

  const qualifiedCombinedJobs: CombinedJob[] = [];

  // Inspect up to 5 qualified jobs per keyword across all scanned pages, or top 5 candidates if none strictly passed card filters
  const targetJobs = qualifiedListingJobs.length > 0
    ? qualifiedListingJobs.slice(0, 5)
    : jobListings.slice(0, 5);

  for (const targetJob of targetJobs) {
    if (!targetJob.href) continue;

    console.log(`\nNavigating to full job page: ${targetJob.title} (${targetJob.href})`);
    await page.goto(targetJob.href, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const jobDetails = await extractJobDetails(page);
    const fullJobEvaluation = evaluateFullJobFilters(targetJob, jobDetails);

    if (fullJobEvaluation.passed) {
      console.log(`QUALIFIED JOB FOR "${keyword}": ${targetJob.title}`);
      qualifiedCombinedJobs.push({
        title: targetJob.title,
        company: targetJob.company,
        href: targetJob.href,
        rating: targetJob.rating,
        reviews: targetJob.reviews,
        stipend: targetJob.stipend,
        location: targetJob.location,
        experience: targetJob.experience,
        role: jobDetails.role,
        industry: jobDetails.industry,
        department: jobDetails.department,
        employmentType: jobDetails.employmentType,
        roleCategory: jobDetails.roleCategory,
        postedAgeText: jobDetails.postedAgeText,
        postedDaysAgo: jobDetails.postedDaysAgo,
        description: jobDetails.description,
        keySkills: jobDetails.keySkills,
        fullText: targetJob.fullText,
        matchedKeywords: [keyword],
        details: jobDetails,
      });
    } else {
      console.log(`REJECTED FULL JOB: ${targetJob.title} -> Reasons: ${fullJobEvaluation.rejectionReasons.join(", ")}`);

      // CHANGE: Early exit optimization when job age exceeds 14 days because results are sorted by Date (descending)
      if (jobDetails.postedDaysAgo !== null && jobDetails.postedDaysAgo > 14) {
        console.log(`[EARLY EXIT] Job "${targetJob.title}" is ${jobDetails.postedDaysAgo} days old (> 14 days). Since search is sorted by Date, all subsequent jobs will be older. Stopping further checks for "${keyword}".`);
        break;
      }
    }
  }

  return qualifiedCombinedJobs;
}

async function main() {
  const context = await chromium.launchPersistentContext("./browser-profile", {
    headless: false,
  });

  const page = await context.newPage();

  await page.goto("https://www.naukri.com/mnjuser/profile", {
    waitUntil: "domcontentloaded",
  });

  const keywords = [
    "Software Engineer",
    "Full Stack Developer",
    "MERN Developer",
  ];

  const allJobs: CombinedJob[] = [];

  for (const keyword of keywords) {
    const jobs = await searchKeyword(page, keyword);
    allJobs.push(...jobs);
  }

  // Deduplicate jobs by stable URL (href) and merge matchedKeywords
  const jobMap = new Map<string, CombinedJob>();

  for (const job of allJobs) {
    if (jobMap.has(job.href)) {
      const existing = jobMap.get(job.href)!;
      for (const kw of job.matchedKeywords) {
        if (!existing.matchedKeywords.includes(kw)) {
          existing.matchedKeywords.push(kw);
        }
      }
    } else {
      jobMap.set(job.href, { ...job });
    }
  }

  const uniqueJobs = Array.from(jobMap.values());

  // CHANGE: Delegate ranking to decoupled ranker module with Top-10 selection & evidence breakdown
  const finalRankedJobs = rankJobs(uniqueJobs, 10);

  console.log("\n=========================================================================================");
  console.log(`                          TOP JOBS (${finalRankedJobs.length} Found)`);
  console.log("=========================================================================================\n");

  if (finalRankedJobs.length === 0) {
    console.log("No jobs matched all hard filters (Rating >= 3.5, Reviews >= 50, Stipend > ₹2,000, Age <= 14 days).");
  } else {
    console.table(
      finalRankedJobs.map((j, idx) => ({
        Rank: idx + 1,
        Title: j.title,
        Company: j.company,
        Score: j.score,
        Stipend: j.stipend ? `₹${j.stipend.toLocaleString()}` : "N/A",
        "Days Ago": j.postedDaysAgo ?? "N/A",
        Keywords: j.matchedKeywords.join(", "),
        Link: j.href,
      }))
    );
  }

  console.log("\n=========================================================================================\n");

  await context.close();
}

main().catch(console.error);



