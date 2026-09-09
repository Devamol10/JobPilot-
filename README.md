# JobPilot ⚡

Automated Naukri job search, filtering, and intelligent ranking engine with a real-time web dashboard.

JobPilot uses Playwright to scrape Naukri.com, applies hard filters (rating, reviews, stipend, freshness), and ranks qualified jobs using a weighted scoring algorithm — all controllable from a clean web UI.

---

## Features

- **Keyword-based search** — search by role (Software Engineer, Full Stack Developer, MERN Developer, etc.) or enter custom keywords
- **Opportunity type filter** — Job or Internship
- **Hard filters** — minimum company rating, minimum reviews, minimum stipend, job freshness
- **Multi-page scraping** — scan up to 10 pages per keyword with automatic pagination
- **Full job page inspection** — opens each qualified listing and extracts description, skills, posting date
- **Intelligent ranking** — weighted scoring across rating, reviews, stipend, freshness, and keyword coverage
- **Live automation console** — real-time terminal logs streamed to the browser
- **Anti-bot stealth** — uses real Chrome channel with automation flag bypass for headless mode

---

## Tech Stack

| Layer      | Technology                     |
|------------|--------------------------------|
| Frontend   | HTML, CSS, Vanilla JS          |
| Backend    | Node.js, Express, TypeScript   |
| Scraping   | Playwright (Chromium)          |
| Runtime    | tsx (TypeScript execution)     |

---

## Project Structure

```
jobpilot/
├── public/              # Frontend (served as static files)
│   ├── index.html       # Dashboard UI
│   ├── style.css        # Styles
│   └── app.js           # Client-side logic & API calls
├── src/
│   ├── server.ts        # Express API server
│   ├── browser_runner.ts # Web UI search engine (called by API)
│   ├── browser.ts       # Standalone CLI search engine
│   ├── ranker.ts        # Weighted ranking algorithm
│   └── test_scoring.ts  # Ranking unit test
├── package.json
├── Dockerfile           # Docker deployment (Playwright image)
├── .gitignore
└── .dockerignore
```

---

## Getting Started

### Prerequisites

- **Node.js** v18+ installed
- **Google Chrome** installed on your system (used via Playwright's `channel: "chrome"`)

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/jobpilot.git
cd jobpilot
npm install
```

### First-time Naukri Login

Before running automated searches, you need to log into Naukri once so the browser profile saves your session:

```bash
npx tsx src/browser.ts
```

This opens a visible Chrome window. Log into your Naukri account manually, then close the browser. Your session is saved in `browser-profile/` (git-ignored).

### Run the Web Dashboard

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Configure your search parameters and click **Start Job Search**.

---

## Deployment (Docker)

JobPilot includes a Dockerfile based on Microsoft's official Playwright image:

```bash
docker build -t jobpilot .
docker run -p 3000:3000 jobpilot
```

### Deploy to Render.com

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set Environment to **Docker**
5. Click **Create Web Service**

---

## API Endpoints

| Method | Endpoint       | Description                          |
|--------|----------------|--------------------------------------|
| GET    | `/api/status`  | Returns current search status & logs |
| POST   | `/api/search`  | Starts a new automated search run    |

### POST `/api/search` body

```json
{
  "keywords": ["Software Engineer", "Full Stack Developer"],
  "jobType": "fulltime",
  "minRating": 3.5,
  "minReviews": 50,
  "minStipend": 2000,
  "maxDaysOld": 14,
  "maxPages": 5,
  "headless": true
}
```

---

## License

MIT
