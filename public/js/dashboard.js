/* dashboard.js — home page data fetching and rendering */

/* ── DOM References ──────────────────────────────────────────── */
const recentList = document.getElementById('recent-posts-list');

/* ── Init ────────────────────────────────────────────────────── */
(async function init() {
  await window.scouthookAuthReady;
  loadRecentPosts();
  loadChecklist();
})();

/* ── Recent posts ────────────────────────────────────────────── */
async function loadRecentPosts() {
  try {
    const res  = await fetch('/api/posts/recent', { headers: apiHeaders() });
    if (!res.ok) throw new Error('No recent posts endpoint');
    const data = await res.json();

    const posts = data.posts || data;
    if (!Array.isArray(posts) || posts.length === 0) {
      showEmptyRecent();
      return;
    }

    renderPostRows(recentList, posts.slice(0, 5), 'recent');
  } catch {
    showEmptyRecent();
  }
}

function showEmptyRecent() {
  recentList.innerHTML = `
    <div class="card-empty-state">
      No posts yet — <a href="/generate.html?new=1">Generate your first post →</a>
    </div>`;
}

/* ── Onboarding checklist ────────────────────────────────────── */
async function loadChecklist() {
  // Skip entirely if user has already completed and dismissed the checklist
  if (localStorage.getItem('sh_checklist_done')) return;

  const section  = document.getElementById('onboarding-checklist');
  const barEl    = document.getElementById('checklist-bar');
  const textEl   = document.getElementById('checklist-progress-text');
  const itemsEl  = document.getElementById('checklist-items');
  if (!section || !barEl || !textEl || !itemsEl) return;

  try {
    const res  = await fetch('/api/checklist', { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    // If all done on this load, collapse immediately and remember
    if (data.all_done) {
      collapseChecklist(section);
      return;
    }

    // Personalise the hero banner
    const firstName = (data.display_name || '').split(' ')[0];
    if (firstName) {
      const heading    = document.querySelector('.hero-heading');
      const subheading = document.querySelector('.hero-subheading');
      if (heading)    heading.textContent    = `Welcome, ${firstName}. Your LinkedIn posting engine is ready.`;
      if (subheading) subheading.textContent = 'Your voice profile is set up. Start by publishing your first post.';
    }

    // Progress bar and counter
    const pct = Math.round((data.completed_count / data.total) * 100);
    barEl.style.width  = pct + '%';
    textEl.textContent = `${data.completed_count} of ${data.total} complete`;

    // Render items
    itemsEl.innerHTML = '';
    data.steps.forEach(step => {
      const li = document.createElement('li');
      li.className = 'checklist-item' + (step.done ? ' done' : '');

      const tickSvg = step.done
        ? `<svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true"><path d="M1 4.5L4 7.5L10 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : '';

      li.innerHTML = `
        <span class="checklist-tick" aria-hidden="true">${tickSvg}</span>
        <span class="checklist-label">${escHtml(step.label)}</span>
        ${!step.done ? `<a class="checklist-link" href="${escHtml(step.href)}">Go →</a>` : ''}
      `;
      itemsEl.appendChild(li);
    });

    // Show the section
    section.hidden = false;

  } catch {
    // Non-fatal — checklist is a progressive enhancement
  }
}

function collapseChecklist(section) {
  section.classList.add('collapsing');
  section.addEventListener('transitionend', () => {
    section.hidden = true;
    section.classList.remove('collapsing');
  }, { once: true });
  localStorage.setItem('sh_checklist_done', '1');
}

/* ── Render rows ─────────────────────────────────────────────── */
function renderPostRows(container, posts, type) {
  container.innerHTML = '';
  posts.forEach((post, index) => {
    const row = document.createElement('div');
    row.className = 'post-row';

    // Determine content text
    const text = post.content || post.post || '';
    const firstLine = text.split('\n')[0] || text;

    // Date string
    let dateStr = '';
    const dateField = type === 'scheduled' ? post.scheduled_for : (post.created_at || post.date);
    if (dateField) {
      dateStr = formatDate(dateField, type === 'scheduled');
    }

    // Score
    const score = post.quality_score !== undefined && post.quality_score !== null
      ? Math.round(post.quality_score)
      : null;
    const badgeClass = score !== null ? scoreClass(score) : 'none';
    const badgeText  = score !== null ? String(score) : '—';

    // Status
    const status     = post.status || (type === 'scheduled' ? 'scheduled' : 'draft');
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

    row.innerHTML = `
      <div class="post-row-left">
        <div class="post-row-title" title="${escHtml(firstLine)}">${escHtml(firstLine)}</div>
        <div class="post-row-date">${escHtml(dateStr)}</div>
      </div>
      <div class="post-row-right">
        <span class="score-badge ${badgeClass}" aria-label="Quality score: ${badgeText}">${badgeText}</span>
        <span class="status-pill ${status.toLowerCase()}">${escHtml(statusLabel)}</span>
      </div>`;

    container.appendChild(row);
  });
}

/* ── Helpers ─────────────────────────────────────────────────── */
function scoreClass(score) {
  if (score >= 75) return 'pass';
  if (score >= 50) return 'borderline';
  return 'fail';
}

function formatDate(isoString, includeTime) {
  try {
    const d = new Date(isoString);
    if (includeTime) {
      const days  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const day   = days[d.getDay()];
      const date  = d.getDate();
      const month = months[d.getMonth()];
      const hours = d.getHours();
      const mins  = String(d.getMinutes()).padStart(2, '0');
      const ampm  = hours >= 12 ? 'pm' : 'am';
      const h     = hours % 12 || 12;
      return `${day} ${date} ${month} · ${h}:${mins}${ampm}`;
    }
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
