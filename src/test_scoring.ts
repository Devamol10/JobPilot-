import { CombinedJob } from "./browser";
import { rankJobs } from "./ranker";

const testJobs: CombinedJob[] = [
  {
    title: "Senior Fullstack Intern",
    company: "Top Tech Corp",
    href: "https://naukri.com/job-listings-senior-fullstack-intern-top-tech-corp-12345",
    rating: 4.8,
    reviews: 5000,
    stipend: 45000,
    location: "Bengaluru",
    experience: "0-1 years",
    role: "Software Engineering",
    industry: "IT Services",
    department: "Engineering",
    employmentType: "Full Time",
    roleCategory: "Software Development",
    postedAgeText: "1 day ago",
    postedDaysAgo: 1,
    description: "Build scalable web applications with Node.js and React.",
    keySkills: ["React", "Node.js", "TypeScript"],
    fullText: "Full stack engineering position",
    matchedKeywords: ["Software Engineer", "Full Stack Developer"],
  },
  {
    title: "Backend Engineer Intern",
    company: "Mid Tier Software",
    href: "https://naukri.com/job-listings-backend-engineer-intern-mid-tier-67890",
    rating: 4.0,
    reviews: 250,
    stipend: 15000,
    location: "Remote",
    experience: "0 years",
    role: "Backend Developer",
    industry: "Software",
    department: "Engineering",
    employmentType: "Internship",
    roleCategory: "Software Development",
    postedAgeText: "5 days ago",
    postedDaysAgo: 5,
    description: "Develop APIs using Python and Django.",
    keySkills: ["Python", "Django", "SQL"],
    fullText: "Backend intern position",
    matchedKeywords: ["Software Engineer"],
  },
];

console.log("=== TESTING DECOUPLED RANKER MODULE (`ranker.ts`) ===\n");

const finalRankedJobs = rankJobs(testJobs, 10);

console.log("FINAL RANKED JOBS SCHEMA WITH EVIDENCE BREAKDOWN & TOP-N SELECTION:");
console.log(JSON.stringify(finalRankedJobs, null, 2));
