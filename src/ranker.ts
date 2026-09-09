import { CombinedJob } from "./browser";

// CHANGE: Clean Final Ranked Job Schema for downstream consumers & UI
export interface FinalRankedJob {
  jobId: string;
  title: string;
  company: string;
  score: number;
  scoreBreakdown: {
    ratingScore: number;
    reviewScore: number;
    stipendScore: number;
    freshnessScore: number;
    keywordScore: number;
  };
  matchedKeywords: string[];
  location: string;
  experience: string;
  stipend: number | null;
  postedAgeText: string | null;
  postedDaysAgo: number | null;
  keySkills: string[];
  description: string | null;
  href: string;
  details?: any;
}

// CHANGE: Deterministic Scoring & Evidence Breakdown Function
export function scoreAndBreakdownJob(job: CombinedJob): {
  score: number;
  breakdown: FinalRankedJob["scoreBreakdown"];
} {
  // Rating → higher is better (30% weight)
  const rawRatingScore =
    job.rating === null
      ? 0
      : Math.max(0, ((job.rating - 3.5) / (5 - 3.5)) * 100);
  const ratingScore = Math.round(rawRatingScore * 0.30 * 100) / 100;

  // Reviews → logarithmic score (20% weight)
  const rawReviewScore =
    job.reviews === null
      ? 0
      : Math.min(100, (Math.log10(job.reviews) / Math.log10(10000)) * 100);
  const reviewScore = Math.round(rawReviewScore * 0.20 * 100) / 100;

  // Stipend → cap influence at ₹50,000 (25% weight)
  const rawStipendScore =
    job.stipend === null
      ? 0
      : Math.min(100, (job.stipend / 50000) * 100);
  const stipendScore = Math.round(rawStipendScore * 0.25 * 100) / 100;

  // Freshness → newer is better (15% weight)
  const rawFreshnessScore =
    job.postedDaysAgo === null
      ? 0
      : Math.max(0, ((14 - job.postedDaysAgo) / 14) * 100);
  const freshnessScore = Math.round(rawFreshnessScore * 0.15 * 100) / 100;

  // Keyword matches → broader coverage (10% weight)
  const rawKeywordScore = Math.min(100, job.matchedKeywords.length * 50);
  const keywordScore = Math.round(rawKeywordScore * 0.10 * 100) / 100;

  const totalScore =
    ratingScore + reviewScore + stipendScore + freshnessScore + keywordScore;

  return {
    score: Math.round(totalScore * 100) / 100,
    breakdown: {
      ratingScore,
      reviewScore,
      stipendScore,
      freshnessScore,
      keywordScore,
    },
  };
}

// CHANGE: Generate stable jobId hash from href
function generateJobId(href: string): string {
  const match = href.match(/job-listings-([^?#]+)/);
  if (match) {
    return match[1];
  }
  return Buffer.from(href).toString("base64").replace(/=/g, "").slice(-16);
}

// CHANGE: Decoupled Ranker Engine Function with Top-N Selection
export function rankJobs(
  jobs: CombinedJob[],
  topN: number = 10
): FinalRankedJob[] {
  const rankedJobs: FinalRankedJob[] = jobs.map((job) => {
    const { score, breakdown } = scoreAndBreakdownJob(job);
    return {
      jobId: generateJobId(job.href),
      title: job.title,
      company: job.company,
      score,
      scoreBreakdown: breakdown,
      matchedKeywords: job.matchedKeywords,
      location: job.location,
      experience: job.experience,
      stipend: job.stipend,
      postedAgeText: job.postedAgeText,
      postedDaysAgo: job.postedDaysAgo,
      keySkills: job.keySkills,
      description: job.description,
      href: job.href,
      details: job.details,
    };
  });

  // Sort DESC by total score
  rankedJobs.sort((a, b) => b.score - a.score);

  // Return Top-N selections
  return rankedJobs.slice(0, topN);
}
