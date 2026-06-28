/* schedule.js — Editorial Agenda for schedule.html */

/* ── Helpers ────────────────────────────────────────────────── */

function toTitleCase(str) {
  if (!str) return '';
  return str.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function localDateKey(isoString) {
  var d = new Date(isoString);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function localDateKeyFromDate(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function formatTime(isoString) {
  var d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function todayMidnight() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDayParts(date) {
  var today    = todayMidnight();
  var tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  var isToday    = date.getTime() === today.getTime();
  var isTomorrow = date.getTime() === tomorrow.getTime();

  var weekday = date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  var num     = date.getDate();
  var month   = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
  var label   = isToday ? 'TODAY' : isTomorrow ? 'TOMORROW' : null;

  return { weekday: weekday, num: num, month: month, label: label };
}

/* ── 7-day range ────────────────────────────────────────────── */

function buildDayRange() {
  var days = [];
  var base = todayMidnight();
  for (var i = 0; i < 7; i++) {
    var d = new Date(base);
    d.setDate(base.getDate() + i);
    days.push(d);
  }
  return days;
}

/* ── Group posts by date ────────────────────────────────────── */

function groupByDate(posts) {
  var map = new Map();
  for (var i = 0; i < posts.length; i++) {
    var post = posts[i];
    var key = localDateKey(post.scheduled_for);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(post);
  }
  map.forEach(function (dayPosts) {
    dayPosts.sort(function (a, b) { return new Date(a.scheduled_for) - new Date(b.scheduled_for); });
  });
  return map;
}

/* ── Render ──────────────────────────────────────────────────── */

var MISSED_THRESHOLD_MS = 30 * 60 * 1000;

function isMissedPost(post) {
  if (post.status !== 'pending' && post.status !== 'processing') return false;
  var t = new Date(post.scheduled_for).getTime();
  return Number.isFinite(t) && (Date.now() - t) > MISSED_THRESHOLD_MS;
}

function renderStream(posts) {
  var stream = document.getElementById('schedule-stream');
  if (!stream) return;

  var list   = Array.isArray(posts) ? posts : [];
  var failed = list.filter(function (p) { return p.status === 'not_sent' || isMissedPost(p); });
  var active = list.filter(function (p) { return p.status !== 'not_sent' && !isMissedPost(p); });

  var days   = buildDayRange();
  var byDate = groupByDate(active);

  var windowKeys = new Set(days.map(localDateKeyFromDate));

  var weekHtml = days.map(function (date) {
    var key = localDateKeyFromDate(date);
    return renderDayGroup(date, byDate.get(key) || []);
  }).join('');

  var laterEntries = [];
  byDate.forEach(function (dayPosts, key) {
    if (!windowKeys.has(key)) laterEntries.push([key, dayPosts]);
  });
  laterEntries.sort(function (a, b) { return a[0].localeCompare(b[0]); });

  var laterHtml = '';
  if (laterEntries.length > 0) {
    var groups = laterEntries.map(function (entry) {
      var parts = entry[0].split('-').map(Number);
      var date = new Date(parts[0], parts[1] - 1, parts[2]);
      return renderDayGroup(date, entry[1]);
    }).join('');
    laterHtml = '<div class="sched-section-divider">'
      + '<span class="sched-section-label">Coming up</span>'
      + '</div>'
      + groups;
  }

  var failedHtml = '';
  if (failed.length > 0) {
    var rows = failed.map(renderFailedRow).join('');
    failedHtml = '<div class="sched-section-divider sched-section-divider--failed">'
      + '<span class="sched-section-label sched-section-label--failed">Failed to Publish</span>'
      + '</div>'
      + '<div class="sched-failed-list">' + rows + '</div>';
  }

  stream.innerHTML = weekHtml + laterHtml + failedHtml;
}

function renderDayGroup(date, posts) {
  var dp = formatDayParts(date);
  var isToday = dp.label === 'TODAY';

  var contentHtml = posts.length > 0
    ? '<div class="sched-events">' + posts.map(renderEventRow).join('') + '</div>'
    : '<p class="sched-empty-hint">No posts scheduled</p>';

  return '<div class="sched-day-group'
    + (isToday ? ' sched-day-group--today' : '')
    + (posts.length === 0 ? ' sched-day-group--empty' : '')
    + '">'
    + '<div class="sched-day-aside">'
    + '<span class="sched-dp-wday">' + (dp.label || dp.weekday) + '</span>'
    + '<span class="sched-dp-num">' + dp.num + '</span>'
    + '<span class="sched-dp-month">' + dp.month + '</span>'
    + '</div>'
    + '<div class="sched-day-content">'
    + contentHtml
    + '</div>'
    + '</div>';
}

function renderEventRow(post) {
  var time      = formatTime(post.scheduled_for);
  var archetype = toTitleCase(post.format_slug);
  var lines     = (post.content || '').trim().split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var hook      = escHtml(lines[0] || '');
  var second    = escHtml(lines[1] || '');

  var editHref = post.post_id
    ? '/editor/' + encodeURIComponent(post.post_id)
    : null;

  var tag    = editHref ? 'a href="' + escHtml(editHref) + '"' : 'div';
  var endTag = editHref ? 'a' : 'div';

  return '<' + tag + ' class="sched-event" data-id="' + post.id + '">'
    + '<div class="sched-evt-time-badge">' + time + '</div>'
    + '<div class="sched-evt-body">'
    + '<div class="sched-evt-badges">'
    + (archetype ? '<span class="sched-archetype-badge">' + escHtml(archetype) + '</span>' : '')
    + (post.funnel_type ? '<span class="funnel-badge ' + escHtml(post.funnel_type) + '">' + escHtml(post.funnel_type) + '</span>' : '')
    + '</div>'
    + '<p class="sched-evt-hook">' + hook + '</p>'
    + (second ? '<p class="sched-evt-second">' + second + '</p>' : '')
    + '<span class="sched-action-edit">Edit &rarr;</span>'
    + '</div>'
    + '</' + endTag + '>';
}

function renderFailedRow(post) {
  var lines  = (post.content || '').trim().split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  var hook   = escHtml(lines[0] || '');
  var missed = isMissedPost(post);
  var when   = post.scheduled_for
    ? new Date(post.scheduled_for).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  var errorMap = {
    reconnect_required: 'LinkedIn connection expired',
    not_connected: 'LinkedIn not connected',
    rate_limit_exceeded: 'Rate limit exceeded',
    invalid_image_url: 'Image could not be accessed',
    invalid_carousel_pdf_url: 'Carousel PDF could not be accessed',
    linkedin_document_processing_failed: 'LinkedIn rejected the carousel',
    linkedin_document_not_ready: 'LinkedIn timed out on carousel',
    stuck_processing_timeout: 'Worker timed out',
    scheduled_payload_mismatch: 'Post content was modified after scheduling',
    linkedin_api_version_error: 'LinkedIn API version mismatch — contact support',
  };
  var reason = missed
    ? 'Missed scheduled time'
    : (errorMap[post.error_message] || post.error_message || 'Unknown error');

  var editHref = post.post_id ? '/editor/' + encodeURIComponent(post.post_id) : null;

  var actionsHtml;
  if (post.status === 'not_sent') {
    actionsHtml = '<div class="sched-failed-actions">'
      + '<button class="sched-btn sched-btn--reschedule-toggle" data-id="' + post.id + '">Reschedule</button>'
      + '<button class="sched-btn sched-btn--publish-now" data-id="' + post.id + '">Publish now</button>'
      + (editHref ? '<a href="' + escHtml(editHref) + '" class="sched-btn sched-btn--edit">Edit &rarr;</a>' : '')
      + '<button class="sched-btn sched-btn--dismiss" data-id="' + post.id + '">Dismiss</button>'
      + '</div>'
      + '<div class="sched-reschedule-panel" id="reschedule-panel-' + post.id + '" style="display:none">'
      + '<input type="datetime-local" class="sched-reschedule-input" id="reschedule-dt-' + post.id + '">'
      + '<button class="sched-btn sched-btn--confirm-reschedule" data-id="' + post.id + '">Confirm reschedule</button>'
      + '</div>';
  } else {
    actionsHtml = '<div class="sched-failed-actions">'
      + (editHref ? '<a href="' + escHtml(editHref) + '" class="sched-btn sched-btn--edit">Edit &rarr;</a>' : '')
      + '<span class="sched-failed-recovering">Recovering&hellip;</span>'
      + '</div>';
  }

  return '<div class="sched-failed-row" data-id="' + post.id + '">'
    + '<div class="sched-failed-meta">'
    + '<span class="sched-failed-badge">Failed to Publish</span>'
    + (when ? '<span class="sched-failed-when">Scheduled for ' + escHtml(when) + '</span>' : '')
    + '</div>'
    + '<p class="sched-failed-hook">' + hook + '</p>'
    + '<p class="sched-failed-reason">' + escHtml(reason) + '</p>'
    + actionsHtml
    + '</div>';
}

/* ── LinkedIn status ────────────────────────────────────────── */

function buildLinkedInChip(name, photoUrl) {
  var initials = name
    ? name.split(' ').map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase()
    : '??';
  var avatarHtml = photoUrl
    ? '<img class="nav-linkedin-avatar" src="' + escHtml(photoUrl) + '" alt="' + escHtml(name || 'LinkedIn') + '">'
    : '<div class="nav-linkedin-initials">' + initials + '</div>';
  var nameHtml = name ? '<span class="nav-linkedin-name">' + escHtml(name) + '</span>' : '';
  return '<div class="nav-linkedin-connected">' + avatarHtml + nameHtml + '</div>';
}

function checkLinkedInStatus() {
  var connectBtn = document.getElementById('linkedin-connect-btn');
  if (connectBtn) {
    connectBtn.href = '/api/linkedin/connect?_uid=' + encodeURIComponent(getUserId()) + '&_tid=' + encodeURIComponent(getTenantId());
  }
  fetch('/api/linkedin/status', { headers: apiHeaders() })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var area = document.getElementById('nav-linkedin-area');
      if (!area) return;
      if (data.connected) {
        area.innerHTML = buildLinkedInChip(data.name, data.photo_url);
      }
    })
    .catch(function () { /* non-fatal */ });
}

/* ── Boot ────────────────────────────────────────────────────── */

function reloadStream() {
  return cachedFetch('/api/linkedin/scheduled', { headers: apiHeaders() }, 60000)
    .then(function (data) {
      renderStream(data.ok && Array.isArray(data.posts) ? data.posts : []);
    })
    .catch(function () {
      renderStream([]);
    });
}

function init() {
  checkLinkedInStatus();

  reloadStream().then(function () {
    var stream = document.getElementById('schedule-stream');
    if (!stream) return;

    stream.addEventListener('click', function (e) {
      var dismissBtn  = e.target.closest('.sched-btn--dismiss');
      var toggleBtn   = e.target.closest('.sched-btn--reschedule-toggle');
      var confirmBtn  = e.target.closest('.sched-btn--confirm-reschedule');
      var nowBtn      = e.target.closest('.sched-btn--publish-now');

      if (dismissBtn) {
        var id = dismissBtn.dataset.id;
        fetch('/api/linkedin/scheduled/' + id + '/dismiss', {
          method: 'DELETE', headers: apiHeaders(),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              cachedFetch.bust('/api/linkedin/scheduled');
              var row = stream.querySelector('.sched-failed-row[data-id="' + id + '"]');
              if (row) row.remove();
            } else {
              alert('Could not dismiss: ' + data.error);
            }
          })
          .catch(function () { alert('Dismiss failed — please try again.'); });
      }

      if (toggleBtn) {
        var tid    = toggleBtn.dataset.id;
        var panel = document.getElementById('reschedule-panel-' + tid);
        if (panel) {
          var opening = panel.style.display === 'none';
          panel.style.display = opening ? '' : 'none';
          if (opening) {
            var dt = document.getElementById('reschedule-dt-' + tid);
            if (dt && !dt.value) {
              var d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
              dt.value = d.toISOString().slice(0, 16);
            }
          }
        }
      }

      if (confirmBtn) {
        var cid = confirmBtn.dataset.id;
        var dtEl = document.getElementById('reschedule-dt-' + cid);
        if (!dtEl || !dtEl.value) { alert('Please pick a date and time.'); return; }
        var scheduled_for = new Date(dtEl.value).toISOString();
        fetch('/api/linkedin/scheduled/' + cid + '/reschedule', {
          method: 'POST',
          headers: Object.assign({}, apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ scheduled_for: scheduled_for }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              cachedFetch.bust('/api/linkedin/scheduled');
              reloadStream();
            } else {
              var msgs = {
                scheduled_for_too_soon: 'Please pick a time at least 5 minutes in the future.',
                scheduled_for_too_far:  'Please pick a time within the next 30 days.',
                scheduling_unavailable: 'Scheduler is unavailable — try again shortly.',
              };
              alert(msgs[data.error] || 'Could not reschedule: ' + data.error);
            }
          })
          .catch(function () { alert('Reschedule failed — please try again.'); });
      }

      if (nowBtn) {
        var nid = nowBtn.dataset.id;
        if (!confirm('Publish this post to LinkedIn right now?')) return;
        fetch('/api/linkedin/scheduled/' + nid + '/reschedule', {
          method: 'POST',
          headers: Object.assign({}, apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ scheduled_for: null }),
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.ok) {
              cachedFetch.bust('/api/linkedin/scheduled');
              reloadStream();
            } else {
              alert('Could not publish: ' + data.error);
            }
          })
          .catch(function () { alert('Publish failed — please try again.'); });
      }
    });
  });
}

window.__pageInit = init;
window.__pageCleanup = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
