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

  // Poll Infrastructure Status (/api/status) for Canary & Circuit Breaker Health
  async function updateInfraStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.circuitBreaker && data.canaryHealth) {
        const breakerState = data.circuitBreaker.currentState;
        const canary = data.canaryHealth.status;
        if (breakerState === 'OPEN') {
          globalStatus.innerHTML = `<span class="dot error"></span> Circuit Breaker OPEN (Cooldown ${data.circuitBreaker.cooldownRemainingSeconds}s)`;
        } else if (canary === 'BLOCKED') {
          globalStatus.innerHTML = `<span class="dot error"></span> IP Blocked (Canary Alert)`;
        } else if (!data.isRunning) {
          globalStatus.innerHTML = `<span class="dot idle"></span> Ready (Breaker: ${breakerState})`;
        }
      }
    } catch (err) {}
  }
  setInterval(updateInfraStatus, 5000);
  updateInfraStatus();

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
    terminalOutput.innerHTML = '';
    appendLog('[System] Initiating job search with customized parameters...', 'highlight');

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      // Handle cache/blocked responses that come back immediately
      if (data.noFreshDataAvailable) {
        renderStalenessWarningUI(data.message || "Naukri temporarily unreachable, no recent results available — try again later.");
        renderLogs(data.logs || []);
        setRunningState(false);
        return;
      }

      if (data.status === 'completed' && data.result && Array.isArray(data.result.jobs)) {
        // Synchronous cached result
        renderLogs(data.result.logs || []);
        renderResults(data.result.jobs, data.result.rejectedJobs || [], data.result.logs || [], data.isCached, data.cacheAgeMinutes);
        setRunningState(false);
        const sourceLabel = data.isCached ? `cached (${data.cacheAgeMinutes} mins old)` : 'live';
        appendLog(`[System] Search completed: ${data.result.jobs.length} qualified job(s) ready [${sourceLabel}].`, 'success');
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || 'Failed to start search');
      }

      // Async search started — begin polling for live progress
      appendLog('[System] Search started in background. Polling for live progress...', 'highlight');
      startStatusPolling();

    } catch (err) {
      appendLog(`[Error] ${err.message}`, 'error');
      if (err.message.includes('blocked at IP level') || err.message.includes('STRUCTURAL BLOCK')) {
        renderStructuralBlockUI(err.message);
      }
      setRunningState(false);
    }
  });

  function startStatusPolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/search');
        const data = await res.json();

        if (Array.isArray(data.logs)) {
          renderLogs(data.logs);
        }

        if (!data.isRunning) {
          clearInterval(pollInterval);
          pollInterval = null;
          setRunningState(false);

          if (data.result && data.result.jobs) {
            renderResults(data.result.jobs, data.result.rejectedJobs || [], data.result.logs || data.logs || [], false, null);
            appendLog(`[System] Search completed: ${data.result.jobs.length} qualified job(s) ready [live].`, 'success');
          } else {
            // Check if logs contain errors
            const hasError = (data.logs || []).some(l => l.includes('[ERROR]') || l.includes('STRUCTURAL BLOCK'));
            if (hasError) {
              const blockLog = (data.logs || []).find(l => l.includes('blocked at IP level'));
              if (blockLog) {
                renderStructuralBlockUI(blockLog);
              }
            }
          }
        }
      } catch (err) {
        console.error('Search status polling error:', err);
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
      else if (log.includes('✗ Rejected') || log.includes('[ERROR]') || log.includes('STRUCTURAL BLOCK') || log.includes('CircuitBreaker')) line.classList.add('error');
      else if (log.includes('=== KEYWORD')) line.classList.add('highlight');
      else if (log.includes('[Pagination]') || log.includes('[API CAPTURE]')) line.classList.add('info');

      line.innerText = log;
      terminalOutput.appendChild(line);
    });

    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function renderResults(jobs, rejectedJobs = [], logs = [], isCached = false, cacheAgeMinutes = null) {
    jobsCountEl.innerText = jobs.length;

    const isIpBlocked = logs.some((l) => l.includes('STRUCTURAL BLOCK') || l.includes('blocked at IP level'));

    if (!jobs || jobs.length === 0) {
      noResultsState.classList.remove('hidden');
      jobsTableWrapper.classList.add('hidden');
      if (isIpBlocked) {
        renderStructuralBlockUI("naukri.com blocked at IP level — run client-side or use proxy");
      } else {
        noResultsState.innerHTML = `
          <div class="empty-icon">⚠️</div>
          <p>No jobs matched all your selected hard filters. Try lowering company rating, review, or stipend thresholds in the dropdowns above!</p>
        `;
      }
      // Still render rejected jobs if any
      if (rejectedJobs.length > 0) {
        renderRejectedJobs(rejectedJobs);
      }
      return;
    }

    noResultsState.classList.add('hidden');
    jobsTableWrapper.classList.remove('hidden');
    jobsTableBody.innerHTML = '';

    // Cache Banner Notice
    if (isCached) {
      const cacheRow = document.createElement('tr');
      cacheRow.innerHTML = `
        <td colspan="8" style="background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.3); padding: 10px 16px; color: #93c5fd; font-size: 13px; font-weight: 500; border-radius: 6px;">
          📦 <strong>Showing cached results from ${cacheAgeMinutes ?? 'few'} min(s) ago</strong> (Circuit Breaker active / IP protection enabled).
        </td>
      `;
      jobsTableBody.appendChild(cacheRow);
    }

    // Qualified Jobs Header
    const qualifiedHeader = document.createElement('tr');
    qualifiedHeader.innerHTML = `
      <td colspan="8" style="background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.25); padding: 10px 16px; color: #4ade80; font-size: 14px; font-weight: 600; border-radius: 6px;">
        ✅ Qualified Jobs (${jobs.length} found)
      </td>
    `;
    jobsTableBody.appendChild(qualifiedHeader);

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

    // Render Rejected Jobs below qualified
    if (rejectedJobs.length > 0) {
      renderRejectedJobs(rejectedJobs);
    }
  }

  function renderRejectedJobs(rejectedJobs) {
    // Remove existing rejected section if any
    const existing = document.getElementById('rejectedJobsSection');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.id = 'rejectedJobsSection';
    section.innerHTML = `
      <div style="margin-top: 24px; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 12px; overflow: hidden; background: rgba(239, 68, 68, 0.04);">
        <div style="padding: 14px 20px; background: rgba(239, 68, 68, 0.08); border-bottom: 1px solid rgba(239, 68, 68, 0.15); display: flex; align-items: center; justify-content: space-between; cursor: pointer;" onclick="this.parentElement.querySelector('.rejected-body').classList.toggle('hidden')">
          <span style="color: #f87171; font-weight: 600; font-size: 14px;">
            ❌ Rejected Jobs (${rejectedJobs.length}) — Click to expand
          </span>
          <span style="color: #f8717180; font-size: 12px;">These jobs were inspected but didn't meet your filter criteria</span>
        </div>
        <div class="rejected-body" style="max-height: 400px; overflow-y: auto;">
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: rgba(239, 68, 68, 0.06); border-bottom: 1px solid rgba(239, 68, 68, 0.12);">
                <th style="padding: 10px 14px; text-align: left; color: #f87171; font-size: 12px; font-weight: 600;">#</th>
                <th style="padding: 10px 14px; text-align: left; color: #f87171; font-size: 12px; font-weight: 600;">Job Title & Company</th>
                <th style="padding: 10px 14px; text-align: left; color: #f87171; font-size: 12px; font-weight: 600;">Stipend</th>
                <th style="padding: 10px 14px; text-align: left; color: #f87171; font-size: 12px; font-weight: 600;">Rating & Reviews</th>
                <th style="padding: 10px 14px; text-align: left; color: #f87171; font-size: 12px; font-weight: 600;">Posted</th>
                <th style="padding: 10px 14px; text-align: left; color: #f87171; font-size: 12px; font-weight: 600;">Rejection Reasons</th>
                <th style="padding: 10px 14px; text-align: left; color: #f87171; font-size: 12px; font-weight: 600;">Action</th>
              </tr>
            </thead>
            <tbody id="rejectedJobsBody"></tbody>
          </table>
        </div>
      </div>
    `;

    // Insert after the jobs table wrapper
    jobsTableWrapper.parentElement.appendChild(section);

    const tbody = document.getElementById('rejectedJobsBody');
    rejectedJobs.forEach((job, index) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid rgba(239, 68, 68, 0.08)';

      const stipendFormatted = job.stipend ? `₹${job.stipend.toLocaleString()} / mo` : (job.stipend === 0 ? 'Unpaid' : 'N/A');
      const ratingFormatted = job.rating ? `⭐ ${job.rating}` : 'N/A';
      const reviewsFormatted = job.reviews ? `(${job.reviews})` : '';
      const daysAgoFormatted = job.postedDaysAgo !== null ? `${job.postedDaysAgo}d ago` : (job.postedAgeText || 'N/A');

      const reasonBadges = job.reasons.map(r => {
        const label = formatReasonLabel(r);
        return `<span style="display: inline-block; padding: 2px 8px; margin: 2px; border-radius: 4px; font-size: 11px; font-weight: 500; background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.25);">${label}</span>`;
      }).join('');

      tr.innerHTML = `
        <td style="padding: 10px 14px; color: #94a3b8; font-size: 13px;">${index + 1}</td>
        <td style="padding: 10px 14px;">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <strong style="color: #e2e8f0; font-size: 13px;">${escapeHtml(job.title)}</strong>
            <span style="color: #64748b; font-size: 12px;">${escapeHtml(job.company)} • ${escapeHtml(job.location || 'India')}</span>
          </div>
        </td>
        <td style="padding: 10px 14px; color: #94a3b8; font-size: 13px;">${stipendFormatted}</td>
        <td style="padding: 10px 14px; color: #94a3b8; font-size: 13px;">${ratingFormatted} <span style="font-size: 11px;">${reviewsFormatted}</span></td>
        <td style="padding: 10px 14px; color: #94a3b8; font-size: 13px;">${daysAgoFormatted}</td>
        <td style="padding: 10px 14px;">${reasonBadges}</td>
        <td style="padding: 10px 14px;">
          <a href="${job.href}" target="_blank" rel="noopener" style="color: #64748b; text-decoration: none; font-size: 12px; padding: 4px 10px; border: 1px solid rgba(100, 116, 139, 0.3); border-radius: 6px; transition: all 0.2s;"
             onmouseover="this.style.color='#f87171'; this.style.borderColor='rgba(239,68,68,0.4)'"
             onmouseout="this.style.color='#64748b'; this.style.borderColor='rgba(100,116,139,0.3)'">
            View ↗
          </a>
        </td>
      `;

      tbody.appendChild(tr);
    });
  }

  function formatReasonLabel(reason) {
    const map = {
      'rating_below_3': 'Rating < 3.0',
      'rating_below_3.5': 'Rating < 3.5',
      'rating_unknown': 'No Rating',
      'reviews_below_25': 'Reviews < 25',
      'reviews_below_50': 'Reviews < 50',
      'reviews_unknown': 'No Reviews',
      'stipend_below_2000': 'Stipend < ₹2K',
      'stipend_below_5000': 'Stipend < ₹5K',
      'stipend_unpaid': 'Unpaid',
      'freshness_unknown': 'Age Unknown',
      'too_old': 'Too Old',
      'not_internship': 'Not Internship',
    };
    return map[reason] || reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function appendLog(text, className = '') {
    const line = document.createElement('div');
    line.className = `log-line ${className}`;
    line.innerText = text;
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function renderStructuralBlockUI(message) {
    noResultsState.classList.remove('hidden');
    jobsTableWrapper.classList.add('hidden');
    noResultsState.innerHTML = `
      <div class="empty-icon">🚫</div>
      <h3 style="color: #ef4444; margin: 8px 0 4px;">STRUCTURAL IP BLOCK DETECTED</h3>
      <p style="color: #f87171; font-size: 14px; max-width: 540px; margin: 0 auto 12px; line-height: 1.5;">
        Naukri.com is blocking automated browser requests at the IP level (Cloudflare anti-bot active). Transient retries will not recover from this IP block.
      </p>
      <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); padding: 10px 16px; borderRadius: 8px; font-size: 13px; color: #fca5a5; display: inline-block;">
        💡 <strong>Recommendation:</strong> Run JobPilot locally from your desktop browser environment or configure a residential proxy.
      </div>
    `;
  }

  function renderStalenessWarningUI(message) {
    noResultsState.classList.remove('hidden');
    jobsTableWrapper.classList.add('hidden');
    noResultsState.innerHTML = `
      <div class="empty-icon">⏳</div>
      <h3 style="color: #f59e0b; margin: 8px 0 4px;">TEMPORARILY UNAVAILABLE</h3>
      <p style="color: #fbbf24; font-size: 14px; max-width: 540px; margin: 0 auto 12px; line-height: 1.5;">
        ${escapeHtml(message)}
      </p>
      <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); padding: 10px 16px; borderRadius: 8px; font-size: 13px; color: #fde68a; display: inline-block;">
        💡 <strong>Note:</strong> Cached data older than 3 hours is hidden to ensure freshness. Please try again after the cooldown period.
      </div>
    `;
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
