document.addEventListener('DOMContentLoaded', () => {
  const roleDropdown = document.getElementById('roleDropdown');
  const customKeywordContainer = document.getElementById('customKeywordContainer');
  const customKeywords = document.getElementById('customKeywords');
  const searchForm = document.getElementById('searchForm');
  const startBtn = document.getElementById('startBtn');
  const terminalOutput = document.getElementById('terminalOutput');
  const globalStatus = document.getElementById('globalStatus');
  const logCountEl = document.getElementById('logCount');
  const jobsCountEl = document.getElementById('jobsCount');
  const noResultsState = document.getElementById('noResultsState');
  const jobsTableWrapper = document.getElementById('jobsTableWrapper');
  const jobsTableBody = document.getElementById('jobsTableBody');

  let pollInterval = null;

  // Toggle Custom Keywords input box when custom dropdown option is selected
  roleDropdown.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      customKeywordContainer.classList.remove('hidden');
      customKeywords.focus();
    } else {
      customKeywordContainer.classList.add('hidden');
    }
  });

  // Handle Form Submission
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    let selectedKeywords = [];
    const roleVal = roleDropdown.value;

    if (roleVal === 'preset_tech') {
      selectedKeywords = ['Software Engineer', 'Full Stack Developer', 'MERN Developer'];
    } else if (roleVal === 'custom') {
      const customVal = customKeywords.value.trim();
      if (!customVal) {
        alert('Please enter at least one keyword for custom search!');
        return;
      }
      selectedKeywords = customVal.split(',').map((k) => k.trim()).filter(Boolean);
    } else {
      selectedKeywords = [roleVal];
    }

    const payload = {
      keywords: selectedKeywords,
      jobType: document.getElementById('jobType').value,
      minRating: document.getElementById('minRating').value,
      minReviews: document.getElementById('minReviews').value,
      minStipend: document.getElementById('minStipend').value,
      maxDaysOld: document.getElementById('maxDaysOld').value,
      maxPages: document.getElementById('maxPages').value,
      headless: document.getElementById('headless').value === 'true',
    };

    setRunningState(true);
    appendLog('[System] Initiating job search with customized parameters...', 'highlight');

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start search');
      }

      startStatusPolling();
    } catch (err) {
      appendLog(`[Error] ${err.message}`, 'error');
      setRunningState(false);
    }
  });

  function startStatusPolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        // Update Logs Terminal
        if (Array.isArray(data.logs)) {
          renderLogs(data.logs);
        }

        // Check if finished
        if (!data.isRunning) {
          clearInterval(pollInterval);
          setRunningState(false);
          if (data.result && data.result.jobs) {
            renderResults(data.result.jobs);
          }
        }
      } catch (err) {
        console.error('Status polling error:', err);
      }
    }, 1500);
  }

  function setRunningState(running) {
    if (running) {
      startBtn.disabled = true;
      startBtn.innerHTML = `<span>⏳ Automation Running...</span>`;
      globalStatus.innerHTML = `<span class="dot running"></span> Searching Naukri...`;
    } else {
      startBtn.disabled = false;
      startBtn.innerHTML = `<span>🚀 Start Automated Job Search</span>`;
      globalStatus.innerHTML = `<span class="dot idle"></span> Ready`;
    }
  }

  function renderLogs(logs) {
    terminalOutput.innerHTML = '';
    logCountEl.innerText = `${logs.length} logs`;

    logs.forEach((log) => {
      const line = document.createElement('div');
      line.className = 'log-line';

      if (log.includes('✓ QUALIFIED')) line.classList.add('success');
      else if (log.includes('✗ Rejected') || log.includes('[ERROR]')) line.classList.add('error');
      else if (log.includes('=== KEYWORD')) line.classList.add('highlight');

      line.innerText = log;
      terminalOutput.appendChild(line);
    });

    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function renderResults(jobs) {
    jobsCountEl.innerText = jobs.length;

    if (!jobs || jobs.length === 0) {
      noResultsState.classList.remove('hidden');
      jobsTableWrapper.classList.add('hidden');
      noResultsState.innerHTML = `
        <div class="empty-icon">⚠️</div>
        <p>No jobs matched all your selected hard filters. Try lowering company rating, review, or stipend thresholds in the dropdowns above!</p>
      `;
      return;
    }

    noResultsState.classList.add('hidden');
    jobsTableWrapper.classList.remove('hidden');
    jobsTableBody.innerHTML = '';

    jobs.forEach((job, index) => {
      const tr = document.createElement('tr');

      const stipendFormatted = job.stipend ? `₹${job.stipend.toLocaleString()} / mo` : 'Not specified / Unpaid';
      const ratingFormatted = job.rating ? `⭐ ${job.rating}` : 'N/A';
      const reviewsFormatted = job.reviews ? `(${job.reviews} reviews)` : '';
      const daysAgoFormatted = job.postedDaysAgo !== null ? `${job.postedDaysAgo} day(s) ago` : (job.postedAgeText || 'N/A');

      tr.innerHTML = `
        <td><strong>#${index + 1}</strong></td>
        <td><span class="score-badge">${job.score || 0}</span></td>
        <td>
          <div class="job-title-cell">
            <strong>${escapeHtml(job.title)}</strong>
            <span class="job-company">${escapeHtml(job.company)} • ${escapeHtml(job.location || 'India')}</span>
          </div>
        </td>
        <td><strong style="color: var(--success);">${stipendFormatted}</strong></td>
        <td>${ratingFormatted} <span style="font-size: 11px; color: var(--text-muted);">${reviewsFormatted}</span></td>
        <td>${daysAgoFormatted}</td>
        <td>${escapeHtml(job.matchedKeywords.join(', '))}</td>
        <td>
          <a href="${job.href}" target="_blank" rel="noopener" class="btn-apply">View & Apply ↗</a>
        </td>
      `;

      jobsTableBody.appendChild(tr);
    });
  }

  function appendLog(text, className = '') {
    const line = document.createElement('div');
    line.className = `log-line ${className}`;
    line.innerText = text;
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m]));
  }
});
