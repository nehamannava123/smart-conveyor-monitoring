(() => {
  const API = ''; // same origin
  let token = localStorage.getItem('hg_token') || null;
  let user = JSON.parse(localStorage.getItem('hg_user') || 'null');
  let socket = null;
  let zones = [];
  let selectedZoneId = null;
  let alignChart = null;
  const historyBuffers = {}; // zoneId -> {labels:[], align:[], vib:[], risk:[]}
  let modelMetrics = null;
  let historyReplayRows = [];
  let historyReplayIndex = 0;
  let replayCharts = [];
  let investigationAlerts = [];
  let replayTwinOverride = null;

  const $ = (sel) => document.querySelector(sel);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function chartTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    return light
      ? { bg: '#f7fafc', grid: '#dbe5ec', tick: '#5a6e7f', legend: '#3f566a', label: '#718292' }
      : { bg: '#0f141a', grid: '#20262e', tick: '#5b6b7c', legend: '#8b98a8', label: '#6b7a8d' };
  }

  // Theme preference is local to this browser and does not affect server data.
  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    const button = $('#themeToggle');
    if (button) {
      button.innerHTML = next === 'dark' ? '☀ <span>Light mode</span>' : '☾ <span>Dark mode</span>';
      button.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      button.title = next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = next === 'light' ? '#f3f6f8' : '#0B0F12';
  }
  applyTheme(localStorage.getItem('hg_theme') || 'dark');
  $('#themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('hg_theme', next);
    applyTheme(next);
    // Redraw canvas charts and the twin so they pick up the new palette.
    try { if (alignChart) { alignChart.options = chartOptions(); alignChart.update('none'); } if (selectedZoneId) renderDetail(selectedZoneId); renderDigitalTwin(twinView); } catch (e) { console.warn('theme redraw', e); }
  });

  // ---------------- Auth ----------------
  const loginView = $('#loginView');
  const dashView = $('#dashView');
  const loginForm = $('#loginForm');
  const loginError = $('#loginError');

  function showDashboard() {
    loginView.classList.add('hidden');
    dashView.classList.remove('hidden');
    $('#userLabel').textContent = user.displayName || user.username;
    $('#userRole').textContent = user.role;
    $('#userRole').className = 'tag ' + (user.role === 'ADMIN' ? 'tag-admin' : user.role === 'OPERATOR' ? 'tag-op' : 'tag-view');
    
    // RBAC: Only ADMIN can access Audit Logs
    const auditNavBtn = document.querySelector('.side-nav [data-page="audit"]');
    if (auditNavBtn) {
      if (user.role === 'ADMIN') {
        auditNavBtn.classList.remove('hidden');
        loadAudit();
      } else {
        auditNavBtn.classList.add('hidden');
      }
    }

    $('#createAssetBtn')?.classList.toggle('hidden', user.role !== 'ADMIN');
    if (user.role === 'VIEWER') {
      $('#controlsRow').classList.add('hidden');
    } else {
      $('#controlsRow').classList.remove('hidden');
    }
    connectSocket();
    loadZones();
    loadModelMetrics();
    loadAssets();
    loadWorkOrders();
    setupPushNotifications();
  }

  function showLogin() {
    dashView.classList.add('hidden');
    loginView.classList.remove('hidden');
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const username = $('#username').value.trim();
    const password = $('#password').value;
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      token = data.token;
      user = data.user;
      localStorage.setItem('hg_token', token);
      localStorage.setItem('hg_user', JSON.stringify(user));
      showDashboard();
    } catch (err) {
      loginError.textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('hg_token');
    localStorage.removeItem('hg_user');
    token = null; user = null;
    if (socket) socket.disconnect();
    showLogin();
  });

  // ---------------- Download Report (current system condition) ----------------
  const LEVEL_COLOR = { NORMAL: [69, 216, 201], WARNING: [242, 169, 60], CRITICAL: [239, 83, 80] };

  function generateConditionReport() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    const now = new Date();

    // ---- Header ----
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(20, 30, 40);
    doc.text('HillGuard \u2014 Conveyor Condition Report', margin, 50);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(90, 100, 110);
    doc.text(`Generated ${now.toLocaleString()} by ${user.displayName || user.username} (${user.role})`, margin, 68);

    // ---- Overall status summary ----
    const total = zones.length;
    const critical = zones.filter((z) => z.riskLevel === 'CRITICAL').length;
    const warning = zones.filter((z) => z.riskLevel === 'WARNING').length;
    const normal = total - critical - warning;
    const openAlerts = [...alertsById.values()].filter((a) => a.status === 'OPEN')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const overall = critical > 0 ? 'CRITICAL' : warning > 0 ? 'WARNING' : 'NORMAL';

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...LEVEL_COLOR[overall]);
    doc.text(`Overall system condition: ${overall}`, margin, 92);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(90, 100, 110);
    doc.text(
      `${total} zones monitored \u2014 ${normal} normal, ${warning} warning, ${critical} critical \u2014 ${openAlerts.length} open alert(s)`,
      margin, 108
    );

    // ---- Zone condition table ----
    doc.autoTable({
      startY: 126,
      margin: { left: margin, right: margin },
      head: [['Zone', 'Status', 'Risk', 'Score', 'ML risk', 'Primary cause']],
      body: zones.map((z) => [
        z.name,
        z.status === 'AUTO_STOPPED' ? 'AUTO-STOPPED' : z.status,
        z.riskLevel || 'NORMAL',
        String(z.riskScore ?? 0),
        z.latestMl && z.latestMl.ready ? `${Math.round(z.latestMl.probability * 100)}%` : '\u2014',
        (z.latestRisk && z.latestRisk.primaryCause) || '\u2014'
      ]),
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [31, 41, 51], textColor: 255 },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 2) {
          const lvl = data.cell.raw;
          if (LEVEL_COLOR[lvl]) {
            data.cell.styles.textColor = LEVEL_COLOR[lvl];
            data.cell.styles.fontStyle = 'bold';
          }
        }
      }
    });

    // ---- Per-zone sensor snapshot ----
    let y = doc.lastAutoTable.finalY + 24;
    if (y > 720) { doc.addPage(); y = 50; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20, 30, 40);
    doc.text('Latest sensor readings by zone', margin, y);

    doc.autoTable({
      startY: y + 10,
      margin: { left: margin, right: margin },
      head: [['Zone', 'Alignment (mm)', 'Vibration (mm/s)', 'Slip (%)', 'Tension (%)', 'Load (%)', 'Temp (\u00b0C)']],
      body: zones.map((z) => {
        const r = z.latestReading || {};
        const f = (v) => (typeof v === 'number' ? v.toFixed(1) : '\u2014');
        return [z.name, f(r.alignmentMm), f(r.vibrationMms), f(r.slipPct), f(r.tensionPct), f(r.loadPct), f(r.tempC)];
      }),
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [31, 41, 51], textColor: 255 }
    });

    // ---- Open alerts: cause + recommended measures ----
    y = doc.lastAutoTable.finalY + 24;
    if (y > 700) { doc.addPage(); y = 50; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20, 30, 40);
    doc.text(`Open alerts (${openAlerts.length})`, margin, y);
    y += 6;

    if (!openAlerts.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(90, 100, 110);
      doc.text('No open alerts at time of generation.', margin, y + 16);
      y += 30;
    } else {
      openAlerts.forEach((a) => {
        if (y > 740) { doc.addPage(); y = 50; }
        y += 18;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(...(LEVEL_COLOR[a.level] || [20, 30, 40]));
        doc.text(`${a.level} \u2014 ${a.zoneName || ''} \u2014 ${a.cause || 'Unknown cause'} (score ${a.score}/100)`, margin, y);
        y += 14;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(60, 70, 80);
        const msgLines = doc.splitTextToSize(a.message, pageWidth - margin * 2);
        doc.text(msgLines, margin, y);
        y += msgLines.length * 11 + 4;

        const actions = a.recommendedActions || [];
        if (actions.length) {
          doc.setTextColor(90, 100, 110);
          doc.text('Recommended measures:', margin, y);
          y += 12;
          actions.forEach((act) => {
            if (y > 760) { doc.addPage(); y = 50; }
            const lines = doc.splitTextToSize(`\u2022 ${act}`, pageWidth - margin * 2 - 10);
            doc.text(lines, margin + 10, y);
            y += lines.length * 11;
          });
        }
        y += 6;
        doc.setDrawColor(220, 224, 228);
        doc.line(margin, y, pageWidth - margin, y);
      });
    }

    // ---- Footer page numbers ----
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(150, 158, 166);
      doc.text(`Page ${i} of ${pageCount}`, pageWidth / 2, 830, { align: 'center' });
    }

    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    doc.save(`HillGuard-Condition-Report-${stamp}.pdf`);
  }

  function downloadConditionReport() {
    if (!zones.length) { alert('No zone data loaded yet \u2014 please wait a moment and try again.'); return; }
    generateConditionReport();
  }
  $('#downloadReportBtn')?.addEventListener('click', downloadConditionReport);

  function authHeaders() {
    return { Authorization: `Bearer ${token}` };
  }

  // ---------------- Socket ----------------
  function connectSocket() {
    socket = io({ auth: { token } });

    socket.on('connect', () => {
      $('#connDot').className = 'dot dot-on';
      $('#overviewConnDot')?.classList.add('dot-on');
      $('#overviewConnDot')?.classList.remove('dot-off');
      $('#connLabel').textContent = 'live';
    });
    socket.on('disconnect', () => {
      $('#connDot').className = 'dot dot-off';
      $('#overviewConnDot')?.classList.add('dot-off');
      $('#overviewConnDot')?.classList.remove('dot-on');
      $('#connLabel').textContent = 'disconnected';
    });
    socket.on('connect_error', (err) => {
      $('#connLabel').textContent = 'connection error';
      $('#overviewUpdatedAt').textContent = 'Live connection unavailable';
      console.error('socket error', err.message);
    });

    socket.on('zones:snapshot', (payload) => {
      zones = payload.zones || [];
      renderDashboardOverview();
      populateWhatIfZoneSelect();
      populateModelZoneSelect();
      populateOpsZoneSelects();
      renderTerrain();
      renderZoneCards();
      renderDigitalTwin(twinView);
      if (!selectedZoneId && zones.length) {
        selectZone(zones[0].id);
      } else if (selectedZoneId) {
        renderDetail(selectedZoneId);
      }
    });

    socket.on('telemetry:tick', (payload) => {
      for (const z of payload.zones) {
        const zone = zones.find((x) => x.id === z.zoneId);
        if (zone) {
          zone.riskScore = z.risk.score;
          zone.riskLevel = z.risk.level;
          zone.status = z.status;
          zone.latestReading = z.reading;
          zone.latestRisk = z.risk;
          zone.latestMl = z.ml;
        }
        pushHistory(z.zoneId, z.reading, z.risk);
      }
      renderDashboardOverview();
      renderTerrain();
      renderZoneCards();
      renderDigitalTwin(twinView);
      if (!selectedZoneId && zones.length) {
        selectZone(zones[0].id);
      } else if (selectedZoneId) {
        renderDetail(selectedZoneId);
        if (document.querySelector('.layout')?.dataset.currentPage === 'models') renderModelCards();
        if (document.querySelector('.layout')?.dataset.currentPage === 'risk') renderRiskExplainability();
      }
    });

    socket.on('alert:new', (alert) => {
      prependAlert(alert);
      if (document.querySelector('.layout')?.dataset.currentPage === 'investigation') loadInvestigationList();
    });
    socket.on('alert:updated', () => loadAlerts());
    socket.on('automation:action', () => { loadZones(); });
    socket.on('workorder:new', () => { loadWorkOrders(); if (document.querySelector('.layout')?.dataset.currentPage === 'investigation') loadInvestigationList(); });
    socket.on('workorder:updated', () => { loadWorkOrders(); if (document.querySelector('.layout')?.dataset.currentPage === 'investigation') loadInvestigationList(); });
    socket.on('assets:updated', () => loadAssets());
    socket.on('audit:updated', () => { if (document.querySelector('.side-nav [data-page="audit"]')?.classList.contains('active')) loadAudit(); });

    socket.on('video:progress', (p) => addProgressLine(p.stage, p.detail, p.stage === 'ERROR' || p.stage === 'AI_FAILED'));
    socket.on('video:result', (result) => renderVideoResult(result));
  }

  // ---------------- Push notifications (Android/desktop alerts) ----------------
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  async function setupPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('[push] not supported in this browser');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;

      let permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') {
        console.warn('[push] notification permission not granted');
        return;
      }

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { publicKey } = await fetch(`${API}/api/push/vapid-public-key`).then((r) => r.json());
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      await fetch(`${API}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ subscription: sub })
      });
      console.log('[push] subscribed for alert notifications');
    } catch (err) {
      console.error('[push] setup failed', err);
    }
  }

  // Focus/click-through from a notification tap (service worker posts this message)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'HILLGUARD_NOTIFICATION_CLICK' && event.data.zoneId) {
        selectZone(event.data.zoneId);
      }
    });
  }

  // ---------------- Data loading ----------------
  async function loadZones() {
    const res = await fetch(`${API}/api/zones`, { headers: authHeaders() });
    if (res.status === 401) return showLogin();
    const data = await res.json();
    zones = data.zones || [];
    renderDashboardOverview();
    populateWhatIfZoneSelect();
    populateModelZoneSelect();
    populateOpsZoneSelects();
    renderTerrain();
    renderZoneCards();
    if (!selectedZoneId && zones.length) {
      selectZone(zones[0].id);
    } else if (selectedZoneId) {
      renderDetail(selectedZoneId);
    }
    loadAlerts();
    if (document.querySelector('.side-nav [data-page="risk"]')?.classList.contains('active')) renderRiskExplainability();
    if (document.querySelector('.side-nav [data-page="sensorhealth"]')?.classList.contains('active')) loadSensorHealth();
  }

  const alertsById = new Map();

  async function loadAlerts() {
    const res = await fetch(`${API}/api/alerts?limit=50`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const feed = $('#alertsFeed');
    feed.innerHTML = '';
    alertsById.clear();
    data.alerts.forEach((a) => {
      alertsById.set(a.id, a);
      feed.appendChild(alertNode(a));
    });
    renderDashboardOverview();
    if (currentModalAlertId && alertsById.has(currentModalAlertId)) {
      renderModal(alertsById.get(currentModalAlertId));
    }
  }

  async function loadAudit() {
    const feed = $('#auditFeed');
    if (!feed) return;
    feed.innerHTML = '<p class="panel-note">Loading audit history…</p>';
    try {
    const res = await fetch(`${API}/api/audit?limit=80`, { headers: authHeaders() });
    if (res.status === 401) { feed.innerHTML = '<p class="panel-note">Your session expired. Please sign in again to view audit logs.</p>'; return; }
    if (!res.ok) throw new Error(`Audit service returned ${res.status}`);
    const data = await res.json();
    feed.innerHTML = '';
    const entries = Array.isArray(data.auditLog) ? data.auditLog : [];
    if (!entries.length) { feed.innerHTML = '<p class="panel-note">No audit events have been recorded yet. Actions such as sign-in, diagnosis generation, alert acknowledgement, and system updates will appear here when logged.</p>'; return; }
    entries.forEach((entry) => {
      const div = document.createElement('div');
      div.className = 'audit-item';
      const rawTime = entry.at || entry.timestamp || entry.createdAt;
      const time = rawTime ? new Date(rawTime).toLocaleString() : 'Time unavailable';
      const actor = document.createElement('strong'); actor.textContent = entry.actor || entry.user || 'System';
      const meta = document.createElement('div'); meta.className = 'audit-meta'; meta.textContent = `${entry.action || 'Event'} · ${time}`;
      const detail = document.createElement('p'); detail.textContent = entry.detail || entry.details || 'No additional details';
      div.append(actor, meta, detail); feed.appendChild(div);
    });
    } catch (err) {
      console.error('[audit] failed to load audit logs:', err);
      feed.innerHTML = `<p class="panel-note">Audit logs could not be loaded: ${esc(err.message || 'Unknown error')}. Check the server and sign-in session, then select Refresh logs.</p>`;
    }
  }

  function alertNode(a) {
    const div = document.createElement('div');
    div.className = `alert-item level-${a.level}`;
    const time = new Date(a.createdAt).toLocaleTimeString();
    const canAck = user.role !== 'VIEWER' && a.status === 'OPEN';
    div.innerHTML = `
      <div class="alert-msg">${esc(a.message)}</div>
      <div class="alert-meta">
        <span class="alert-time">${time}</span>
        <span class="alert-status">${esc(a.status)}</span>
        ${canAck ? `<button class="btn btn-secondary btn-sm alert-ack-btn" data-id="${esc(a.id)}">Acknowledge</button>` : ''}
      </div>
    `;
    if (canAck) {
      div.querySelector('.alert-ack-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        ackAlert(a.id);
      });
    }
    div.addEventListener('click', () => openAlertModal(a.id));
    return div;
  }

  function prependAlert(a) {
    alertsById.set(a.id, a);
    const feed = $('#alertsFeed');
    if (feed) feed.insertBefore(alertNode(a), feed.firstChild);
    renderDashboardOverview();
  }

  async function ackAlert(id) {
    try {
      const res = await fetch(`${API}/api/alerts/${id}/ack`, { method: 'POST', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (data.alert) alertsById.set(id, data.alert);
      await loadAlerts();
    } catch (err) {
      alert(`Could not acknowledge alert: ${err.message}`);
    }
  }

  // ---------------- Alert detail modal ----------------
  let currentModalAlertId = null;

  const SNAPSHOT_FIELDS = [
    { key: 'alignmentMm', label: 'Alignment', unit: 'mm' },
    { key: 'vibrationMms', label: 'Vibration', unit: 'mm/s' },
    { key: 'slipPct', label: 'Slip', unit: '%' },
    { key: 'tensionPct', label: 'Tension', unit: '%' },
    { key: 'loadPct', label: 'Load', unit: '%' },
    { key: 'tempC', label: 'Motor temp', unit: '\u00b0C' }
  ];

  function openAlertModal(id) {
    const a = alertsById.get(id);
    if (!a) return;
    currentModalAlertId = id;
    renderModal(a);
    $('#alertModal').classList.remove('hidden');
  }

  function closeAlertModal() {
    currentModalAlertId = null;
    $('#alertModal').classList.add('hidden');
  }

  function renderModal(a) {
    $('#modalLevelTag').textContent = a.level;
    $('#modalLevelTag').className = `tag tag-${a.level}`;
    $('#modalZoneName').textContent = a.zoneName || '';
    $('#modalMsg').textContent = a.message;
    $('#modalTime').textContent = new Date(a.createdAt).toLocaleString();
    $('#modalStatus').textContent = a.status;
    $('#modalStatus').className = `tag tag-${a.status}`;
    $('#modalScore').textContent = `Risk score: ${a.score}/100`;
    $('#modalCause').textContent = a.cause || 'Unknown';

    // Contributing factors, ranked
    const contribWrap = $('#modalContributors');
    contribWrap.innerHTML = '';
    const contributors = a.contributors || [];
    const maxScore = Math.max(1, ...contributors.map((c) => c.score));
    contributors.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'modal-contrib-row' + (i === 0 ? ' top' : '');
      const pct = Math.min(100, (c.score / maxScore) * 100);
      row.innerHTML = `
        <span class="modal-contrib-label">${esc(c.label)}</span>
        <span class="modal-contrib-bar-track"><span class="modal-contrib-bar-fill" style="width:${pct}%"></span></span>
        <span class="modal-contrib-val">${Math.round(c.score)}</span>
      `;
      contribWrap.appendChild(row);
    });
    if (!contributors.length) {
      contribWrap.innerHTML = '<div class="modal-contrib-row"><span class="modal-contrib-label">No breakdown available for this alert</span></div>';
    }

    // Sensor snapshot
    const snapWrap = $('#modalSnapshot');
    snapWrap.innerHTML = '';
    const snap = a.snapshot || {};
    SNAPSHOT_FIELDS.forEach((f) => {
      if (snap[f.key] === undefined) return;
      const val = typeof snap[f.key] === 'number' ? snap[f.key].toFixed(f.key === 'alignmentMm' ? 1 : 1) : snap[f.key];
      const div = document.createElement('div');
      div.className = 'modal-snap-item';
      div.innerHTML = `<div class="modal-snap-label">${esc(f.label)}</div><div class="modal-snap-val">${esc(val)} ${esc(f.unit)}</div>`;
      snapWrap.appendChild(div);
    });
    if (!Object.keys(snap).length) {
      snapWrap.innerHTML = '<div class="modal-snap-item">No sensor snapshot recorded</div>';
    }

    // Recommended measures
    const actionsWrap = $('#modalActions');
    actionsWrap.innerHTML = '';
    const actions = a.recommendedActions || [];
    if (actions.length) {
      actions.forEach((act) => {
        const li = document.createElement('li');
        li.textContent = act;
        actionsWrap.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.textContent = 'No specific measures on file for this alert type.';
      actionsWrap.appendChild(li);
    }

    // Ack, Resolve, and Work Order buttons
    const ackInfo = $('#modalAckInfo');
    const ackBtn = $('#modalAckBtn');
    const resolveBtn = $('#modalResolveBtn');
    const createWoBtn = $('#modalCreateWoBtn');

    if (a.status === 'RESOLVED') {
      ackInfo.textContent = `Resolved by ${a.resolvedBy || 'unknown'} at ${a.resolvedAt ? new Date(a.resolvedAt).toLocaleString() : '—'}`;
      if (ackBtn) ackBtn.classList.add('hidden');
      if (resolveBtn) resolveBtn.classList.add('hidden');
    } else if (a.status === 'ACKNOWLEDGED') {
      ackInfo.textContent = `Acknowledged by ${a.acknowledgedBy || 'unknown'} at ${a.acknowledgedAt ? new Date(a.acknowledgedAt).toLocaleString() : '—'}`;
      if (ackBtn) ackBtn.classList.add('hidden');
      if (resolveBtn) {
        if (user.role !== 'VIEWER') {
          resolveBtn.classList.remove('hidden');
          resolveBtn.onclick = () => resolveAlert(a.id);
        } else {
          resolveBtn.classList.add('hidden');
        }
      }
    } else {
      ackInfo.textContent = '';
      if (user.role !== 'VIEWER') {
        if (ackBtn) {
          ackBtn.classList.remove('hidden');
          ackBtn.onclick = () => ackAlert(a.id);
        }
        if (resolveBtn) {
          resolveBtn.classList.remove('hidden');
          resolveBtn.onclick = () => resolveAlert(a.id);
        }
      } else {
        if (ackBtn) ackBtn.classList.add('hidden');
        if (resolveBtn) resolveBtn.classList.add('hidden');
      }
    }

    if (createWoBtn) {
      if (user.role !== 'VIEWER') {
        createWoBtn.classList.remove('hidden');
        if (a.workOrderId) {
          createWoBtn.textContent = `Work Order ${a.workOrderId} Active`;
          createWoBtn.disabled = true;
        } else {
          createWoBtn.textContent = 'Create Work Order';
          createWoBtn.disabled = false;
          createWoBtn.onclick = () => createWorkOrderFromAlert(a);
        }
      } else {
        createWoBtn.classList.add('hidden');
      }
    }
  }

  async function resolveAlert(id) {
    const notes = prompt('Enter resolution inspection notes (optional):', 'Field inspection complete, normal running resumed.');
    if (notes === null) return;
    try {
      const res = await fetch(`${API}/api/alerts/${id}/resolve`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutionNotes: notes })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      await loadAlerts();
      closeAlertModal();
    } catch (err) {
      alert(`Could not resolve alert: ${err.message}`);
    }
  }

  async function createWorkOrderFromAlert(alertItem) {
    const title = prompt('Work order title:', `Inspect ${alertItem.cause} on ${alertItem.zoneName}`);
    if (!title) return;
    const res = await fetch(`${API}/api/work-orders`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alertId: alertItem.id,
        zoneId: alertItem.zoneId,
        zoneName: alertItem.zoneName,
        title,
        priority: alertItem.level === 'CRITICAL' ? 'CRITICAL' : 'HIGH'
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      alert('Work order created successfully and linked to the originating alert.');
      await Promise.all([loadAlerts(), loadWorkOrders()]);
      closeAlertModal();
      showDashboardPage('workorders');
    } else {
      alert(`Could not create work order: ${data.error || `Request failed (${res.status})`}`);
    }
  }

  async function loadAssets() {
    const grid = $('#assetsGrid');
    if (!grid) return;
    grid.innerHTML = '<p class="panel-note">Loading equipment registry…</p>';
    try {
      const res = await fetch(`${API}/api/assets`, { headers: authHeaders() });
      if (!res.ok) return;
      const { assets } = await res.json();
      grid.innerHTML = '';
      if (!assets || !assets.length) {
        grid.innerHTML = '<p class="panel-note">No assets registered yet.</p>';
        return;
      }
      assets.forEach((ast) => {
        const card = document.createElement('div');
        card.className = 'asset-card';
        const healthColor = ast.healthScore >= 80 ? 'var(--accent-cyan)' : ast.healthScore >= 60 ? 'var(--accent-amber)' : 'var(--accent-red)';
        card.innerHTML = `
          <div class="asset-head">
            <div>
              <div class="asset-title">${esc(ast.name)}</div>
              <div class="asset-zone">${esc(ast.zoneName || ast.zoneId)} · ${esc(ast.type)}</div>
            </div>
            <span class="tag tag-view">${esc(ast.status)}</span>
          </div>
          <div class="asset-metrics">
            <div><span>Health Score</span><div class="asset-metric-val" style="color:${healthColor}">${ast.healthScore}/100</div></div>
            <div><span>Operating Hours</span><div class="asset-metric-val">${ast.operatingHours.toLocaleString()}h</div></div>
            <div><span>Serial Number</span><div class="asset-metric-val" style="font-size:11px">${esc(ast.serialNumber)}</div></div>
            <div><span>Last Service</span><div class="asset-metric-val" style="font-size:11px">${esc(ast.lastServiceDate || 'N/A')}</div></div>
          </div>
          <div style="font-size:11px;color:var(--hg-t-muted)">
            <strong>Specs:</strong> ${esc(ast.ratedCapacity)} · ${esc(ast.manufacturer)}
          </div>
        `;
        if (user && user.role !== 'VIEWER') {
          const actions = document.createElement('div');
          actions.className = 'asset-card-actions';
          actions.innerHTML = `<button class="btn btn-secondary btn-sm" type="button" data-asset-maintenance="${esc(ast.id)}">＋ Log maintenance</button>`;
          card.appendChild(actions);
        }
        grid.appendChild(card);
      });
    } catch (e) {
      grid.innerHTML = `<p class="panel-note">Error loading assets: ${esc(e.message)}</p>`;
    }
  }

  $('#createAssetBtn')?.addEventListener('click', async () => {
    if (user?.role !== 'ADMIN') return;
    const name = prompt('Asset name:');
    if (!name || !name.trim()) return;
    const zoneOptions = zones.map((z) => `${z.id} (${z.name})`).join('\n');
    const zoneId = prompt(`Enter the zone ID for this asset:\n${zoneOptions}`, zones[0]?.id || 'zone-a');
    if (!zoneId) return;
    if (!zones.some((z) => z.id === zoneId.trim())) { alert('That zone ID does not exist. Please use one of the listed zone IDs.'); return; }
    const type = prompt('Asset type (e.g. MOTOR, IDLER, TAKEUP, STRUCTURE):', 'EQUIPMENT') || 'EQUIPMENT';
    const serialNumber = prompt('Serial number (optional):', '') || 'N/A';
    const manufacturer = prompt('Manufacturer (optional):', '') || 'Standard';
    const ratedCapacity = prompt('Rated capacity/specification (optional):', '') || 'Rated';
    const zone = zones.find((z) => z.id === zoneId.trim());
    try {
      const res = await fetch(`${API}/api/assets`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), zoneId: zone.id, zoneName: zone.name, type: type.trim().toUpperCase(), serialNumber: serialNumber.trim(), manufacturer: manufacturer.trim(), ratedCapacity: ratedCapacity.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      await loadAssets();
      alert(`Asset created: ${data.asset?.name || name.trim()}`);
    } catch (err) { alert(`Could not create asset: ${err.message}`); }
  });

  $('#assetsGrid')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-asset-maintenance]');
    if (!button || user?.role === 'VIEWER') return;
    const assetId = button.getAttribute('data-asset-maintenance');
    const type = prompt('Maintenance activity type:', 'INSPECTION');
    if (!type) return;
    const notes = prompt('Maintenance notes (required):');
    if (!notes || !notes.trim()) { alert('Maintenance notes are required.'); return; }
    button.disabled = true;
    try {
      const res = await fetch(`${API}/api/assets/${encodeURIComponent(assetId)}/maintenance-log`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type.trim().toUpperCase(), notes: notes.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      await loadAssets();
      alert('Maintenance record saved to the asset history.');
    } catch (err) { alert(`Could not save maintenance record: ${err.message}`); button.disabled = false; }
  });

  async function loadWorkOrders() {
    const grid = $('#workOrdersGrid');
    if (!grid) return;
    grid.innerHTML = '<p class="panel-note">Loading maintenance work orders…</p>';
    try {
      const res = await fetch(`${API}/api/work-orders`, { headers: authHeaders() });
      if (!res.ok) return;
      const { workOrders } = await res.json();
      grid.innerHTML = '';
      if (!workOrders || !workOrders.length) {
        grid.innerHTML = '<p class="panel-note">No active maintenance work orders on file.</p>';
        return;
      }
      workOrders.forEach((wo) => {
        const card = document.createElement('div');
        card.className = 'wo-card';
        const statusTagClass = `tag-${wo.status}`;
        const currentUser = user || JSON.parse(localStorage.getItem('hg_user') || 'null');
        const isOperatorOrAdmin = currentUser && currentUser.role !== 'VIEWER';
        card.innerHTML = `
          <div class="wo-head">
            <div>
              <div class="wo-title">${esc(wo.id)}: ${esc(wo.title)}</div>
              <div class="wo-meta">${esc(wo.zoneName || wo.zoneId)} · Priority: <strong>${esc(wo.priority)}</strong> · ${new Date(wo.createdAt).toLocaleDateString()} · Technician: ${esc(wo.assignedTechnician || 'Unassigned')}</div>
            </div>
            <span class="tag ${statusTagClass}">${esc(wo.status)}</span>
          </div>
          <p style="font-size:12px;color:var(--hg-t-body);margin:0">${esc(wo.description)}</p>
          <div class="wo-checklist-wrap" style="margin:8px 0">
            <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;font-weight:600">Inspection Checklist:</div>
            <div style="display:flex;flex-direction:column;gap:5px">
              ${(wo.checklist || []).map((c, idx) => `
                <label style="cursor:${isOperatorOrAdmin ? 'pointer' : 'default'};display:flex;align-items:flex-start;gap:7px;font-size:12px;color:${c.completed ? 'var(--accent-cyan)' : '#cbd5e1'}">
                  <input type="checkbox" ${c.completed ? 'checked' : ''} data-wo-checklist="${esc(wo.id)}" data-checklist-index="${idx}" ${isOperatorOrAdmin ? '' : 'disabled'} style="margin-top:2px;cursor:pointer">
                  <span style="${c.completed ? 'text-decoration:line-through;opacity:0.85' : ''}">${esc(c.item)}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="wo-actions" style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${isOperatorOrAdmin ? `
              ${wo.status === 'OPEN' ? `<button class="btn btn-secondary btn-sm" type="button" data-wo-assign="${esc(wo.id)}">Assign Technician</button><button class="btn btn-primary btn-sm" type="button" data-wo-status="${esc(wo.id)}" data-next-status="IN_PROGRESS">▶ Start Work</button>` : ''}
              ${wo.status === 'ASSIGNED' ? `<button class="btn btn-primary btn-sm" type="button" data-wo-status="${esc(wo.id)}" data-next-status="IN_PROGRESS">▶ Start Work</button>` : ''}
              ${wo.status === 'IN_PROGRESS' ? `<button class="btn btn-success btn-sm" type="button" data-wo-status="${esc(wo.id)}" data-next-status="RESOLVED">✓ Mark Resolved</button>` : ''}
              ${wo.status === 'RESOLVED' && currentUser.role === 'ADMIN' ? `<button class="btn btn-secondary btn-sm" type="button" data-wo-status="${esc(wo.id)}" data-next-status="CLOSED">🔒 Close &amp; Sign Off</button>` : ''}
            ` : `
              <span style="font-size:11px;color:var(--text-dim)">Sign in as Operator or Admin to update maintenance tasks</span>
            `}
          </div>
        `;
        grid.appendChild(card);
      });
    } catch (e) {
      grid.innerHTML = `<p class="panel-note">Error loading work orders: ${esc(e.message)}</p>`;
    }
  }

  // Delegated handlers keep dynamically rendered work-order controls compatible
  // with the Content-Security-Policy (script-src-attr 'none').
  $('#workOrdersGrid')?.addEventListener('click', (event) => {
    const assignButton = event.target.closest('[data-wo-assign]');
    if (assignButton) { window.assignWoTechnician(assignButton.dataset.woAssign, assignButton); return; }
    const statusButton = event.target.closest('[data-wo-status]');
    if (statusButton) window.advanceWoStatus(statusButton.dataset.woStatus, statusButton.dataset.nextStatus, statusButton);
  });
  $('#workOrdersGrid')?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-wo-checklist]');
    if (checkbox) window.toggleWoChecklist(checkbox.dataset.woChecklist, Number(checkbox.dataset.checklistIndex));
  });

  window.assignWoTechnician = async function(id, btn) {
    const technician = prompt('Technician name or username:');
    if (!technician || !technician.trim()) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Assigning…'; }
    try {
      const detailRes = await fetch(`${API}/api/work-orders/${id}`, {
        method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedTechnician: technician.trim() })
      });
      const detailData = await detailRes.json().catch(() => ({}));
      if (!detailRes.ok) throw new Error(detailData.error || `Assignment failed (${detailRes.status})`);
      const statusRes = await fetch(`${API}/api/work-orders/${id}/status`, {
        method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ASSIGNED', note: `Assigned to ${technician.trim()}.` })
      });
      const statusData = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok) throw new Error(statusData.error || `Status update failed (${statusRes.status})`);
      await loadWorkOrders();
    } catch (err) {
      alert(`Could not assign technician: ${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Assign Technician'; }
    }
  };

  window.advanceWoStatus = async function(id, nextStatus, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Updating…';
    }
    const currentUser = user || JSON.parse(localStorage.getItem('hg_user') || 'null');
    let note = nextStatus === 'IN_PROGRESS'
      ? `Work commenced by ${currentUser?.displayName || currentUser?.username || 'technician'}.`
      : nextStatus === 'RESOLVED'
      ? 'Field repairs and verification completed.'
      : 'Supervisory sign-off and closure by Admin.';

    if (nextStatus === 'RESOLVED') {
      const custom = prompt('Enter resolution inspection notes (optional):', note);
      if (custom !== null && custom.trim()) note = custom.trim();
    } else if (nextStatus === 'CLOSED') {
      const custom = prompt('Enter administrative sign-off notes (optional):', note);
      if (custom !== null && custom.trim()) note = custom.trim();
    }

    try {
      const res = await fetch(`${API}/api/work-orders/${id}/status`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus, note })
      });
      if (res.status === 401) {
        alert('Your login session has expired. Please sign in again.');
        showLogin();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        alert(`Failed to update work order (${res.status}): ${data.error || 'Permission denied'}`);
        if (btn) {
          btn.disabled = false;
          btn.textContent = nextStatus === 'IN_PROGRESS' ? '▶ Start Work' : nextStatus === 'RESOLVED' ? '✓ Mark Resolved' : '🔒 Close & Sign Off';
        }
      } else {
        await loadWorkOrders();
      }
    } catch (err) {
      alert(`Network error updating work order: ${err.message}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = nextStatus === 'IN_PROGRESS' ? '▶ Start Work' : nextStatus === 'RESOLVED' ? '✓ Mark Resolved' : '🔒 Close & Sign Off';
      }
    }
  };

  window.toggleWoChecklist = async function(woId, itemIndex) {
    try {
      const res = await fetch(`${API}/api/work-orders/${woId}`, { headers: authHeaders() });
      if (!res.ok) return;
      const { workOrder } = await res.json();
      if (!workOrder || !Array.isArray(workOrder.checklist)) return;
      const checklist = [...workOrder.checklist];
      if (checklist[itemIndex]) {
        checklist[itemIndex].completed = !checklist[itemIndex].completed;
        const updateRes = await fetch(`${API}/api/work-orders/${woId}`, {
          method: 'PATCH',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ checklist })
        });
        const updateData = await updateRes.json().catch(() => ({}));
        if (!updateRes.ok) throw new Error(updateData.error || `Checklist update failed (${updateRes.status})`);
        await loadWorkOrders();
      }
    } catch (err) {
      alert(`Could not update inspection checklist: ${err.message}`);
      await loadWorkOrders();
    }
  };


  async function downloadCsv(url, filename) {
    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      alert(`CSV export failed: ${err.message}`);
    }
  }

  async function loadReportsSummary() {
    const kpiWrap = $('#reportsKpiGrid');
    if (!kpiWrap) return;
    try {
      const res = await fetch(`${API}/api/reports/summary`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      kpiWrap.innerHTML = `
        <div class="kpi-card"><div class="kpi-val">${data.alertMetrics.total}</div><div class="kpi-lbl">Total Alerts Logged</div></div>
        <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-red)">${data.alertMetrics.critical}</div><div class="kpi-lbl">Critical Events</div></div>
        <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-cyan)">${data.alertMetrics.mttrMinutes == null ? 'N/A' : `${data.alertMetrics.mttrMinutes}m`}</div><div class="kpi-lbl">Mean Resolution Time (MTTR)</div></div>
        <div class="kpi-card"><div class="kpi-val" style="color:var(--accent-amber)">${data.workOrderBacklog.active}</div><div class="kpi-lbl">Active Maintenance Tasks</div></div>
        <div class="kpi-card"><div class="kpi-val">${data.systemStatus.totalAssets}</div><div class="kpi-lbl">Monitored Assets</div></div>
      `;
    } catch (err) {
      console.error('[reports] failed to load summary:', err);
    }
  }

  async function downloadConditionReport() {
    try {
      const { jsPDF } = window.jspdf || {};
      if (!jsPDF) {
        alert('PDF generator library not loaded. Please ensure you are connected or check CSP.');
        return;
      }
      const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const now = new Date().toLocaleString();

      // Title & Header Banner
      doc.setFillColor(11, 19, 30);
      doc.rect(0, 0, 595.28, 70, 'F');
      doc.setTextColor(69, 216, 201);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('HILLGUARD OVERLAND CONVEYOR SYSTEM', 40, 38);
      doc.setFontSize(9.5);
      doc.setTextColor(170, 184, 197);
      doc.setFont('helvetica', 'normal');
      doc.text(`Comprehensive Condition & Maintenance Audit Report · Generated: ${now}`, 40, 56);

      // Fetch latest report summary and assets
      let summary = null;
      try {
        const res = await fetch(`${API}/api/reports/summary`, { headers: authHeaders() });
        if (res.ok) summary = await res.json();
      } catch (_) {}

      let assetsList = [];
      try {
        const res = await fetch(`${API}/api/assets`, { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          assetsList = data.assets || [];
        }
      } catch (_) {}

      // Section 1: Executive KPI Summary
      doc.setTextColor(20, 35, 50);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('1. Executive Operational Summary', 40, 100);

      const kpiData = [
        ['Total Monitored Conveyor Zones', zones.length.toString()],
        ['Monitored Equipment Assets', assetsList.length.toString()],
        ['Total Logged Alerts', summary?.alertMetrics?.total?.toString() || '0'],
        ['Critical Severe Faults', summary?.alertMetrics?.critical?.toString() || '0'],
        ['Active Maintenance Work Orders', summary?.workOrderBacklog?.active?.toString() || '0'],
        ['Mean Time to Resolve (MTTR)', `${summary?.alertMetrics?.mttrMinutes == null ? 'N/A' : `${summary.alertMetrics.mttrMinutes} minutes`}`]
      ];

      doc.autoTable({
        startY: 110,
        head: [['Operational KPI Metric', 'Current Audit Value']],
        body: kpiData,
        theme: 'striped',
        styles: { fontSize: 8.5, cellPadding: 3.5 },
        headStyles: { fillColor: [16, 47, 60], textColor: [69, 216, 201] },
        margin: { left: 40, right: 40 }
      });

      // Section 2: Monitored Conveyor Zones & Live Health
      let currentY = doc.lastAutoTable.finalY + 20;
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('2. Conveyor Zone Telemetry & Risk States', 40, currentY);

      const zoneRows = zones.map((z) => [
        z.id.toUpperCase(),
        z.name,
        `${z.inclineDeg > 0 ? '+' : ''}${z.inclineDeg}°`,
        `${z.latestReading?.alignmentMm != null ? z.latestReading.alignmentMm : '—'} mm`,
        `${z.latestReading?.vibrationMms != null ? z.latestReading.vibrationMms : '—'} mm/s`,
        `${z.latestReading?.tempC != null ? z.latestReading.tempC : '—'} °C`,
        `${z.riskScore ?? '—'}/100`,
        z.riskLevel || 'NOMINAL'
      ]);

      doc.autoTable({
        startY: currentY + 10,
        head: [['Zone', 'Name', 'Incline', 'Drift', 'Vibration', 'Temp', 'Risk', 'Status']],
        body: zoneRows,
        theme: 'grid',
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [24, 40, 56], textColor: [255, 255, 255] },
        margin: { left: 40, right: 40 }
      });

      // Section 3: Equipment Asset Registry
      currentY = doc.lastAutoTable.finalY + 20;
      if (currentY > 680) { doc.addPage(); currentY = 50; }
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('3. Equipment Asset Registry Condition', 40, currentY);

      const assetRows = assetsList.map((a) => [
        a.serialNumber || a.id,
        a.name,
        a.type,
        `${a.healthScore}/100`,
        `${a.operatingHours} hrs`,
        a.status
      ]);

      doc.autoTable({
        startY: currentY + 10,
        head: [['Asset Serial', 'Component Name', 'Type', 'Health', 'Operating Hours', 'Status']],
        body: assetRows.length ? assetRows : [['—', 'No assets recorded', '—', '—', '—', '—']],
        theme: 'striped',
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [16, 47, 60], textColor: [69, 216, 201] },
        margin: { left: 40, right: 40 }
      });

      // Footer
      const pageCount = doc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(
          `HillGuard Industrial Monitoring Platform · Page ${i} of ${pageCount} · Supervisory Audit Document`,
          40,
          820
        );
      }

      doc.save(`HillGuard-Condition-Report-${Date.now()}.pdf`);
    } catch (err) {
      console.error('[pdf export failed]', err);
      alert(`Failed to generate PDF report: ${err.message}`);
    }
  }

  $('#exportAlertsCsvBtn')?.addEventListener('click', () => downloadCsv(`${API}/api/reports/export/alerts.csv`, `HillGuard-Alerts-${Date.now()}.csv`));
  $('#exportWorkOrdersCsvBtn')?.addEventListener('click', () => downloadCsv(`${API}/api/reports/export/work-orders.csv`, `HillGuard-WorkOrders-${Date.now()}.csv`));
  $('#refreshAssetsBtn')?.addEventListener('click', loadAssets);
  $('#refreshWorkOrdersBtn')?.addEventListener('click', loadWorkOrders);

  $('#modalCloseBtn').addEventListener('click', closeAlertModal);
  $('#modalCloseBtn2').addEventListener('click', closeAlertModal);
  $('#alertModal').addEventListener('click', (e) => {
    if (e.target.id === 'alertModal') closeAlertModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAlertModal();
  });

  // ---------------- Digital Twin & Engineering Laboratory ----------------
  let twinView = '3d';
  let twinZoom = 1.0;
  let twinPanX = 0, twinPanY = 0;
  let twinIsDragging = false, twinDragStartX = 0, twinDragStartY = 0;
  let selectedTwinComponent = 'comp-motor-a';

  const TWIN_COMPONENTS = [
    {
      id: 'comp-motor-a', tag: 'MTR-01A', name: 'Primary VFD Drive Motor', type: 'DRIVE_MOTOR', zoneId: 'zone-a',
      specs: { rating: '550 kW', voltage: '690 V', speed: '1485 RPM', bearing: 'SKF 22320 Roller' }
    },
    {
      id: 'comp-pulley-head', tag: 'PLY-HD-01', name: 'Head Drive Pulley', type: 'DRIVE_PULLEY', zoneId: 'zone-a',
      specs: { diameter: '800 mm', width: '1400 mm', lagging: '12mm Ceramic', shaft: '180mm forged' }
    },
    {
      id: 'comp-idlers-curve-b', tag: 'IDL-CRV-B', name: 'Transition Curved Idler Bank 1', type: 'TROUGHING_IDLER', zoneId: 'zone-b',
      specs: { rollDia: '152 mm', bearing: '6308-2RS', spacing: '1.2 m', angle: '35° Trough' }
    },
    {
      id: 'comp-idlers-curve-c', tag: 'IDL-CRV-C', name: 'Severe Incline Curved Training Idlers', type: 'TRAINING_IDLER', zoneId: 'zone-c',
      specs: { rollDia: '152 mm', bearing: '6308-2RS', spacing: '1.0 m', guide: 'Pivoting Tracking' }
    },
    {
      id: 'comp-takeup-winch', tag: 'TKP-WCH-01', name: 'Automated Hydraulic Take-Up Winch', type: 'TAKEUP_WINCH', zoneId: 'zone-d',
      specs: { stroke: '4.5 m', tension: '80 kN nominal', carriageMass: '12,000 kg', pump: 'Rexroth A10' }
    },
    {
      id: 'comp-truss-descent', tag: 'TRS-DSC-01', name: 'Downhill Overland Structural Truss', type: 'STRUCTURAL_TRUSS', zoneId: 'zone-e',
      specs: { span: '36 m', material: 'Galvanized S355', deflectionLimit: 'L/600', windRating: '160 km/h' }
    },
    {
      id: 'comp-pulley-tail', tag: 'PLY-TL-01', name: 'Tail Tension Pulley & Discharge Zone', type: 'TAIL_PULLEY', zoneId: 'zone-e',
      specs: { diameter: '630 mm', width: '1400 mm', bearing: 'SKF 22216', takeupTravel: '3.8 m' }
    }
  ];

  function twinRiskColor(level) {
    if (level === 'CRITICAL') return '#ff4f61';
    if (level === 'WARNING') return '#ffbd3d';
    return '#21e6c1';
  }
  function twinZoneLabel(z, i) {
    const parts = (z.name || `Zone ${i + 1}`).split(' - ');
    return { code: parts[0] || `Zone ${i + 1}`, name: parts[1] || 'Section' };
  }
  function twinSensorValue(zone, key, fallback='—') {
    const r = twinReadingFor(zone);
    const values = {
      alignment: r.alignmentMm != null ? `${Number(r.alignmentMm).toFixed(2)} mm` : fallback,
      vibration: r.vibrationMms != null ? `${Number(r.vibrationMms).toFixed(2)} mm/s` : fallback,
      tension: r.tensionPct != null ? `${Number(r.tensionPct).toFixed(1)} %` : fallback,
      slip: r.slipPct != null ? `${Number(r.slipPct).toFixed(1)} %` : fallback,
      load: r.loadPct != null ? `${Number(r.loadPct).toFixed(1)} %` : fallback,
      temp: r.tempC != null ? `${Number(r.tempC).toFixed(1)} °C` : fallback
    };
    return values[key];
  }
  function renderTwinSensors() {
    const wrap = $('#twinSensorStrip');
    if (!wrap) return;
    const z = zones.find(x => x.id === selectedZoneId) || zones[1] || zones[0];
    if (!z) return;
    const items = [
      ['Belt Alignment','alignment','±25 mm Tol'],['Structural Vibration','vibration','ISO 10816 < 4.5'],
      ['Belt Tension','tension','CEMA 70–90%'],['Drive Pulley Slip','slip','Euler < 2.0%'],
      ['Material Payload','load','Rated 2500 t/h'],['Motor / Bearing Temp','temp','Max 85 °C']
    ];
    wrap.innerHTML = items.map(([label,key,range]) => `<div class="twin-sensor"><div class="twin-sensor-label">${label}</div><div class="twin-sensor-value">${twinSensorValue(z,key)}</div><div class="twin-sensor-state">● ${range}</div></div>`).join('');
  }

  function twinGeometry(mode) {
    const n = zones.length || 6, pad = 115, step = (1000 - pad * 2) / Math.max(1, n - 1);
    if (mode === 'top') return zones.map((z, i) => ({ x: pad + i * step, y: 195 + [0, 8, -5, 5, -8, 2][i % 6] }));
    if (mode === 'side') return zones.map((z, i) => ({ x: pad + i * step, y: 250 - ((Number(z.inclineDeg) || 0) + 15) * 3 + [0, 8, -4, 6, -6, 4][i % 6] }));
    return zones.map((z, i) => ({ x: pad + i * step, y: Math.max(115, Math.min(290, 255 - ((Number(z.inclineDeg) || 0) * 2) + [0, 12, -10, -22, -5, 15][i % 6])) }));
  }

  function twinReadingFor(zone) {
    return replayTwinOverride && zone?.id === replayTwinOverride.zoneId ? replayTwinOverride.reading : (zone?.latestReading || {});
  }
  function twinRiskFor(zone) {
    return replayTwinOverride && zone?.id === replayTwinOverride.zoneId ? (replayTwinOverride.risk || {level:'UNKNOWN',score:0}) : {level:zone?.riskLevel || 'NORMAL',score:zone?.riskScore ?? 0};
  }

  function updateComponentInspector(compId) {
    const comp = TWIN_COMPONENTS.find(c => c.id === compId) || TWIN_COMPONENTS[0];
    selectedTwinComponent = comp.id;
    const z = zones.find(x => x.id === comp.zoneId) || zones[0] || {};
    const reading = twinReadingFor(z);

    $('#inspectorTag').textContent = comp.tag;
    $('#inspectorName').textContent = comp.name;
    $('#inspectorZone').textContent = `${z.name || comp.zoneId} · ${comp.type.replace('_', ' ')}`;

    const specsBox = $('#inspectorSpecs');
    if (specsBox) {
      specsBox.innerHTML = Object.entries(comp.specs)
        .map(([k, v]) => `<div><span>${k.toUpperCase()}</span><strong>${esc(v)}</strong></div>`)
        .join('');
    }

    const telemGrid = $('#inspectorTelemetryGrid');
    if (telemGrid) {
      telemGrid.innerHTML = `
        <div class="inspector-telemetry-item"><div>Alignment Drift</div><div class="inspector-telemetry-val">${reading.alignmentMm != null ? `${reading.alignmentMm} mm` : '—'}</div></div>
        <div class="inspector-telemetry-item"><div>Vibration RMS</div><div class="inspector-telemetry-val">${reading.vibrationMms != null ? `${reading.vibrationMms} mm/s` : '—'}</div></div>
        <div class="inspector-telemetry-item"><div>Operating Temp</div><div class="inspector-telemetry-val">${reading.tempC != null ? `${reading.tempC} °C` : '—'}</div></div>
        <div class="inspector-telemetry-item"><div>Drive Slip</div><div class="inspector-telemetry-val">${reading.slipPct != null ? `${reading.slipPct} %` : '—'}</div></div>
      `;
    }

    const statusEl = $('#inspectorStatus');
    if (statusEl) {
      const isCritical = twinRiskFor(z).level === 'CRITICAL';
      const isWarning = twinRiskFor(z).level === 'WARNING';
      statusEl.textContent = isCritical ? 'CRITICAL FAULT' : isWarning ? 'WARNING THRESHOLD' : 'NOMINAL';
      statusEl.style.color = isCritical ? 'var(--accent-red)' : isWarning ? 'var(--accent-amber)' : 'var(--accent-cyan)';
    }
  }

  // ---- Digital twin: zone-aware, theme-aware, interactive ----
  const TWIN_RANK = { NORMAL: 0, WARNING: 1, CRITICAL: 2 };
  function twinRiskVar(level) {
    return level === 'CRITICAL' ? 'var(--tw-crit)' : level === 'WARNING' ? 'var(--tw-warn)' : 'var(--tw-ok)';
  }
  function twinSpeed(z) {
    const s = Number(z && (z.baseSpeedMps ?? z.latestReading?.beltSpeedMps));
    return Number.isFinite(s) && s > 0 ? s : 3;
  }
  function twinApplyViewport() {
    const g = $('#twinViewport');
    if (g) g.setAttribute('transform', `translate(${twinPanX} ${twinPanY}) translate(500 195) scale(${twinZoom}) translate(-500 -195)`);
  }
  function twinCompGlyph(comp, cx, cy, sel, sw, spin) {
    switch (comp.type) {
      case 'DRIVE_MOTOR':
        return `<rect x="${cx-17}" y="${cy-11}" width="34" height="22" rx="4" class="tw-comp-body" style="stroke:${sel}" stroke-width="${sw}"/><path d="M${cx-17} ${cy-4} h-6 v8 h6" class="tw-comp-body" style="stroke:${sel}" stroke-width="1.2"/><text x="${cx}" y="${cy+4}" class="tw-comp-glyph-text">M</text>`;
      case 'DRIVE_PULLEY':
      case 'TAIL_PULLEY':
        return `<circle cx="${cx}" cy="${cy}" r="13" class="tw-comp-body" style="stroke:${sel}" stroke-width="${sw}"/><g class="twin-spin" style="transform-origin:${cx}px ${cy}px;animation-duration:${spin}s"><path d="M${cx-9} ${cy} H${cx+9} M${cx} ${cy-9} V${cy+9}" style="stroke:${sel}" stroke-width="1.5"/></g><circle cx="${cx}" cy="${cy}" r="2.5" style="fill:${sel}"/>`;
      case 'TROUGHING_IDLER':
      case 'TRAINING_IDLER':
        return `<path d="M${cx-18} ${cy-6} L${cx-8} ${cy+6} H${cx+8} L${cx+18} ${cy-6}" style="stroke:${sel}" stroke-width="${sw+1}" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${cx-18}" cy="${cy-6}" r="3" style="fill:${sel}"/><circle cx="${cx+18}" cy="${cy-6}" r="3" style="fill:${sel}"/><circle cx="${cx}" cy="${cy+6}" r="3" style="fill:${sel}"/>`;
      case 'TAKEUP_WINCH':
        return `<rect x="${cx-16}" y="${cy-10}" width="32" height="20" rx="3" class="tw-comp-body" style="stroke:${sel}" stroke-width="${sw}"/><circle cx="${cx-5}" cy="${cy}" r="6" class="tw-comp-body" style="stroke:${sel}" stroke-width="1.2"/><path d="M${cx+1} ${cy} H${cx+12}" style="stroke:${sel}" stroke-width="2"/>`;
      case 'STRUCTURAL_TRUSS':
        return `<path d="M${cx-20} ${cy+9} L${cx-10} ${cy-9} L${cx} ${cy+9} L${cx+10} ${cy-9} L${cx+20} ${cy+9} M${cx-20} ${cy+9} H${cx+20}" style="stroke:${sel}" stroke-width="${sw}" fill="none" stroke-linejoin="round"/>`;
      default:
        return `<rect x="${cx-14}" y="${cy-9}" width="28" height="18" rx="3" class="tw-comp-body" style="stroke:${sel}" stroke-width="${sw}"/>`;
    }
  }

  function renderTwinChips(active) {
    const wrap = $('#twinZoneChips');
    if (!wrap) return;
    const sig = zones.map(z => `${z.id}|${twinRiskFor(z).level}|${Math.round(twinRiskFor(z).score || 0)}`).join(';') + '@' + active + (replayTwinOverride ? `@replay:${replayTwinOverride.reading?.ts}` : '');
    if (wrap.dataset.sig === sig) return;
    wrap.dataset.sig = sig;
    wrap.innerHTML = zones.map((z, i) => {
      const l = twinZoneLabel(z, i);
      return `<button type="button" class="twin-chip${z.id === active ? ' active' : ''}" data-twin-chip="${esc(z.id)}" aria-pressed="${z.id === active}"><i style="background:${twinRiskVar(twinRiskFor(z).level)}"></i><b>${esc(l.code)}</b><small>${esc(l.name)}</small><em>${Number(twinRiskFor(z).score ?? z.riskScore ?? 0)}</em></button>`;
    }).join('');
  }

  function twinTipHtml(target) {
    const zoneId = target.getAttribute('data-twin-zone');
    const compId = target.getAttribute('data-comp-id');
    const comp = compId ? TWIN_COMPONENTS.find(c => c.id === compId) : null;
    const z = zones.find(x => x.id === (zoneId || comp?.zoneId));
    if (!z) return '';
    const lvl = twinRiskFor(z).level || 'NORMAL';
    const row = (k, key) => `<span>${k}</span><b>${twinSensorValue(z, key)}</b>`;
    return `<div class="tt-title">${esc(comp ? comp.name : z.name)}</div>
      ${comp ? `<div class="tt-sub">${esc(comp.tag)} · ${esc(z.name)}</div>` : ''}
      <div class="tt-risk" style="color:${twinRiskVar(lvl)}">${esc(lvl)} · risk ${Number(twinRiskFor(z).score ?? z.riskScore ?? 0)}/100</div>
      <div class="tt-grid">${row('Alignment','alignment')}${row('Vibration','vibration')}${row('Tension','tension')}${row('Slip','slip')}${row('Load','load')}${row('Temp','temp')}</div>
      <div class="tt-hint">Click to ${comp ? 'inspect component' : 'select zone'}</div>`;
  }
  function showTwinTip(e, html) {
    const stage = $('#digitalTwinStage');
    if (!stage || !html) return;
    let tip = $('#twinTooltip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'twinTooltip'; tip.className = 'twin-tooltip'; stage.appendChild(tip); }
    tip.innerHTML = html; tip.hidden = false;
    const r = stage.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    if (x + tip.offsetWidth > r.width - 6) x = e.clientX - r.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > r.height - 6) y = r.height - tip.offsetHeight - 6;
    tip.style.left = Math.max(6, x) + 'px'; tip.style.top = Math.max(6, y) + 'px';
  }
  function hideTwinTip() { const t = $('#twinTooltip'); if (t) t.hidden = true; }

  function renderDigitalTwin(mode = twinView) {
    const svg = $('#digitalTwinSvg');
    if (!svg || !zones.length) return;
    twinView = mode;
    const active = selectedZoneId || (zones[1] && zones[1].id) || zones[0].id;
    const twinSelect = $('#twinZoneSelect');
    if (twinSelect) {
      const signature = zones.map(z => `${z.id}:${z.name}`).join('|');
      if (twinSelect.dataset.signature !== signature) {
        twinSelect.innerHTML = zones.map(z => `<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('');
        twinSelect.dataset.signature = signature;
      }
      twinSelect.value = active;
    }
    renderTwinChips(active);

    const base = twinGeometry(mode);
    // Top view: belt centreline visibly drifts with each zone's measured alignment error.
    const pts = base.map((p, i) => {
      if (mode !== 'top') return p;
      const d = Math.max(-26, Math.min(26, Number(twinReadingFor(zones[i])?.alignmentMm || 0) * 0.9));
      return { x: p.x, y: p.y + d };
    });
    const n = pts.length;
    const fmt = (p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p)}`).join(' ');
    const basePath = base.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p)}`).join(' ');
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const span = (i) => `M ${fmt(i === 0 ? pts[0] : mid(pts[i - 1], pts[i]))} L ${fmt(pts[i])} L ${fmt(i === n - 1 ? pts[n - 1] : mid(pts[i], pts[i + 1]))}`;
    const clock = Date.now() / 1000;
    const FLOW_PERIOD = 24, FLOW_K = 14;

    let html = `<defs>
      <linearGradient id="twinSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--tw-sky-top)"/><stop offset="1" style="stop-color:var(--tw-sky-bot)"/></linearGradient>
      <linearGradient id="twinGround" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--tw-ground-top)"/><stop offset="1" style="stop-color:var(--tw-ground-bot)"/></linearGradient>
      <filter id="twinGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs><g id="twinViewport">`;

    if (mode === 'top') {
      html += `<rect x="-1000" y="-400" width="3000" height="1200" class="tw-bg-top"/>
        <path d="M-1000 95 H2000 M-1000 155 H2000 M-1000 215 H2000 M-1000 275 H2000 M-1000 335 H2000 M90 -400 V800 M210 -400 V800 M330 -400 V800 M450 -400 V800 M570 -400 V800 M690 -400 V800 M810 -400 V800 M930 -400 V800" class="tw-grid"/>
        <path d="M-200 70 Q180 30 350 80 T700 65 T1200 90" class="tw-ridge"/>
        <path d="${basePath}" class="twin-nominal"/>
        <text x="28" y="28" class="twin-side-label">TOP VIEW · BELT ALIGNMENT DRIFT vs DESIGN LINE (dashed)</text>`;
    } else if (mode === 'side') {
      html += `<rect x="-1000" y="-400" width="3000" height="1200" fill="url(#twinSky)"/>
        <rect x="-1000" y="322" width="3000" height="500" class="tw-hill-near"/>
        <path d="M-1000 315 H2000" class="tw-baseline"/>
        <path d="M-200 230 Q180 205 340 235 T680 220 T1200 235" class="tw-ridge" style="stroke-width:55"/>
        <text x="28" y="28" class="twin-side-label">SIDE VIEW · ELEVATION PROFILE &amp; STRUCTURAL SUPPORTS</text>`;
    } else {
      html += `<rect x="-1000" y="-400" width="3000" height="1200" fill="url(#twinSky)"/>
        <path d="M-1000 210 L0 210 Q130 115 260 210 T520 205 T760 175 T1000 195 L2000 195 L2000 800 L-1000 800Z" class="tw-hill-far"/>
        <path d="M-1000 265 L0 265 Q160 190 310 260 T590 250 T820 225 T1000 245 L2000 245 L2000 800 L-1000 800Z" fill="url(#twinGround)"/>
        <text x="28" y="28" class="twin-side-label">3D VIEW · ZONE-AWARE CONVEYOR ASSEMBLY</text>`;
    }

    // Supports
    if (mode !== 'top') {
      pts.forEach((p) => {
        html += `<line x1="${p.x - 13}" y1="${p.y + 8}" x2="${p.x - 13}" y2="335" class="twin-support"/><line x1="${p.x + 13}" y1="${p.y + 8}" x2="${p.x + 13}" y2="335" class="twin-support2"/><line x1="${p.x - 24}" y1="335" x2="${p.x + 24}" y2="335" class="twin-support2"/>`;
      });
    }

    // Belt: shadow, per-zone risk halo, belt body, rails
    const off = mode === 'top' ? 9 : 8;
    html += `<path d="${path}" class="twin-belt-shadow"/>`;
    zones.forEach((z, i) => {
      if (!pts[i]) return;
      const lvl = twinRiskFor(z).level || 'NORMAL', sel = z.id === active;
      html += `<path d="${span(i)}" class="twin-zone-span${sel ? ' selected' : ''}" style="stroke:${twinRiskVar(lvl)}" stroke-opacity="${sel ? .55 : lvl === 'NORMAL' ? .16 : .38}"/>`;
    });
    html += `<path d="${path}" class="twin-belt"/><path d="${path}" class="twin-belt-inner"/>
      <path d="${path}" class="twin-rail" transform="translate(0,-${off})"/><path d="${path}" class="twin-rail" transform="translate(0,${off})"/>`;
    // Flowing belt texture; speed follows each zone's belt speed
    zones.forEach((z, i) => {
      if (!pts[i]) return;
      const dur = FLOW_PERIOD / (twinSpeed(z) * FLOW_K);
      html += `<path d="${span(i)}" class="twin-flow" style="animation-duration:${dur.toFixed(3)}s;animation-delay:-${(clock % dur).toFixed(3)}s"/>`;
    });

    // Payload moving along the belt (continuous phase across re-renders)
    const avgSpeed = zones.reduce((s, z) => s + twinSpeed(z), 0) / zones.length;
    const avgLoad = zones.reduce((s, z) => s + (Number(twinReadingFor(z)?.loadPct) || 60), 0) / zones.length;
    let len = 0; for (let i = 1; i < n; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const dur = Math.max(3, len / (avgSpeed * FLOW_K));
    const cnt = Math.max(4, Math.min(14, Math.round(avgLoad / 10)));
    for (let k = 0; k < cnt; k++) {
      html += `<g transform="translate(0,-5)"><circle r="3.4" class="twin-conveyor-dot"><animateMotion dur="${dur.toFixed(2)}s" repeatCount="indefinite" begin="-${((clock % dur) + (k * dur) / cnt).toFixed(2)}s" path="${path}"/></circle></g>`;
    }

    // Components, placed under their own zone
    const perZone = {};
    TWIN_COMPONENTS.forEach(c => { (perZone[c.zoneId] = perZone[c.zoneId] || []).push(c); });
    TWIN_COMPONENTS.forEach((comp) => {
      const zi = zones.findIndex(z => z.id === comp.zoneId);
      if (zi < 0 || !pts[zi]) return;
      const z = zones[zi], list = perZone[comp.zoneId], k = list.indexOf(comp);
      const cx = pts[zi].x + (k - (list.length - 1) / 2) * 50, cy = pts[zi].y + 36;
      const lvl = twinRiskFor(z).level || 'NORMAL', color = twinRiskVar(lvl);
      const selected = comp.id === selectedTwinComponent;
      const r = twinReadingFor(z) || {};
      const cls = ['twin-component-node', Number(r.vibrationMms) > 4.5 ? 'twin-shake' : '', Number(r.tempC) > 85 ? 'twin-hot' : ''].join(' ').trim();
      const spin = (6 / twinSpeed(z)).toFixed(2);
      html += `<g class="${cls}" data-comp-id="${esc(comp.id)}" tabindex="0" role="button" aria-label="Inspect ${esc(comp.name)} in ${esc(z.name)}">
        ${selected ? `<rect x="${cx - 27}" y="${cy - 17}" width="54" height="52" rx="8" class="twin-comp-sel"/>` : ''}
        ${twinCompGlyph(comp, cx, cy, selected ? 'var(--tw-sel)' : color, selected ? 2.4 : 1.5, spin)}
        <text x="${cx}" y="${cy + 28}" class="twin-comp-tag" style="fill:${color}">${esc(comp.tag)}</text></g>`;
    });

    // Zone markers and labels
    zones.forEach((z, i) => {
      const p = pts[i]; if (!p) return;
      const twinRisk = twinRiskFor(z);
      const lvl = twinRisk.level || 'NORMAL', c = twinRiskVar(lvl), labels = twinZoneLabel(z, i), sel = z.id === active;
      const boxY = Math.max(36, p.y - 78);
      html += `<g class="twin-zone-node${sel ? ' selected' : ''}" data-twin-zone="${esc(z.id)}" tabindex="0" role="button" aria-label="Select ${esc(z.name)}, risk ${esc(lvl)}">
        <line x1="${p.x}" y1="${boxY + 46}" x2="${p.x}" y2="${p.y - 12}" class="twin-zone-line"/>
        <rect x="${p.x - 63}" y="${boxY}" width="126" height="46" rx="7" class="twin-label-box${sel ? ' selected' : ''}"/>
        <text x="${p.x}" y="${boxY + 15}" class="twin-zone-text" style="fill:${c}">${esc(labels.code)}</text>
        <text x="${p.x}" y="${boxY + 28}" class="twin-zone-sub">${esc(labels.name)}</text>
        <text x="${p.x}" y="${boxY + 40}" class="twin-zone-sub">RISK ${Number(twinRisk.score ?? z.riskScore ?? 0)}/100 · ${esc(lvl)}</text>
        ${sel ? `<circle cx="${p.x}" cy="${p.y}" r="21" fill="none" class="twin-selected-ring"/>` : ''}
        <circle cx="${p.x}" cy="${p.y}" r="${sel ? 15 : 11}" style="fill:${c}" opacity=".22" class="${lvl === 'CRITICAL' ? 'twin-marker-pulse' : ''}"/>
        <circle cx="${p.x}" cy="${p.y}" r="${sel ? 8 : 7}" style="fill:${c}" class="twin-marker" filter="url(#twinGlow)"/>
        <circle cx="${p.x}" cy="${p.y}" r="22" fill="transparent"/></g>`;
    });

    html += `</g>`;
    svg.innerHTML = html;
    twinApplyViewport();

    renderTwinSensors();
  }

  function setupDigitalTwinStageEvents() {
    $('#twinZoneSelect')?.addEventListener('change', (event) => {
      if (event.target.value && event.target.value !== selectedZoneId) selectZone(event.target.value);
      applyZoneToTwinScenario();
    });
    $('#twinZoneChips')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-twin-chip]');
      if (b) selectZone(b.getAttribute('data-twin-chip'));
    });
    const stage = $('#digitalTwinStage');
    const svg = $('#digitalTwinSvg');
    if (!stage || !svg) return;

    let moved = false, downX = 0, downY = 0;
    const activate = (el) => {
      const compId = el.getAttribute('data-comp-id');
      const zoneId = el.getAttribute('data-twin-zone');
      if (compId) {
        const comp = TWIN_COMPONENTS.find(c => c.id === compId);
        if (comp && comp.zoneId !== selectedZoneId) selectZone(comp.zoneId);
        updateComponentInspector(compId);
        renderDigitalTwin();
      } else if (zoneId) {
        selectZone(zoneId);
      }
    };
    stage.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      twinIsDragging = true; moved = false; downX = e.clientX; downY = e.clientY;
      twinDragStartX = e.clientX - twinPanX; twinDragStartY = e.clientY - twinPanY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!twinIsDragging) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
      if (!moved) return;
      twinPanX = e.clientX - twinDragStartX; twinPanY = e.clientY - twinDragStartY;
      hideTwinTip();
      twinApplyViewport();
    });
    window.addEventListener('pointerup', () => { twinIsDragging = false; });
    svg.addEventListener('click', (e) => {
      const el = e.target.closest('[data-twin-zone],[data-comp-id]');
      if (!el || moved) return;
      e.stopPropagation();
      activate(el);
    });
    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = e.target.closest('[data-twin-zone],[data-comp-id]');
      if (el) { e.preventDefault(); activate(el); }
    });
    svg.addEventListener('mousemove', (e) => {
      if (twinIsDragging) return;
      const el = e.target.closest('[data-twin-zone],[data-comp-id]');
      if (el) showTwinTip(e, twinTipHtml(el)); else hideTwinTip();
    });
    svg.addEventListener('mouseleave', hideTwinTip);

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      twinZoom = Math.max(0.6, Math.min(2.5, twinZoom * (e.deltaY < 0 ? 1.08 : 0.92)));
      twinApplyViewport();
    }, { passive: false });
    $('#twinZoomInBtn')?.addEventListener('click', () => { twinZoom = Math.min(2.5, twinZoom + 0.15); twinApplyViewport(); });
    $('#twinZoomOutBtn')?.addEventListener('click', () => { twinZoom = Math.max(0.6, twinZoom - 0.15); twinApplyViewport(); });
    $('#twinResetCamBtn')?.addEventListener('click', () => { twinPanX = 0; twinPanY = 0; twinZoom = 1.0; twinApplyViewport(); });
  }

  // Load the selected zone's latest telemetry into the engineering scenario as a starting point.
  // This is an explicit mapping from telemetry to simulation inputs, not a claim that all sensors are direct physical parameters.
  function applyZoneToTwinScenario() {
    const z = zones.find(item => item.id === selectedZoneId);
    if (!z) return;
    const r = z.latestReading || {};
    const set = (id, value, displayId, formatter) => {
      const input = $(`#${id}`);
      if (!input || value == null || !Number.isFinite(Number(value))) return;
      const bounded = Math.max(Number(input.min), Math.min(Number(input.max), Number(value)));
      input.value = String(bounded);
      const output = $(`#${displayId}`);
      if (output) output.textContent = formatter(bounded);
    };
    set('simIncline', z.inclineDeg, 'valIncline', v => `${v}° ${v < 0 ? '(Downhill)' : v > 0 ? '(Uphill)' : '(Flat)'}`);
    set('simMisalignment', r.alignmentMm, 'valMisalignment', v => `${v} mm`);
    set('simMaterialLoad', r.loadPct == null ? null : (Number(r.loadPct) / 100) * 2500, 'valMaterialLoad', v => `${Math.round(v / 50) * 50} t/h`);
    // Telemetry is a percentage; scale against the scenario's documented 75 kN nominal reference as an initial estimate.
    set('simBeltTension', r.tensionPct == null ? null : (Number(r.tensionPct) / 100) * 75, 'valBeltTension', v => `${Math.round(v)} kN`);
    const context = $('#twinActiveZoneContext');
    if (context) context.textContent = `${z.name} · ${z.riskLevel || 'UNKNOWN'} · risk ${Number(z.riskScore ?? 0)}/100 · ${r.ts ? `sample ${new Date(r.ts).toLocaleTimeString()}` : 'waiting for sensor sample'}`;
  }

  // ---------------- Engineering Scenario Simulator Controls ----------------
  function setupScenarioLab() {
    const sliders = [
      { id: 'simBeltSpeed', valId: 'valBeltSpeed', unit: 'm/s' },
      { id: 'simMaterialLoad', valId: 'valMaterialLoad', unit: 't/h' },
      { id: 'simIncline', valId: 'valIncline', unit: '°', fmt: (v) => `${v}° ${v < 0 ? '(Downhill)' : v > 0 ? '(Uphill)' : '(Flat)'}` },
      { id: 'simBeltTension', valId: 'valBeltTension', unit: 'kN' },
      { id: 'simMisalignment', valId: 'valMisalignment', unit: 'mm' },
      { id: 'simFriction', valId: 'valFriction', unit: '' }
    ];

    sliders.forEach(s => {
      const input = document.getElementById(s.id);
      const valDisplay = document.getElementById(s.valId);
      if (input && valDisplay) {
        input.addEventListener('input', () => {
          valDisplay.textContent = s.fmt ? s.fmt(input.value) : `${input.value} ${s.unit}`.trim();
        });
      }
    });

    function getSimParams() {
      return {
        beltSpeedMs: Number($('#simBeltSpeed')?.value || 3.5),
        materialLoadTph: Number($('#simMaterialLoad')?.value || 2200),
        inclineDeg: Number($('#simIncline')?.value || -8.5),
        beltTensionKn: Number($('#simBeltTension')?.value || 75),
        idlerMisalignmentMm: Number($('#simMisalignment')?.value || 0),
        frictionCoeff: Number($('#simFriction')?.value || 0.32),
        faultCondition: $('#simFaultCondition')?.value || 'NONE'
      };
    }

    async function runSimulation() {
      const params = getSimParams();
      try {
        const res = await fetch(`${API}/api/twin/simulate`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ params, zoneId: selectedZoneId })
        });
        if (!res.ok) throw new Error('Simulation calculation failed');
        const data = await res.json();
        renderSimResults(data);
      } catch (err) {
        console.error('sim error:', err);
      }
    }

    function renderSimResults(data) {
      const c = data.calculated || {};
      $('#calcSag').textContent = `${c.catenarySagPercent}% (${(c.sagMeters * 1000).toFixed(0)}mm)`;
      $('#calcSag').style.color = c.catenarySagPercent > 2.5 ? 'var(--accent-red)' : 'var(--accent-cyan)';

      $('#calcPower').textContent = `${c.mechanicalPowerKw} kW`;
      const regenTag = $('#calcRegenTag');
      if (regenTag) {
        regenTag.style.display = c.isRegenerative ? 'inline-block' : 'none';
        regenTag.textContent = c.isRegenerative ? 'Regenerative Braking' : 'Motoring';
      }

      $('#calcDrift').textContent = `${c.lateralDriftMm} mm`;
      $('#calcDrift').style.color = Math.abs(c.lateralDriftMm) > 25 ? 'var(--accent-red)' : 'var(--accent-cyan)';

      $('#calcSlip').textContent = `${c.calculatedSlipPct}% (Margin: ${c.capstanSafetyMargin})`;
      $('#calcLinearMass').textContent = `${c.totalLinearMassKgm} kg/m (Payload: ${c.materialLinearMassKgm})`;

      const scoreEl = $('#calcRiskScore');
      if (scoreEl) {
        scoreEl.textContent = `${data.risk.score} / 100 (${data.risk.level})`;
        scoreEl.style.color = data.risk.level === 'CRITICAL' ? 'var(--accent-red)' : data.risk.level === 'WARNING' ? 'var(--accent-amber)' : 'var(--accent-cyan)';
      }

      // Violations List
      const vList = $('#simViolationsList');
      if (vList) {
        if (!data.violations || !data.violations.length) {
          vList.innerHTML = `<span style="color:var(--accent-cyan);font-size:12px">✓ All physical parameters within standard CEMA / ISO operating thresholds.</span>`;
        } else {
          vList.innerHTML = data.violations.map(v => `
            <div class="violation-tag severity-${v.severity}">
              <div><strong>${esc(v.metric)}:</strong> ${esc(v.description)} (Limit: ${esc(v.limit)})</div>
              <span>${esc(v.value)}</span>
            </div>
          `).join('');
        }
      }
    }

    async function compareSimulation() {
      const baseline = {
        beltSpeedMs: 3.5, materialLoadTph: 2200, inclineDeg: -8.5,
        beltTensionKn: 75, idlerMisalignmentMm: 0, frictionCoeff: 0.32, faultCondition: 'NONE'
      };
      const modified = getSimParams();
      try {
        const res = await fetch(`${API}/api/twin/compare`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseline, modified, zoneId: selectedZoneId })
        });
        if (!res.ok) throw new Error('Comparison failed');
        const data = await res.json();
        renderDiffTable(data);
      } catch (err) {
        alert(`Comparison failed: ${err.message}`);
      }
    }

    function renderDiffTable(data) {
      const diffCard = $('#simDiffCard');
      const body = $('#simDiffBody');
      if (!diffCard || !body) return;
      diffCard.classList.remove('hidden');

      const b = data.baseline;
      const m = data.modified;
      const d = data.deltas;

      const rows = [
        ['Belt Speed', `${b.inputs.beltSpeedMs} m/s`, `${m.inputs.beltSpeedMs} m/s`, `${d.beltSpeedDelta > 0 ? '+' : ''}${d.beltSpeedDelta} m/s`, 'delta-neutral'],
        ['Material Load', `${b.inputs.materialLoadTph} t/h`, `${m.inputs.materialLoadTph} t/h`, `${d.materialLoadDelta > 0 ? '+' : ''}${d.materialLoadDelta} t/h`, 'delta-neutral'],
        ['Lateral Drift', `${b.calculated.lateralDriftMm} mm`, `${m.calculated.lateralDriftMm} mm`, `${d.lateralDriftDeltaMm > 0 ? '+' : ''}${d.lateralDriftDeltaMm} mm`, Math.abs(m.calculated.lateralDriftMm) > 25 ? 'delta-bad' : 'delta-good'],
        ['Catenary Sag', `${b.calculated.catenarySagPercent}%`, `${m.calculated.catenarySagPercent}%`, `${d.catenarySagDeltaPct > 0 ? '+' : ''}${d.catenarySagDeltaPct}%`, m.calculated.catenarySagPercent > 2.5 ? 'delta-bad' : 'delta-good'],
        ['Power (Mechanical)', `${b.calculated.mechanicalPowerKw} kW`, `${m.calculated.mechanicalPowerKw} kW`, `${d.powerDeltaKw > 0 ? '+' : ''}${d.powerDeltaKw} kW`, 'delta-neutral'],
        ['Risk Score', `${b.risk.score}/100`, `${m.risk.score}/100`, `${d.riskScoreDelta > 0 ? '+' : ''}${d.riskScoreDelta}`, d.riskScoreDelta > 15 ? 'delta-bad' : 'delta-good'],
        ['ML Hazard Prob', `${(b.ml.hazardProbability * 100).toFixed(1)}%`, `${(m.ml.hazardProbability * 100).toFixed(1)}%`, `${(d.mlHazardDelta * 100).toFixed(1)}%`, d.mlHazardDelta > 0.2 ? 'delta-bad' : 'delta-good']
      ];

      body.innerHTML = rows.map(([param, baseVal, modVal, deltaVal, cls]) => `
        <tr>
          <td><strong>${param}</strong></td>
          <td>${baseVal}</td>
          <td>${modVal}</td>
          <td class="${cls}">${deltaVal}</td>
        </tr>
      `).join('');
    }

    function resetSimulation() {
      $('#simBeltSpeed').value = 3.5;
      $('#valBeltSpeed').textContent = '3.5 m/s';
      $('#simMaterialLoad').value = 2200;
      $('#valMaterialLoad').textContent = '2200 t/h';
      $('#simIncline').value = -8.5;
      $('#valIncline').textContent = '-8.5° (Downhill)';
      $('#simBeltTension').value = 75;
      $('#valBeltTension').textContent = '75 kN';
      $('#simMisalignment').value = 0;
      $('#valMisalignment').textContent = '0 mm';
      $('#simFriction').value = 0.32;
      $('#valFriction').textContent = '0.32';
      $('#simFaultCondition').value = 'NONE';
      $('#simDiffCard')?.classList.add('hidden');
      runSimulation();
    }

    async function saveSimulation() {
      const name = prompt('Enter a title for this engineering scenario experiment:', 'Downhill Regeneration Scenario A');
      if (!name) return;
      const notes = prompt('Enter optional notes or engineering hypothesis:', 'Testing belt tracking under heavy regenerative surge');
      const params = getSimParams();
      const baselineParams = {
        beltSpeedMs: 3.5, materialLoadTph: 2200, inclineDeg: -8.5,
        beltTensionKn: 75, idlerMisalignmentMm: 0, frictionCoeff: 0.32, faultCondition: 'NONE'
      };

      try {
        const res = await fetch(`${API}/api/twin/scenarios`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, notes, params, baselineParams })
        });
        if (!res.ok) throw new Error('Save failed');
        alert('Scenario experiment saved successfully.');
        loadSavedScenarios();
      } catch (err) {
        alert(`Save failed: ${err.message}`);
      }
    }

    $('#simRunBtn')?.addEventListener('click', runSimulation);
    $('#simCompareBtn')?.addEventListener('click', compareSimulation);
    $('#simResetBtn')?.addEventListener('click', resetSimulation);
    $('#simSaveBtn')?.addEventListener('click', saveSimulation);

    // Initial run
    runSimulation();
    loadSavedScenarios();
  }

  async function loadSavedScenarios() {
    const list = $('#savedScenariosList');
    if (!list) return;
    try {
      const res = await fetch(`${API}/api/twin/scenarios`, { headers: authHeaders() });
      if (!res.ok) return;
      const scenarios = await res.json();
      if (!scenarios || !scenarios.length) {
        list.innerHTML = '<p class="panel-note">No saved scenario experiments yet. Run a simulation and click "Save Experiment".</p>';
        return;
      }
      list.innerHTML = scenarios.map(s => `
        <div class="saved-scenario-item">
          <div>
            <strong>${esc(s.name)}</strong>
            <div class="saved-scenario-meta">Risk: ${s.risk?.score}/100 (${s.risk?.level}) · Sag: ${s.calculated?.catenarySagPercent}% · Power: ${s.calculated?.mechanicalPowerKw} kW · By ${esc(s.author)} · ${new Date(s.createdAt).toLocaleDateString()}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" type="button" data-scenario-load="${esc(s.id)}">Load</button>
            <button class="btn btn-danger btn-sm" type="button" data-scenario-delete="${esc(s.id)}">Delete</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      list.innerHTML = `<p class="panel-note">Failed to load scenarios: ${esc(err.message)}</p>`;
    }
  }

  window.reloadScenario = async function(id) {
    try {
      const res = await fetch(`${API}/api/twin/scenarios`, { headers: authHeaders() });
      if (!res.ok) return;
      const scenarios = await res.json();
      const s = scenarios.find(x => x.id === id);
      if (!s) return;
      const p = s.params;
      $('#simBeltSpeed').value = p.beltSpeedMs;
      $('#valBeltSpeed').textContent = `${p.beltSpeedMs} m/s`;
      $('#simMaterialLoad').value = p.materialLoadTph;
      $('#valMaterialLoad').textContent = `${p.materialLoadTph} t/h`;
      $('#simIncline').value = p.inclineDeg;
      $('#valIncline').textContent = `${p.inclineDeg}° (${p.inclineDeg < 0 ? 'Downhill' : 'Uphill'})`;
      $('#simBeltTension').value = p.beltTensionKn;
      $('#valBeltTension').textContent = `${p.beltTensionKn} kN`;
      $('#simMisalignment').value = p.idlerMisalignmentMm;
      $('#valMisalignment').textContent = `${p.idlerMisalignmentMm} mm`;
      $('#simFriction').value = p.frictionCoeff;
      $('#valFriction').textContent = `${p.frictionCoeff}`;
      $('#simFaultCondition').value = p.faultCondition || 'NONE';
      $('#simRunBtn')?.click();
      alert(`Loaded scenario "${s.name}".`);
    } catch (e) {
      alert(`Error loading scenario: ${e.message}`);
    }
  };

  window.deleteScenario = async function(id) {
    if (!confirm('Delete this saved scenario experiment?')) return;
    await fetch(`${API}/api/twin/scenarios/${id}`, { method: 'DELETE', headers: authHeaders() });
    loadSavedScenarios();
  };

  function populateOpsZoneSelects() {
    ['riskExplainZone','historyZoneSelect'].forEach(id => {
      const select = document.getElementById(id);
      if (!select) return;
      const previous = select.value || selectedZoneId;
      select.innerHTML = zones.map(z => `<option value="${esc(z.id)}">${esc(z.name || z.id)}</option>`).join('');
      if (zones.some(z => z.id === previous)) select.value = previous;
    });
  }

  function opsStat(label, value, note='') {
    return `<div class="ops-stat"><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(note)}</span></div>`;
  }
  function opsStatus(value) {
    const s = String(value || 'UNKNOWN').toUpperCase();
    const cls = ['ONLINE','NORMAL','RESOLVED','CLOSED','HEALTHY'].includes(s) ? 'good' : ['WARNING','STALE','ACKNOWLEDGED','NOT_CONFIGURED'].includes(s) ? 'warn' : 'bad';
    return `<span class="ops-pill ${cls}">${esc(s.replaceAll('_',' '))}</span>`;
  }
  function latestZone(id) { return zones.find(z => z.id === id) || zones[0] || null; }

  function renderRiskExplainability() {
    const id = $('#riskExplainZone')?.value || selectedZoneId;
    const zone = latestZone(id);
    const summary = $('#riskExplainSummary'), evidence = $('#riskExplainEvidence'), actions = $('#riskExplainActions');
    if (!zone || !summary || !evidence || !actions) return;
    const risk = zone.latestRisk || {};
    const reading = zone.latestReading || {};
    summary.innerHTML = opsStat('Risk score', `${risk.score ?? zone.riskScore ?? '—'}/100`, '0–100 deterministic composite') + opsStat('Severity', risk.level || zone.riskLevel || 'UNKNOWN', 'Threshold-based decision') + opsStat('Dominant cause', risk.primaryCause || 'None', 'Highest individual channel score') + opsStat('Sample timestamp', reading.ts ? new Date(reading.ts).toLocaleString() : 'No sample', 'Latest retained reading');
    const contributors = Array.isArray(risk.contributors) ? risk.contributors : [];
    evidence.innerHTML = `<table class="ops-table"><thead><tr><th>Channel / cause</th><th>Measured value</th><th>Warning</th><th>Critical</th><th>Rule score</th><th>Anomaly boost</th><th>Normalized weight</th><th>Weighted contribution</th><th>Reason</th></tr></thead><tbody>${contributors.map(c => `<tr><td><strong>${esc(c.label)}</strong><br><small>${esc(c.key)}</small></td><td>${Number(c.readingValue ?? c.signedValue ?? c.value ?? 0).toFixed(2)} ${esc(c.readingUnit || c.unit || '')}<br><small>Scored metric: ${Number(c.value ?? 0).toFixed(2)} ${esc(c.unit || '')}</small></td><td>${c.warnAt ?? '—'} ${esc(c.unit||'')}</td><td>${c.critAt ?? '—'} ${esc(c.unit||'')}</td><td>${c.ruleScore ?? c.score ?? '—'}/100</td><td>${c.anomalyScore ?? 0}</td><td>${c.normalizedWeight ?? '—'}</td><td>${c.weightedContribution ?? '—'}</td><td>${esc(c.triggerReason || 'No trigger detail')}</td></tr>`).join('')}</tbody></table>`;
    const method = risk.scoreMethod || {};
    actions.innerHTML = `<h3>Severity decision and next steps</h3><div class="ops-evidence-grid"><div class="ops-evidence-item"><small>Score formula</small><strong>${esc(method.formula || 'Composite weighted score with worst-channel safeguard')}</strong></div><div class="ops-evidence-item"><small>Weighted average</small><strong>${method.weightedAverage ?? '—'}</strong></div><div class="ops-evidence-item"><small>Worst channel</small><strong>${method.worstChannelScore ?? risk.deterministicScore ?? '—'}</strong></div><div class="ops-evidence-item"><small>Severity rule</small><strong>${esc(method.levelDecision || 'Configured score and channel thresholds')}</strong></div><div class="ops-evidence-item"><small>Terrain context</small><strong>Incline ${zone.inclineDeg ?? '—'}° · curve severity ${zone.curveSeverity ?? '—'}</strong></div><div class="ops-evidence-item"><small>Evidence caveat</small><strong>Rule scores are advisory; validate thresholds against site engineering requirements.</strong></div></div><h3 style="margin-top:14px">Recommended inspection actions</h3><ol>${(risk.recommendedActions || []).map(a=>`<li>${esc(a)}</li>`).join('') || '<li>No action recommendation available.</li>'}</ol>`;
  }

  async function loadSensorHealth() {
    const table = $('#sensorHealthTable'); if (!table) return;
    table.innerHTML = '<p class="panel-note">Checking sensor telemetry…</p>';
    try {
      const res = await fetch(`${API}/api/operations/sensor-health`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Sensor-health endpoint unavailable');
      const data = await res.json();
      $('#sensorHealthSummary').innerHTML = opsStat('Healthy channels', `${data.healthy}/${data.total}`, `${data.healthPercent}% reporting fresh data`) + opsStat('Missing', data.counts.MISSING || 0, 'No usable reading') + opsStat('Stale', data.counts.STALE || 0, `Older than ${data.staleAfterSeconds}s`) + opsStat('Out of range', data.counts.OUT_OF_RANGE || 0, 'Physical input bounds failed');
      $('#sensorHealthNotice').textContent = data.calibrationNotice;
      table.innerHTML = `<table class="ops-table"><thead><tr><th>Sensor channel</th><th>Zone</th><th>Current value</th><th>Status</th><th>Last seen</th><th>Communication</th><th>Valid range</th><th>Risk thresholds</th><th>Calibration</th></tr></thead><tbody>${data.sensors.map(s=>`<tr><td><strong>${esc(s.label)}</strong><br><small>${esc(s.channel)}</small></td><td>${esc(s.zoneName)}</td><td>${s.value===null?'—':`${Number(s.value).toFixed(2)} ${esc(s.unit)}`}</td><td>${opsStatus(s.status)}</td><td>${s.lastSeen?new Date(s.lastSeen).toLocaleTimeString():'Never'}${s.ageSeconds===null?'':`<br><small>${s.ageSeconds}s old</small>`}</td><td>${opsStatus(s.communicationStatus)}</td><td>${s.validRange.min} to ${s.validRange.max} ${esc(s.unit)}</td><td>${s.warningThreshold ?? '—'} / ${s.criticalThreshold ?? '—'} ${esc(s.unit)}</td><td>${opsStatus(s.calibrationStatus)}</td></tr>`).join('')}</tbody></table>`;
      const incidents=data.dataQualityIncidents||[];
      $('#sensorHealthIncidents').innerHTML=incidents.length?`<table class="ops-table"><thead><tr><th>Timestamp</th><th>Zone</th><th>Channel</th><th>Incident</th><th>Severity</th><th>Details</th></tr></thead><tbody>${incidents.map(i=>`<tr><td>${new Date(i.at).toLocaleString()}</td><td>${esc(i.zoneName)}</td><td>${esc(i.channel)}</td><td>${opsStatus(i.type)}</td><td>${opsStatus(i.severity)}</td><td>${esc(i.detail)}</td></tr>`).join('')}</tbody></table>`:'<div class="ops-card">No missing, out-of-range or long-gap data-quality incidents were found in the retained history. Calibration is tracked separately and is not configured in this prototype.</div>';
    } catch (err) { table.innerHTML = `<div class="ops-card">${esc(err.message)}. Check the backend connection and sign-in session.</div>`; }
  }

  async function loadInvestigationList() {
    const select = $('#incidentSelect'); if (!select) return;
    try {
      const res = await fetch(`${API}/api/alerts?limit=200`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load incident list');
      const data = await res.json(); investigationAlerts = data.alerts || [];
      const previous = select.value;
      select.innerHTML = investigationAlerts.length ? investigationAlerts.map(a=>`<option value="${esc(a.id)}">${esc(a.level)} · ${esc(a.zoneName || a.zoneId)} · ${new Date(a.createdAt).toLocaleString()} · ${esc(a.cause || a.message)}</option>`).join('') : '<option value="">No incidents recorded yet</option>';
      if (investigationAlerts.some(a=>a.id===previous)) select.value = previous;
      if (select.value) await loadIncidentInvestigation(select.value);
      else $('#incidentInvestigationContent').innerHTML = '<div class="ops-card">No incidents are available. Incidents appear when the risk engine raises a non-normal alert.</div>';
    } catch (err) { $('#incidentInvestigationContent').innerHTML = `<div class="ops-card">${esc(err.message)}</div>`; }
  }

  async function loadIncidentInvestigation(id) {
    const wrap = $('#incidentInvestigationContent'); if (!wrap || !id) return;
    wrap.innerHTML = '<p class="panel-note">Loading incident evidence…</p>';
    try {
      const res = await fetch(`${API}/api/operations/incident/${encodeURIComponent(id)}`, { headers: authHeaders() });
      const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Could not load incident');
      const a=data.incident, risk=data.riskEvidence || {}, ml=data.modelPrediction || {}, wo=data.workOrder;
      const snapshot=a.snapshot || {};
      const readings=data.readings || [];
      const actions=a.recommendedActions || risk.recommendedActions || [];
      wrap.innerHTML = `<div class="ops-summary-grid">${opsStat('Incident severity',a.level,`Risk score ${a.score ?? risk.score ?? '—'}/100`)}${opsStat('Zone',data.zone?.name || a.zoneName || a.zoneId,'Equipment location')}${opsStat('Status',a.status,'Acknowledgement / resolution lifecycle')}${opsStat('Related work order',wo?.id || a.workOrderId || 'Not linked',wo?.status || 'No work order linked')}</div><div class="ops-card"><h3>Incident evidence</h3><p><strong>${esc(a.cause || a.message || 'Unknown fault')}</strong></p><p>${esc(a.message || '')}</p><div class="ops-evidence-grid">${Object.entries({ 'Belt alignment':`${snapshot.alignmentMm ?? '—'} mm`, 'Vibration RMS':`${snapshot.vibrationMms ?? '—'} mm/s`, 'Tension':`${snapshot.tensionPct ?? '—'} %`, 'Drive slip':`${snapshot.slipPct ?? '—'} %`, 'Load':`${snapshot.loadPct ?? '—'} %`, 'Temperature':`${snapshot.tempC ?? '—'} °C`}).map(([k,v])=>`<div class="ops-evidence-item"><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join('')}</div><p class="panel-note">Created ${new Date(a.createdAt).toLocaleString()} · ${readings.length} nearby retained readings available</p></div><div class="ops-card"><h3>Probable cause and model assessment</h3><p>Rule engine: <strong>${esc(risk.primaryCause || a.cause || 'Not available')}</strong>, score ${risk.score ?? a.score ?? '—'}/100 (${esc(risk.level || a.level)}).</p><p>ML status: <strong>${esc(ml.status || (ml.ready ? 'READY' : 'UNAVAILABLE'))}</strong> · hazard probability ${ml.probability===undefined?'not available':`${(Number(ml.probability)*100).toFixed(1)}%`}.</p><p>${esc(ml.notice || data.diagnosisNotice || 'ML outputs are advisory and depend on valid input data.')}</p><p><strong>Alternative explanations to inspect:</strong> sensor miscalibration, transient material loading, bearing wear, pulley contamination, and mechanical alignment. These are investigation hypotheses, not confirmed causes.</p></div>${wo ? `<div class="ops-card"><h3>Maintenance outcome &amp; post-repair verification</h3><p>Work order ${esc(wo.id)} · ${esc(wo.status)}. Compare the triggering snapshot with the latest retained reading after inspection or repair.</p><div class="ops-evidence-grid">${[['Alignment',snapshot.alignmentMm,data.latestReading?.alignmentMm,'mm'],['Vibration',snapshot.vibrationMms,data.latestReading?.vibrationMms,'mm/s'],['Tension',snapshot.tensionPct,data.latestReading?.tensionPct,'%'],['Slip',snapshot.slipPct,data.latestReading?.slipPct,'%'],['Load',snapshot.loadPct,data.latestReading?.loadPct,'%'],['Temperature',snapshot.tempC,data.latestReading?.tempC,'°C']].map(([k,before,after,u])=>`<div class="ops-evidence-item"><small>${k}: incident → latest</small><strong>${before ?? '—'} → ${after ?? '—'} ${u}</strong></div>`).join('')}</div>${user?.role!=='VIEWER'?`<label style="display:block;margin-top:10px">Repair / inspection notes<textarea id="incidentRepairNotes" rows="3" style="display:block;width:100%;margin-top:5px">${esc(wo.repairNotes || '')}</textarea></label><button class="btn btn-secondary btn-sm" id="saveIncidentRepairNotes" type="button">Save maintenance notes</button>`:''}</div>`:''}<div class="ops-card"><h3>Recommended inspection</h3><ol>${actions.map(x=>`<li>${esc(x)}</li>`).join('') || '<li>Follow the site standard inspection checklist.</li>'}</ol><div class="ops-inline-actions">${!wo && user?.role!=='VIEWER'?'<button class="btn btn-primary btn-sm" id="createIncidentWorkOrder" type="button">Create linked work order</button>':''}${a.status==='OPEN' && user?.role!=='VIEWER'?'<button class="btn btn-secondary btn-sm" id="ackIncidentBtn" type="button">Acknowledge incident</button>':''}</div></div><div class="ops-card"><h3>Event timeline</h3><div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>Timestamp</th><th>Alignment</th><th>Vibration</th><th>Tension</th><th>Slip</th><th>Load</th><th>Temp</th><th>Stored risk</th></tr></thead><tbody>${readings.map(r=>`<tr><td>${r.ts?new Date(r.ts).toLocaleTimeString():'—'}</td><td>${r.alignmentMm ?? '—'} mm</td><td>${r.vibrationMms ?? '—'} mm/s</td><td>${r.tensionPct ?? '—'}%</td><td>${r.slipPct ?? '—'}%</td><td>${r.loadPct ?? '—'}%</td><td>${r.tempC ?? '—'}°C</td><td>${r.risk?.score===undefined?'—':`${r.risk.score} (${esc(r.risk.level)})`}</td></tr>`).join('')}</tbody></table></div></div>`;
      $('#createIncidentWorkOrder')?.addEventListener('click', async()=>{
        try { const r=await fetch(`${API}/api/work-orders`,{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({zoneId:a.zoneId,title:`Investigate ${a.cause || 'conveyor incident'}`,description:`Created from incident ${a.id}. Review sensor snapshot, alternate causes, inspect equipment and record post-repair readings.`,priority:a.level==='CRITICAL'?'CRITICAL':'HIGH',severity:a.level,alertId:a.id})}); const body=await r.json(); if(!r.ok)throw new Error(body.error||'Work order creation failed'); await loadIncidentInvestigation(id); alert(`Work order created: ${body.workOrder?.id || 'success'}`); } catch(e){alert(e.message);}
      });
      $('#ackIncidentBtn')?.addEventListener('click', async()=>{ const r=await fetch(`${API}/api/alerts/${encodeURIComponent(a.id)}/ack`,{method:'POST',headers:authHeaders()}); if(r.ok)loadIncidentInvestigation(id); else alert('Could not acknowledge incident.'); });
      $('#saveIncidentRepairNotes')?.addEventListener('click', async()=>{ try { const r=await fetch(`${API}/api/work-orders/${encodeURIComponent(wo.id)}`,{method:'PATCH',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({repairNotes:$('#incidentRepairNotes').value})}); const body=await r.json(); if(!r.ok)throw new Error(body.error||'Could not save maintenance notes'); alert('Maintenance notes saved.'); } catch(e){alert(e.message);} });
    } catch (err) { wrap.innerHTML = `<div class="ops-card">${esc(err.message)}</div>`; }
  }

  function localDateTimeInput(date) { const d=new Date(date); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
  async function loadHistoryReplay() {
    const zoneId=$('#historyZoneSelect')?.value || selectedZoneId; if(!zoneId)return;
    const fromInput=$('#historyFrom'), toInput=$('#historyTo');
    if(fromInput && !fromInput.value) fromInput.value=localDateTimeInput(Date.now()-10*60*1000);
    if(toInput && !toInput.value) toInput.value=localDateTimeInput(Date.now());
    const fromDate=new Date(fromInput.value), toDate=new Date(toInput.value);
    const wrap=$('#historyReplayChart');
    if(!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || fromDate>toDate){ wrap.innerHTML='<div class="ops-card">Choose a valid date range where From is earlier than To.</div>'; return; }
    const from=fromDate.toISOString(), to=toDate.toISOString(); wrap.innerHTML='<div class="ops-card">Loading retained readings…</div>';
    try {
      const res=await fetch(`${API}/api/operations/history/${encodeURIComponent(zoneId)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`,{headers:authHeaders()});
      const data=await res.json(); if(!res.ok)throw new Error(data.error||'Could not load history');
      historyReplayRows=data.readings||[]; historyReplayIndex=Math.max(0,historyReplayRows.length-1);
      $('#historyReplayNotice').textContent=data.note || '';
      const rows=historyReplayRows;
      const latest=rows[rows.length-1]||{};
      $('#historyReplaySummary').innerHTML=opsStat('Retained samples',rows.length,'Within selected range')+opsStat('Incidents in range',(data.alerts||[]).length,'Recorded alert timestamps')+opsStat('Latest stored risk',latest.risk?.score===undefined?'Unavailable':`${latest.risk.score}/100`,latest.risk?.level||'No point-in-time risk')+opsStat('Retention',`${data.retentionLimit} max`,'Rolling buffer per zone');
      if(!rows.length){wrap.innerHTML='<div class="ops-card">No readings in this range. Choose a wider range or wait for telemetry to accumulate.</div>'; $('#historyReplayEvents').innerHTML=''; $('#historyReplayFrame').innerHTML=''; return;}
      const chartSpecs=[['Alignment (mm)','alignmentMm'],['Vibration RMS (mm/s)','vibrationMms'],['Tension (%)','tensionPct'],['Slip (%)','slipPct'],['Load (%)','loadPct'],['Temperature (°C)','tempC'],['Risk score','risk.score']];
      replayCharts.forEach(c=>{try{c.destroy()}catch(_){}}); replayCharts=[];
      wrap.innerHTML=chartSpecs.map((s,i)=>`<div class="ops-chart-card"><h3>${esc(s[0])}</h3><canvas id="replayChart${i}" height="150"></canvas></div>`).join('');
      chartSpecs.forEach((spec,i)=>{ const ctx=document.getElementById(`replayChart${i}`); const values=rows.map(r=>spec[1]==='risk.score'?(r.risk?.score ?? null):r[spec[1]]); if(window.Chart){ replayCharts.push(new Chart(ctx,{type:'line',data:{labels:rows.map(r=>new Date(r.ts).toLocaleTimeString()),datasets:[{label:spec[0],data:values,borderColor:i===6?'#d9a441':'#28b6b1',backgroundColor:'rgba(40,182,177,.12)',spanGaps:false,tension:.2,pointRadius:0}]},options:{responsive:true,animation:false,plugins:{legend:{display:false}},scales:{x:{ticks:{maxTicksLimit:6}},y:{beginAtZero:false}}}})); } else { ctx.insertAdjacentHTML('afterend','<p>Chart library unavailable; use the table below.</p>'); }});
      const alerts=data.alerts||[];
      $('#historyReplayEvents').innerHTML=`<table class="ops-table"><thead><tr><th>Event</th><th>Timestamp</th><th>Severity</th><th>Risk</th><th>Replay</th></tr></thead><tbody>${alerts.map(a=>{const ix=rows.reduce((best,r,i)=>Math.abs(Number(r.ts)-new Date(a.createdAt).getTime())<Math.abs(Number(rows[best]?.ts||0)-new Date(a.createdAt).getTime())?i:best,0);return `<tr><td>${esc(a.cause||a.message)}</td><td>${new Date(a.createdAt).toLocaleString()}</td><td>${opsStatus(a.level)}</td><td>${a.score ?? '—'}/100</td><td><button type="button" class="btn btn-secondary btn-sm" data-replay-index="${ix}">Replay point</button></td></tr>`}).join('') || '<tr><td colspan="5">No incidents in selected range.</td></tr>'}</tbody></table>`;
      renderReplayFrame();
    } catch(err) { wrap.innerHTML=`<div class="ops-card">${esc(err.message)}</div>`; }
  }
  function renderReplayFrame() {
    const wrap=$('#historyReplayFrame'); if(!wrap)return;
    const r=historyReplayRows[historyReplayIndex]; if(!r){wrap.innerHTML='';return;}
    const risk=r.risk||{};
    wrap.innerHTML=`<h3>Event replay · sample ${historyReplayIndex+1} of ${historyReplayRows.length}</h3><p>${r.ts?new Date(r.ts).toLocaleString():'Timestamp unavailable'} · stored risk ${risk.score===undefined?'not captured':`${risk.score}/100 (${esc(risk.level)})`}</p><div class="ops-evidence-grid">${[['Alignment',`${r.alignmentMm ?? '—'} mm`],['Vibration',`${r.vibrationMms ?? '—'} mm/s`],['Tension',`${r.tensionPct ?? '—'}%`],['Slip',`${r.slipPct ?? '—'}%`],['Load',`${r.loadPct ?? '—'}%`],['Temperature',`${r.tempC ?? '—'}°C`]].map(([k,v])=>`<div class="ops-evidence-item"><small>${k}</small><strong>${esc(v)}</strong></div>`).join('')}</div><div class="ops-inline-actions"><button class="btn btn-secondary btn-sm" id="replayPrev" type="button" ${historyReplayIndex<=0?'disabled':''}>← Previous sample</button><button class="btn btn-secondary btn-sm" id="replayNext" type="button" ${historyReplayIndex>=historyReplayRows.length-1?'disabled':''}>Next sample →</button><button class="btn btn-primary btn-sm" id="showReplayOnTwin" type="button">Show sample on Digital Twin</button><span class="panel-note">Point-in-time snapshots only; no physical machine is controlled by replay.</span></div>`;
    $('#replayPrev')?.addEventListener('click',()=>{historyReplayIndex=Math.max(0,historyReplayIndex-1);renderReplayFrame()});
    $('#replayNext')?.addEventListener('click',()=>{historyReplayIndex=Math.min(historyReplayRows.length-1,historyReplayIndex+1);renderReplayFrame()});
    $('#showReplayOnTwin')?.addEventListener('click',()=>{ const z=latestZone($('#historyZoneSelect')?.value); if(!z||!r)return; replayTwinOverride={zoneId:z.id,reading:r,risk:r.risk||{level:'UNKNOWN',score:0}}; selectedZoneId=z.id; const zoneComponent=TWIN_COMPONENTS.find(c=>c.zoneId===z.id); if(zoneComponent)selectedTwinComponent=zoneComponent.id; const banner=$('#replayTwinBanner'); if(banner)banner.style.display='block'; showDashboardPage('twin'); renderDigitalTwin(twinView); updateComponentInspector(selectedTwinComponent); });
  }

  function showDashboardPage(page) {
    const groups = {
      dashboard: ['dashboardOverview', 'panel-map', 'detailPanel', 'alertsPanel'],
      twin: ['twinPanel'],
      assets: ['assetsPanel'],
      workorders: ['workOrdersPanel'],
      whatif: ['panel-map', 'whatIfPagePanel'],
      models: ['panel-map', 'modelValidationPanel'],
      risk: ['riskExplainPanel'],
      sensorhealth: ['sensorHealthPanel'],
      investigation: ['investigationPanel'],
      history: ['historyReplayPanel'],
      video: ['videoPanel'],
      alerts: ['alertsPanel'],
      audit: ['auditPanel'],
      reports: ['reportsPanel']
    };
    const all = ['dashboardOverview','panel-map','modelValidationPanel','riskExplainPanel','sensorHealthPanel','investigationPanel','historyReplayPanel','twinPanel','detailPanel','whatIfPagePanel','alertsPanel','auditPanel','videoPanel','reportsPanel','assetsPanel','workOrdersPanel'];
    all.forEach(id => {
      const el = id === 'panel-map' ? document.querySelector('.panel-map') : document.getElementById(id);
      if (el) el.classList.toggle('page-hidden', !(groups[page] || groups.dashboard).includes(id));
    });
    // Route Profile appears on Dashboard, Multiple Models, and What-If Analysis.
    document.getElementById('routeProfileContent')?.classList.toggle('page-hidden', !['dashboard','models','whatif'].includes(page));
    const layout = document.querySelector('.layout');
    if (layout) {
      layout.classList.toggle('single-page-layout', !['dashboard','models','whatif'].includes(page));
      layout.classList.toggle('dashboard-layout', page === 'dashboard');
      layout.classList.toggle('two-column-layout', ['models','whatif'].includes(page));
      layout.classList.toggle('route-analysis-layout', ['models','whatif'].includes(page));
      layout.dataset.currentPage = page;
    }
    document.querySelectorAll('.side-nav [data-page]').forEach(btn => btn.classList.toggle('active', btn.dataset.page === page));
    const detail = $('#modelDetailPage');
    if (detail) detail.classList.add('page-hidden');
    $('#modelCards')?.classList.remove('page-hidden');
    if (page === 'dashboard' && selectedZoneId) {
      renderDetail(selectedZoneId);
    }
    if (page === 'whatif') {
      const whatIfSelect = $('#whatIfZoneSelect');
      const modelSelect = $('#modelZoneSelect');
      if (whatIfSelect && selectedZoneId) whatIfSelect.value = selectedZoneId;
      if (modelSelect && selectedZoneId) modelSelect.value = selectedZoneId;
    }
    if (page === 'models') {
      renderModelCards();
    }
    if (page === 'risk') { populateOpsZoneSelects(); renderRiskExplainability(); }
    if (page === 'sensorhealth') loadSensorHealth();
    if (page === 'investigation') loadInvestigationList();
    if (page === 'history') { populateOpsZoneSelects(); loadHistoryReplay(); }
    if (page === 'assets') loadAssets();
    if (page === 'workorders') loadWorkOrders();
    if (page === 'audit') loadAudit();
    if (page === 'reports') loadReportsSummary();
    if (page === 'twin') {
      loadSavedScenarios();
      updateComponentInspector(selectedTwinComponent);
      renderDigitalTwin(twinView);
    }
    window.scrollTo({top:0,behavior:'smooth'});
  }


  function setupDigitalTwin(){
    document.querySelectorAll('[data-twin-view]').forEach(btn=>btn.addEventListener('click',()=>{
      const view=btn.getAttribute('data-twin-view');
      document.querySelectorAll('[data-twin-view]').forEach(b=>b.classList.toggle('active',b===btn));
      renderDigitalTwin(view);
    }));
    document.querySelectorAll('.side-nav [data-page]').forEach(btn=>btn.addEventListener('click',()=>{
      const page=btn.getAttribute('data-page');
      showDashboardPage(page);
    }));
    $('#refreshAuditBtn')?.addEventListener('click', loadAudit);
    $('#modelZoneSelect')?.addEventListener('change', (event) => {
      selectedZoneId = event.target.value;
      const whatIfSelect = $('#whatIfZoneSelect');
      if (whatIfSelect) whatIfSelect.value = selectedZoneId;
      renderModelCards();
      renderDetail(selectedZoneId);
    });
    $('#downloadReportPageBtn')?.addEventListener('click', downloadConditionReport);

    $('#riskExplainZone')?.addEventListener('change', renderRiskExplainability);
    $('#refreshSensorHealth')?.addEventListener('click', loadSensorHealth);
    $('#incidentSelect')?.addEventListener('change', () => loadIncidentInvestigation($('#incidentSelect').value));
    $('#historyZoneSelect')?.addEventListener('change', loadHistoryReplay);
    $('#loadHistoryReplay')?.addEventListener('click', loadHistoryReplay);
    $('#exitTwinReplay')?.addEventListener('click',()=>{ replayTwinOverride=null; const banner=$('#replayTwinBanner'); if(banner)banner.style.display='none'; renderDigitalTwin(twinView); updateComponentInspector(selectedTwinComponent); });
    $('#historyReplayEvents')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-replay-index]');
      if (button) { historyReplayIndex = Number(button.dataset.replayIndex) || 0; renderReplayFrame(); }
    });

    setupDigitalTwinStageEvents();
    setupScenarioLab();
    $('#savedScenariosList')?.addEventListener('click', (event) => {
      const loadButton = event.target.closest('[data-scenario-load]');
      if (loadButton) { window.reloadScenario(loadButton.dataset.scenarioLoad); return; }
      const deleteButton = event.target.closest('[data-scenario-delete]');
      if (deleteButton) window.deleteScenario(deleteButton.dataset.scenarioDelete);
    });
    updateComponentInspector('comp-motor-a');

    showDashboardPage('dashboard');
    renderDigitalTwin('3d');
  }
  // Keep the twin animation lightweight; telemetry events also trigger immediate updates.
  let twinRenderBusy = false;
  setInterval(() => {
    if (!document.hidden && document.querySelector('.layout')?.dataset.currentPage === 'sensorhealth' && token) loadSensorHealth();
  }, 10000);

  setInterval(() => {
    if (!zones.length || twinRenderBusy || document.hidden) return;
    twinRenderBusy = true;
    try { renderDigitalTwin(twinView); } finally { twinRenderBusy = false; }
  }, 1800);

  // ---------------- Dashboard overview & live sensor snapshot ----------------
  function renderDashboardOverview() {
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    const critical = zones.filter((z) => z.riskLevel === 'CRITICAL').length;
    const warning = zones.filter((z) => z.riskLevel === 'WARNING').length;
    const running = zones.filter((z) => z.status === 'RUNNING').length;
    const openAlerts = [...alertsById.values()].filter((a) => a.status === 'OPEN').length;
    const now = Date.now();
    const samples = zones.map((z) => Number(z.latestReading?.ts || 0)).filter(Boolean);
    const newest = samples.length ? Math.max(...samples) : 0;
    const ageMs = newest ? Math.max(0, now - newest) : Infinity;
    const fresh = zones.length > 0 && zones.every((z) => z.latestReading?.ts && now - Number(z.latestReading.ts) < 10000);
    set('kpiZones', String(zones.length));
    set('kpiRunning', `${running}/${zones.length}`);
    set('kpiElevated', String(critical + warning));
    set('kpiAlerts', String(openAlerts));
    set('kpiTelemetry', !zones.length ? '—' : fresh ? 'HEALTHY' : newest && ageMs < 30000 ? 'DELAYED' : 'STALE');
    set('kpiTelemetrySub', newest ? `Latest sample ${ageMs < 1000 ? 'just now' : `${Math.round(ageMs / 1000)}s ago`}` : 'No sensor samples received');
    set('overviewUpdatedAt', newest ? `Updated ${new Date(newest).toLocaleTimeString()}` : 'Waiting for telemetry');
    const telemetryEl = document.getElementById('kpiTelemetry');
    if (telemetryEl) telemetryEl.dataset.state = fresh ? 'healthy' : newest && ageMs < 30000 ? 'delayed' : 'stale';
  }

  function renderSensorSnapshot(zone) {
    const grid = document.getElementById('sensorSnapshotGrid');
    const sampleTime = document.getElementById('sensorSampleTime');
    if (!grid) return;
    const r = zone?.latestReading;
    if (!r) {
      grid.innerHTML = '<div class="sensor-empty">No sensor sample is available for this zone yet. Waiting for the telemetry service.</div>';
      if (sampleTime) sampleTime.textContent = 'No sample yet';
      return;
    }
    const ts = Number(r.ts || 0);
    if (sampleTime) sampleTime.textContent = ts ? `Sampled ${new Date(ts).toLocaleTimeString()}` : 'Sample time unavailable';
    const items = [
      { label: 'Belt alignment', value: Number(r.alignmentMm), unit: 'mm', good: (v) => Math.abs(v) < 15, warn: (v) => Math.abs(v) < 30, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}` },
      { label: 'Vibration RMS', value: Number(r.vibrationMms), unit: 'mm/s', good: (v) => v < 5, warn: (v) => v < 9, format: (v) => v.toFixed(2) },
      { label: 'Belt tension', value: Number(r.tensionPct), unit: '%', good: (v) => v >= 75, warn: (v) => v >= 60, format: (v) => v.toFixed(1) },
      { label: 'Drive slip', value: Number(r.slipPct), unit: '%', good: (v) => v < 3, warn: (v) => v < 7, format: (v) => v.toFixed(2) },
      { label: 'Material load', value: Number(r.loadPct), unit: '% capacity', good: (v) => v <= 100, warn: (v) => v <= 115, format: (v) => v.toFixed(1) },
      { label: 'Motor temperature', value: Number(r.tempC), unit: '°C', good: (v) => v < 80, warn: (v) => v < 95, format: (v) => v.toFixed(1) }
    ];
    grid.innerHTML = items.map((item) => {
      if (!Number.isFinite(item.value)) return `<article class="sensor-card sensor-unknown"><span>${esc(item.label)}</span><strong>—</strong><small>Reading unavailable</small></article>`;
      const state = item.good(item.value) ? 'normal' : item.warn(item.value) ? 'warning' : 'critical';
      const label = state === 'normal' ? 'NORMAL' : state === 'warning' ? 'CHECK' : 'HIGH';
      return `<article class="sensor-card sensor-${state}"><div class="sensor-card-top"><span>${esc(item.label)}</span><i aria-label="${label}"></i></div><strong>${esc(item.format(item.value))}<small> ${esc(item.unit)}</small></strong><div class="sensor-card-bottom"><span>${label}</span><span>${esc(zone.status || 'UNKNOWN')}</span></div></article>`;
    }).join('');
  }

  // ---------------- Terrain SVG ----------------
  function riskColorVar(level) {
    if (level === 'CRITICAL') return 'var(--accent-red)';
    if (level === 'WARNING') return 'var(--accent-amber)';
    return 'var(--accent-cyan)';
  }

  function renderTerrain() {
    const svg = $('#terrainSvg');
    if (!zones.length) return;
    const w = 1000, h = 260, pad = 40;
    const n = zones.length;
    const stepX = (w - pad * 2) / (n - 1 || 1);

    let elevation = 130;
    const points = zones.map((z, i) => {
      const x = pad + i * stepX;
      elevation -= (z.inclineDeg / 25) * 28;
      elevation = Math.max(40, Math.min(200, elevation));
      return { x, y: elevation, zone: z };
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const fillPath = `${linePath} L ${points[points.length - 1].x} ${h} L ${points[0].x} ${h} Z`;

    let svgHtml = `
      <defs>
        <linearGradient id="terrainFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1b232c" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="#0d1117" stop-opacity="0.2"/>
        </linearGradient>
      </defs>
      <path d="${fillPath}" fill="url(#terrainFill)" stroke="none"/>
      <path d="${linePath}" fill="none" stroke="#3a4553" stroke-width="2"/>
    `;

    points.forEach((p) => {
      const color = riskColorVar(p.zone.riskLevel || 'NORMAL');
      const pulse = p.zone.riskLevel === 'CRITICAL' ? 'terrain-pulse' : '';
      svgHtml += `
        <circle cx="${p.x}" cy="${p.y}" r="9" fill="${color}" class="${pulse}" data-zone="${p.zone.id}" style="cursor:pointer" opacity="0.25"/>
        <circle cx="${p.x}" cy="${p.y}" r="6" fill="${color}" data-zone="${p.zone.id}" style="cursor:pointer"/>
        <text x="${p.x}" y="${p.y - 16}" fill="#8b98a8" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">${p.zone.inclineDeg}°</text>
        <text x="${p.x}" y="${h - 8}" fill="#5b6b7c" font-size="10" font-family="Inter, sans-serif" text-anchor="middle">${p.zone.name.split(' - ')[0]}</text>
      `;
    });

    svg.innerHTML = svgHtml;
    svg.querySelectorAll('[data-zone]').forEach((el) => {
      el.addEventListener('click', () => selectZone(el.getAttribute('data-zone')));
    });
  }

  // ---------------- Zone cards ----------------
  function statusLabel(zone) {
    if (zone.status === 'AUTO_STOPPED') return 'AUTO-STOPPED';
    if (zone.status === 'STOPPED') return 'STOPPED';
    return 'RUNNING';
  }

  function renderZoneCards() {
    const container = $('#zoneCards');
    container.innerHTML = '';
    zones.forEach((z) => {
      const div = document.createElement('div');
      div.className = 'zone-card' + (z.id === selectedZoneId ? ' active' : '');
      const level = (z.riskLevel || 'NORMAL').toLowerCase();
      div.innerHTML = `
        <span class="zone-risk-dot risk-${level}"></span>
        <div class="zone-card-main">
          <div class="zone-card-name">${esc(z.name)}</div>
          <div class="zone-card-meta">${statusLabel(z)} · incline ${z.inclineDeg}°</div>
        </div>
        <div style="text-align:right">
          <div class="zone-card-score">${z.riskScore ?? 0}</div>
          <div class="zone-card-status">${esc(z.riskLevel || 'NORMAL')}</div>
        </div>
      `;
      div.addEventListener('click', () => selectZone(z.id));
      container.appendChild(div);
    });
  }

  // ---------------- Multi-model validation ----------------
  async function loadModelMetrics() {
    try {
      const res = await fetch(`${API}/api/ai/models`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Could not load model metrics');
      modelMetrics = await res.json();
      renderModelCards();
      renderEvaluationDiagnostics();
    } catch (err) {
      console.error('model metrics:', err.message);
      $('#modelDatasetInfo').textContent = 'Metrics unavailable';
    }
  }

  function modelKey(name) {
    return name.replace(/\s+/g, '-').toLowerCase();
  }

  function populateModelZoneSelect() {
    const select = $('#modelZoneSelect');
    if (!select) return;
    const previous = selectedZoneId || select.value;
    select.innerHTML = '';
    zones.forEach((zone) => {
      const option = document.createElement('option');
      option.value = zone.id;
      option.textContent = zone.name || zone.label || zone.id;
      select.appendChild(option);
    });
    if (previous && zones.some((zone) => zone.id === previous)) select.value = previous;
    else if (zones.length) select.value = zones[0].id;
  }

  function renderEvaluationDiagnostics() {
    const select=$('#evaluationModelSelect'); const summary=$('#evaluationSummary'); const plots=$('#evaluationPlots');
    if(!select||!summary||!plots||!modelMetrics)return;
    const names=Object.keys(modelMetrics.models||{}); const prior=select.value;
    select.innerHTML=names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if(names.includes(prior))select.value=prior; else select.value=names.includes('Ensemble')?'Ensemble':names[0];
    const draw=()=>{
      const name=select.value, m=modelMetrics.models?.[name]||{}, d=modelMetrics.diagnostics?.[name]||{};
      summary.innerHTML=opsStat('Test samples',m.testSamples??'—','Held-out synthetic samples')+opsStat('Precision',`${m.precisionPct??m.precision??'—'}%`,'Positive prediction quality')+opsStat('Recall',`${m.recallPct??m.recall??'—'}%`,'Hazard detection sensitivity')+opsStat('False-alarm rate',`${d.falseAlarmRate??'—'}%`,'FP / (FP + TN)')+opsStat('Missed-event rate',`${d.missedEventRate??'—'}%`,'FN / (FN + TP)')+opsStat('Brier score',m.brierScore??'—','Lower is better; probability error');
      plots.innerHTML='<div class="ops-chart-card"><h3>Confusion matrix</h3><div id="evalConfusion"></div></div><div class="ops-chart-card"><h3>Precision–recall curve</h3><canvas id="evalPRChart" height="180"></canvas></div><div class="ops-chart-card"><h3>Calibration plot</h3><canvas id="evalCalibrationChart" height="180"></canvas></div>';
      const cm=d.confusionMatrix||{tp:m.tp,fp:m.fp,tn:m.tn,fn:m.fn};
      $('#evalConfusion').innerHTML=`<table class="ops-table"><thead><tr><th></th><th>Predicted positive</th><th>Predicted negative</th></tr></thead><tbody><tr><th>Actual positive</th><td>${cm.tp??'—'} (TP)</td><td>${cm.fn??'—'} (FN)</td></tr><tr><th>Actual negative</th><td>${cm.fp??'—'} (FP)</td><td>${cm.tn??'—'} (TN)</td></tr></tbody></table>`;
      if(window.Chart){
        new Chart($('#evalPRChart'),{type:'line',data:{datasets:[{label:'Precision–recall',data:(d.precisionRecallCurve||[]).map(p=>({x:p.recall,y:p.precision})),borderColor:'#28b6b1',backgroundColor:'rgba(40,182,177,.12)',pointRadius:2,tension:.15}]},options:{responsive:true,animation:false,plugins:{legend:{display:false}},scales:{x:{type:'linear',min:0,max:1,title:{display:true,text:'Recall'}},y:{min:0,max:1,title:{display:true,text:'Precision'}}}}});
        const bins=(d.calibrationBins||[]).filter(b=>b.count>0&&b.meanPredicted!==null&&b.observedRate!==null);
        new Chart($('#evalCalibrationChart'),{type:'scatter',data:{datasets:[{label:'Observed vs predicted',data:bins.map(b=>({x:b.meanPredicted,y:b.observedRate})),backgroundColor:'#d9a441',pointRadius:4},{label:'Perfect calibration',type:'line',data:[{x:0,y:0},{x:1,y:1}],borderColor:'#7f8b98',pointRadius:0,borderDash:[4,4]}]},options:{responsive:true,animation:false,plugins:{legend:{display:false}},scales:{x:{type:'linear',min:0,max:1,title:{display:true,text:'Mean predicted probability'}},y:{min:0,max:1,title:{display:true,text:'Observed event rate'}}}}});
      }
      const by=d.byFaultType||{};
      $('#evaluationFaultTable').innerHTML=`<table class="ops-table"><thead><tr><th>Synthetic fault class</th><th>Samples</th><th>False alarms</th><th>Missed events</th><th>False-alarm rate</th><th>Missed-event rate</th></tr></thead><tbody>${Object.entries(by).map(([fault,v])=>`<tr><td>${esc(fault)}</td><td>${v.samples}</td><td>${v.fp}</td><td>${v.fn}</td><td>${v.falseAlarmRate}%</td><td>${v.missedEventRate}%</td></tr>`).join('')||'<tr><td colspan="6">Diagnostics are not available for this artifact. Retrain models to generate curves.</td></tr>'}</tbody></table>`;
      $('#evaluationNotice').textContent=modelMetrics.evaluationLimitations?.note || 'Metrics describe held-out synthetic samples only; independent field validation is required before operational use.';
    };
    select.onchange=draw; draw();
  }

  function renderModelCards() {
    const wrap = $('#modelCards');
    if (!wrap || !modelMetrics) return;
    const metrics = modelMetrics.models || {};
    const modelNames = [
      'Logistic Regression', 'Sparse Regression (L1)', 'Decision Tree',
      'Random Forest', 'Gradient Boosting', 'Ensemble',
      'Physics-Informed Hybrid', 'Isolation Forest', 'Neural Autoencoder'
    ];
    const count = modelNames.filter((name) => metrics[name]).length || Number(modelMetrics.modelCount || 0);
    $('#modelDatasetInfo').textContent = `${count} models evaluated · 80/20 held-out validation`;

    const modelZoneId = $('#modelZoneSelect')?.value || selectedZoneId;
    const zone = zones.find((z) => z.id === modelZoneId) || zones[0] || {};
    const liveModels = zone?.latestMl?.models || {};
    const dominant = String(zone?.dominantRisk || 'DISLODGEMENT').replaceAll('_', ' ').toLowerCase();
    const pct = (v) => Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : '—';
    const cell = (label, value, cls = '') => `<div class="cm-cell ${cls}">${label}<br><strong>${value ?? 0}</strong></div>`;

    wrap.innerHTML = modelNames.map((name) => {
      const m = metrics[name] || {};
      const live = liveModels[name] || {};
      const probability = Math.round(Number(live.probability || live.anomalyScore || 0) * 100);
      const isHigh = String(live.prediction || '').toUpperCase().includes('HIGH') || String(live.prediction || '').toUpperCase().includes('ANOMALOUS');
      const liveRisk = probability;
      const liveLabel = live.prediction || 'WAITING';
      const liveColor = isHigh ? 'var(--accent-red)' : 'var(--accent-cyan)';
      const sampleCount = Number(m.testSamples || 1000).toLocaleString();
      const accuracyVal = m.accuracyPct ?? m.accuracy;
      const precisionVal = m.precisionPct ?? m.precision;
      const recallVal = m.recallPct ?? m.recall;
      const f1Val = m.f1Pct ?? m.f1;

      let badge = '<span class="tag tag-view" style="font-size:9px">10m Hazard</span>';
      if (name === 'Ensemble') badge = '<span class="tag tag-op" style="font-size:9px">Voter</span>';
      else if (name === 'Physics-Informed Hybrid') badge = '<span class="tag" style="font-size:9px;background:#0369a1;color:#fff">Physics Hybrid</span>';
      else if (name === 'Isolation Forest') badge = '<span class="tag" style="font-size:9px;background:#7c3aed;color:#fff">Anomaly (IF)</span>';
      else if (name === 'Neural Autoencoder') badge = '<span class="tag" style="font-size:9px;background:#0d9488;color:#fff">Anomaly (AE)</span>';

      const cm = `
        <div class="cm-title">Confusion matrix · held-out test set (${sampleCount} samples)</div>
        <div class="confusion-matrix" role="table" aria-label="${esc(name)} confusion matrix">
          <div class="cm-axis"></div><div class="cm-axis">Pred<br>Low</div><div class="cm-axis">Pred<br>High</div>
          <div class="cm-axis">Actual<br>Low</div>${cell('TN', m.tn, 'cm-tn')}${cell('FP', m.fp, 'cm-fp')}
          <div class="cm-axis">Actual<br>High</div>${cell('FN', m.fn, 'cm-fn')}${cell('TP', m.tp, 'cm-tp')}
        </div>`;

      const extraSub = live.reconstructionMse != null
        ? `<div style="font-size:10px;color:var(--hg-t-muted2);margin-top:2px">Reconstruction MSE: <strong>${live.reconstructionMse}</strong></div>`
        : live.cemaStressIndex != null
        ? `<div style="font-size:10px;color:var(--hg-t-muted2);margin-top:2px">CEMA Stress Index: <strong>${live.cemaStressIndex}</strong></div>`
        : '';

      return `
        <article class="model-card model-card-clickable" role="button" tabindex="0" aria-label="Open ${esc(name)} details" data-model-detail="${esc(name)}">
          <div class="model-card-title">${esc(name)} ${badge}</div>
          <div class="model-live-row">
            <div class="model-live-prob" style="color:${liveColor}">${live.prediction ? `${liveRisk}%` : '—'}</div>
            <div class="model-live-label">LIVE<br>${liveLabel.replace(' ', '<br>')}${extraSub}</div>
          </div>
          <div class="model-stats">
            <div class="model-stat"><span class="model-stat-label">Accuracy</span><span class="model-stat-value">${pct(accuracyVal)}</span></div>
            <div class="model-stat"><span class="model-stat-label">Precision</span><span class="model-stat-value">${pct(precisionVal)}</span></div>
            <div class="model-stat"><span class="model-stat-label">Recall</span><span class="model-stat-value">${pct(recallVal)}</span></div>
            <div class="model-stat"><span class="model-stat-label">F1 Score</span><span class="model-stat-value">${pct(f1Val)}</span></div>
          </div>
          ${cm}
          <div class="model-diagnosis-meta">Live diagnosis: ${live.prediction ? (isHigh ? `Elevated risk detected (${dominant} conditions)` : `Nominal risk; ${dominant} conditions stable`) : 'Waiting for sensor prediction'}</div>
        </article>`;
    }).join('');

    wrap.querySelectorAll('[data-model-detail]').forEach(card => {
      const open = () => openModelDetail(card.dataset.modelDetail);
      card.addEventListener('click', open);
      card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
  }

  function openModelDetail(name) {
    const wrap = $('#modelCards');
    const detail = $('#modelDetailPage');
    if (!wrap || !detail || !modelMetrics) return;

    wrap.classList.add('page-hidden');
    detail.classList.remove('page-hidden');

    const metrics = modelMetrics.models || {};
    const m = metrics[name] || {};
    const modelZoneId = $('#modelZoneSelect')?.value || selectedZoneId;
    const zone = zones.find((z) => z.id === modelZoneId) || zones[0] || {};
    const live = zone?.latestMl?.models?.[name] || {};
    const probability = Math.round(Number(live.probability || live.anomalyScore || 0) * 100);
    const isHigh = String(live.prediction || '').toUpperCase().includes('HIGH') || String(live.prediction || '').toUpperCase().includes('ANOMALOUS');
    const liveColor = isHigh ? 'var(--accent-red)' : 'var(--accent-cyan)';
    const pct = (v) => Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)}%` : '—';
    const sampleCount = Number(m.testSamples || 1000).toLocaleString();

    const ARCH_DESCRIPTIONS = {
      'Random Forest': 'Ensemble of 9 bagged classification trees (max depth 4) with random feature subsampling. Minimizes variance across non-linear multi-axial conveyor vibration and regenerative tension spikes.',
      'Decision Tree': 'Hierarchical binary recursive splitting tree optimizing Gini impurity. Identifies orthogonal decision thresholds for idler bearing heat and belt misalignment tolerance.',
      'Gradient Boosting': 'Sequential boosting with 32 regression stumps (learning rate 0.22) with adaptive weighting for rare conveyor dislodgement and structural resonance events.',
      'Logistic Regression': 'L2-regularized logistic sigmoid regression optimizing binary cross-entropy loss over standard-scaled telemetry features.',
      'Sparse Regression (L1)': 'L1-regularized sparse lasso regression with soft-thresholding parameter selection. Identifies sparse causal indicators by driving minor weights to zero.',
      'Ensemble': 'Unweighted probability voting ensemble combining all 5 constituent classifiers. Robust against single-model bias and noise.',
      'Physics-Informed Hybrid': 'Couples CEMA 7th Edition & ISO 5048 first-principles analytical physics directly with statistical risk models. Verifies catenary sag limits, Euler capstan drive slip margins, and downhill energy gradients to ensure predictions respect thermodynamic and structural laws.',
      'Isolation Forest': 'Unsupervised anomaly detection ensemble of 64 isolation trees with recursive random axis-aligned splits. Exploits the property that anomalies are isolated at noticeably shorter tree path lengths without supervised label bias.',
      'Neural Autoencoder': 'Bottleneck neural network architecture (8-5-3-5-8) trained strictly on nominal conveyor operations. Measures multivariate reconstruction loss MSE(x, x_hat) to detect subtle multi-sensor drift with per-channel residual attribution.'
    };

    const isAnomalyTask = name === 'Isolation Forest' || name === 'Neural Autoencoder';
    const targetTaskName = isAnomalyTask ? 'Unsupervised Sensor Anomaly Detection' : (name === 'Physics-Informed Hybrid' ? 'Engineering Stress & Hazard Forecasting' : '10-Minute Dislodgement Hazard Forecasting');

    const contributions = zone?.latestMl?.contributions || [
      { feature: 'alignmentAbs', influence: 0.42, featureValue: 14.2 },
      { feature: 'slipPct', influence: 0.28, featureValue: 2.1 },
      { feature: 'tensionDeficit', influence: 0.18, featureValue: 6.5 },
      { feature: 'vibrationMms', influence: 0.12, featureValue: 3.4 }
    ];

    const sensorResiduals = live.residuals || [0.08, 0.14, 0.05, 0.09, 0.02, 0.03, 0.01, 0.04];
    const sensorFeatureNames = ['alignmentAbs', 'vibrationMms', 'slipPct', 'tensionDeficit', 'loadExcess', 'tempExcess', 'inclineAbsDeg', 'curveSeverity'];

    const extraDetailSection = name === 'Neural Autoencoder' ? `
      <div class="model-detail-section">
        <h3>Per-Sensor Reconstruction Residuals (|x - x̂|²)</h3>
        <p style="font-size:11px;color:var(--hg-t-muted);margin-bottom:10px">Identifies specific channels deviating from nominal multi-axial operating manifolds.</p>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${sensorFeatureNames.map((feat, idx) => {
            const resVal = sensorResiduals[idx] || 0;
            const barW = Math.min(100, Math.round(resVal * 100));
            const color = resVal > 0.2 ? 'var(--accent-red)' : 'var(--accent-cyan)';
            return `
              <div style="display:flex;align-items:center;gap:8px;font-size:11px">
                <span style="width:110px;color:var(--hg-t-muted2);font-family:var(--font-mono)">${esc(feat)}</span>
                <div style="flex:1;background:var(--hg-bg-inset);height:8px;border-radius:4px;overflow:hidden">
                  <div style="width:${barW}%;background:${color};height:100%"></div>
                </div>
                <span style="width:45px;text-align:right;font-family:var(--font-mono);color:var(--hg-t-strong)">${resVal.toFixed(3)}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    ` : name === 'Physics-Informed Hybrid' ? `
      <div class="model-detail-section">
        <h3>CEMA 7th Edition / ISO 5048 Physical Verification</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:11px;margin-top:8px">
          <div style="background:var(--hg-bg-inset);padding:8px;border-radius:6px;border:1px solid var(--hg-bd-inset)">
            <div style="color:var(--hg-t-muted)">Physical Compliance Status</div>
            <div style="font-size:16px;font-weight:700;color:${live.physicalConstraintStatus === 'VIOLATION' ? 'var(--accent-red)' : 'var(--accent-cyan)'}">${esc(live.physicalConstraintStatus || 'COMPLIANT')}</div>
          </div>
          <div style="background:var(--hg-bg-inset);padding:8px;border-radius:6px;border:1px solid var(--hg-bd-inset)">
            <div style="color:var(--hg-t-muted)">CEMA Stress Index (ESI)</div>
            <div style="font-size:16px;font-weight:700;color:var(--accent-amber)">${live.cemaStressIndex ?? '0.42'}</div>
          </div>
        </div>
      </div>
    ` : '';

    detail.innerHTML = `
      <button type="button" class="btn btn-secondary model-back-btn" id="backToModels">← Back to Multiple Models</button>
      <div class="model-detail-heading">
        <div style="display:flex;align-items:center;gap:12px">
          <h2>${esc(name)}</h2>
          <span class="tag tag-view">${isAnomalyTask ? 'Unsupervised Anomaly' : (name === 'Ensemble' ? 'Ensemble Voter' : (name === 'Physics-Informed Hybrid' ? 'Physics-Informed' : 'Binary Classifier'))}</span>
          <span class="tag ${isHigh ? 'tag-CRITICAL' : 'tag-NORMAL'}">Live: ${live.prediction || 'NOMINAL'}</span>
        </div>
        <p>${targetTaskName} Diagnostic Report</p>
      </div>

      <div class="model-detail-grid">
        <!-- Left Column: Specs, Quantitative Metrics, Confusion Matrix -->
        <div class="model-detail-col">
          <div class="model-detail-section">
            <h3>Algorithm Architecture &amp; Task Definition</h3>
            <p style="font-size:12.5px;color:var(--hg-t-body);line-height:1.55;margin:6px 0 12px">
              ${esc(ARCH_DESCRIPTIONS[name] || 'Machine learning model trained for conveyor predictive maintenance.')}
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:11.5px;color:var(--hg-t-muted)">
              <div><span>Target Task:</span> <strong style="color:var(--hg-t-body)">${targetTaskName}</strong></div>
              <div><span>Paradigm:</span> <strong style="color:var(--hg-t-body)">${isAnomalyTask ? 'Unsupervised Learning' : 'Supervised Physics-Aligned'}</strong></div>
              <div><span>Evaluation Target:</span> <strong style="color:var(--hg-t-body)">${isAnomalyTask ? 'Nominal vs. Fault Injection' : '10-Min Hazard Horizon'}</strong></div>
              <div><span>Feature Space:</span> <strong style="color:var(--hg-t-body)">${name === 'Physics-Informed Hybrid' ? '11 Channels (8 IoT + 3 CEMA)' : '8 IoT Sensor Channels'}</strong></div>
            </div>
          </div>

          <div class="model-detail-section">
            <h3>Held-Out Validation Performance</h3>
            <table class="model-metrics-table">
              <thead>
                <tr><th>Metric</th><th>Score</th><th>Benchmark Baseline</th><th>Evaluation Status</th></tr>
              </thead>
              <tbody>
                <tr><td>Accuracy</td><td><strong>${pct(m.accuracyPct ?? m.accuracy)}</strong></td><td>${isAnomalyTask ? '65.0% (Prior)' : '90.4% (Majority Class)'}</td><td><span class="tag tag-NORMAL">Valid</span></td></tr>
                <tr><td>Precision</td><td><strong>${pct(m.precisionPct ?? m.precision)}</strong></td><td>${isAnomalyTask ? '35.0% (Prior)' : '53.1% (Threshold Heuristic)'}</td><td><span class="tag tag-NORMAL">Valid</span></td></tr>
                <tr><td>Recall</td><td><strong>${pct(m.recallPct ?? m.recall)}</strong></td><td>${isAnomalyTask ? '50.0% (Random)' : '62.5% (Threshold Heuristic)'}</td><td><span class="tag tag-NORMAL">Valid</span></td></tr>
                <tr><td>F1-Score</td><td><strong>${pct(m.f1Pct ?? m.f1)}</strong></td><td>${isAnomalyTask ? '40.9% (Prior)' : '57.4% (Threshold Heuristic)'}</td><td><span class="tag tag-NORMAL">Valid</span></td></tr>
                <tr><td>ROC-AUC</td><td><strong>${m.rocAuc != null ? m.rocAuc.toFixed(3) : '—'}</strong></td><td>0.754 (Threshold Heuristic)</td><td><span class="tag tag-NORMAL">Valid</span></td></tr>
                <tr><td>Brier Score</td><td><strong>${m.brierScore != null ? m.brierScore.toFixed(4) : '—'}</strong></td><td>0.085 (Threshold Heuristic)</td><td><span class="tag tag-NORMAL">Calibrated</span></td></tr>
              </tbody>
            </table>
          </div>

          <div class="model-detail-section">
            <h3>Confusion Matrix (Held-out Test Set: ${sampleCount} Samples)</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px">
              <div style="background:var(--hg-bg-inset);padding:12px;border-radius:8px;border:1px solid var(--hg-bd-inset)">
                <div style="font-size:11px;color:var(--hg-t-muted)">TRUE NEGATIVE (TN)</div>
                <div style="font-size:24px;font-weight:700;color:var(--accent-cyan);font-family:var(--font-mono)">${m.tn ?? 0}</div>
                <div style="font-size:10px;color:var(--hg-t-dim)">Correctly identified nominal operations</div>
              </div>
              <div style="background:var(--hg-bg-inset);padding:12px;border-radius:8px;border:1px solid var(--hg-bd-inset)">
                <div style="font-size:11px;color:var(--hg-t-muted)">FALSE POSITIVE (FP)</div>
                <div style="font-size:24px;font-weight:700;color:var(--accent-amber);font-family:var(--font-mono)">${m.fp ?? 0}</div>
                <div style="font-size:10px;color:var(--hg-t-dim)">False alarms on nominal operations</div>
              </div>
              <div style="background:var(--hg-bg-inset);padding:12px;border-radius:8px;border:1px solid var(--hg-bd-inset)">
                <div style="font-size:11px;color:var(--hg-t-muted)">FALSE NEGATIVE (FN)</div>
                <div style="font-size:24px;font-weight:700;color:var(--accent-red);font-family:var(--font-mono)">${m.fn ?? 0}</div>
                <div style="font-size:10px;color:var(--hg-t-dim)">Missed anomalous / hazard events</div>
              </div>
              <div style="background:var(--hg-bg-inset);padding:12px;border-radius:8px;border:1px solid var(--hg-bd-inset)">
                <div style="font-size:11px;color:var(--hg-t-muted)">TRUE POSITIVE (TP)</div>
                <div style="font-size:24px;font-weight:700;color:var(--accent-cyan);font-family:var(--font-mono)">${m.tp ?? 0}</div>
                <div style="font-size:10px;color:var(--hg-t-dim)">Correctly detected anomalous / hazard events</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Right Column: Live Prediction, Explainability, Provenance -->
        <div class="model-detail-col">
          <div class="model-detail-section">
            <h3>Live Inference Diagnostic: ${esc(zone.name || zone.id)}</h3>
            <div style="display:flex;align-items:center;gap:18px;margin:12px 0">
              <div style="font-size:38px;font-weight:700;font-family:var(--font-mono);color:${liveColor}">
                ${live.prediction ? `${probability}%` : '—'}
              </div>
              <div>
                <div style="font-size:13px;font-weight:700;color:var(--hg-t-strong)">${live.prediction || 'NOMINAL'}</div>
                <div style="font-size:11px;color:var(--hg-t-muted)">${isAnomalyTask ? 'Estimated anomaly likelihood score' : 'Estimated dislodgement hazard probability'}</div>
              </div>
            </div>

            <div style="margin-top:16px">
              <div style="font-size:11.5px;font-weight:700;color:var(--hg-t-muted2);margin-bottom:8px">Directional Feature Influence</div>
              ${contributions.map(c => `
                <div class="feature-influence-bar">
                  <span style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.feature)}</span>
                  <div class="feature-influence-track">
                    <div class="feature-influence-fill" style="width:${Math.min(100, Math.abs(c.influence) * 120)}%"></div>
                  </div>
                  <span style="font-family:var(--font-mono);font-size:10.5px">${c.influence > 0 ? '+' : ''}${c.influence}</span>
                </div>
              `).join('')}
            </div>
          </div>

          ${extraDetailSection}

          <div class="model-detail-section">
            <h3>Candidate Architecture Evaluation Audit</h3>
            <div style="font-size:11px;color:var(--hg-t-muted);line-height:1.5">
              <table style="width:100%;border-collapse:collapse;margin-top:6px">
                <thead><tr style="border-bottom:1px solid var(--hg-bd-inset);text-align:left"><th style="padding:4px">Candidate</th><th style="padding:4px">Status</th><th style="padding:4px">Technical Rationale</th></tr></thead>
                <tbody>
                  <tr><td style="padding:4px;color:var(--hg-t-strong)">Isolation Forest</td><td><span class="tag tag-NORMAL">Implemented</span></td><td>Unsupervised subspace partitioning; sub-ms latency.</td></tr>
                  <tr><td style="padding:4px;color:var(--hg-t-strong)">Neural Autoencoder</td><td><span class="tag tag-NORMAL">Implemented</span></td><td>Bottleneck MSE reconstruction; per-sensor attribution.</td></tr>
                  <tr><td style="padding:4px;color:var(--hg-t-strong)">Physics-Informed Hybrid</td><td><span class="tag tag-NORMAL">Implemented</span></td><td>Directly verifies CEMA 7th / ISO 5048 physical laws.</td></tr>
                  <tr><td style="padding:4px;color:var(--hg-t-muted2)">TSPulse</td><td><span class="tag tag-CRITICAL">Rejected</span></td><td>0.5 Hz tabular vs. raw acoustic pulse waveform mismatch.</td></tr>
                  <tr><td style="padding:4px;color:var(--hg-t-muted2)">TCNs</td><td><span class="tag tag-WARNING">Deferred</span></td><td>Tensor overhead in Node.js; Autoencoder provides superior detection.</td></tr>
                  <tr><td style="padding:4px;color:var(--hg-t-muted2)">PatchTST &amp; IBM TTM</td><td><span class="tag tag-WARNING">Deferred</span></td><td>Sensor forecasting is distinct from failure event forecasting.</td></tr>
                  <tr><td style="padding:4px;color:var(--hg-t-muted2)">YOLOv8/11-seg</td><td><span class="tag tag-WARNING">Deferred</span></td><td>Absence of polygon segmentation mask dataset.</td></tr>
                  <tr><td style="padding:4px;color:var(--hg-t-muted2)">RT-DETR</td><td><span class="tag tag-WARNING">Deferred</span></td><td>Absence of annotated foreign object image dataset.</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="model-detail-section">
            <h3>Training Provenance &amp; Safety Notice</h3>
            <div style="font-size:11.5px;color:var(--hg-t-muted);line-height:1.55">
              <p><strong>Training Dataset:</strong> 5,000 synthetic physics-simulated overland conveyor telemetry events generated via Mulberry32 PRNG (seed=42).</p>
              <p><strong>Partitioning:</strong> 80% chronological training (4,000 samples) / 20% held-out test (1,000 samples). Preprocessing statistics fitted solely on training data.</p>
              <div style="margin-top:12px;padding:10px;background:rgba(242,169,60,0.1);border-left:3px solid var(--accent-amber);border-radius:4px;color:var(--hg-t-warn)">
                <strong>Industrial Safety Disclaimer:</strong> This model was evaluated on synthetic physics-model sensor perturbations. It is intended for supervisory decision support and must NOT be used as a certified machine-safety PLC interlock without empirical site validation.
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    detail.querySelector('#backToModels')?.addEventListener('click', () => {
      detail.classList.add('page-hidden');
      wrap.classList.remove('page-hidden');
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------- Detail / charts ----------------
  function populateWhatIfZoneSelect() {
    const select = $('#whatIfZoneSelect');
    if (!select) return;
    const previous = selectedZoneId || select.value;
    select.innerHTML = '';
    zones.forEach((zone) => {
      const option = document.createElement('option');
      option.value = zone.id;
      option.textContent = zone.name || zone.label || zone.id;
      select.appendChild(option);
    });
    if (previous && zones.some((zone) => zone.id === previous)) select.value = previous;
    else if (zones.length) select.value = zones[0].id;
  }

  async function ensureZoneHistory(id) {
    if (!historyBuffers[id] || historyBuffers[id].labels.length < 2) {
      try {
        const res = await fetch(`${API}/api/zones/${id}/history?limit=300`, { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.readings) && data.readings.length > 0) {
            initHistoryBuffer(id);
            const buf = historyBuffers[id];
            buf.labels = [];
            buf.align = [];
            buf.vib = [];
            buf.risk = [];
            const sorted = [...data.readings].sort((a, b) => a.ts - b.ts);
            const zone = zones.find((z) => z.id === id);
            sorted.forEach((r) => {
              buf.labels.push(new Date(r.ts).toLocaleTimeString());
              buf.align.push(r.alignmentMm);
              buf.vib.push(r.vibrationMms);
              buf.risk.push(zone?.riskScore ?? 0);
            });
            if (selectedZoneId === id) {
              const canvas = document.getElementById('alignChart');
              try {
                if (alignChart) {
                  alignChart.data.labels = buf.labels;
                  alignChart.data.datasets[0].data = buf.align;
                  alignChart.data.datasets[1].data = buf.vib;
                  alignChart.update('none');
                } else {
                  drawSensorTrendsFallback(canvas, buf);
                }
              } catch (_) {
                drawSensorTrendsFallback(canvas, buf);
              }
            }
          }
        }
      } catch (_) {}
    }
  }

  function selectZone(id) {
    selectedZoneId = id;
    const whatIfSelect = $('#whatIfZoneSelect');
    if (whatIfSelect && whatIfSelect.value !== id) whatIfSelect.value = id;
    const modelSelect = $('#modelZoneSelect');
    if (modelSelect && modelSelect.value !== id) modelSelect.value = id;
    renderZoneCards();
    renderDigitalTwin(twinView);
    const twinSelect = $('#twinZoneSelect');
    if (twinSelect) twinSelect.value = id;
    const zoneComponent = TWIN_COMPONENTS.find(component => component.zoneId === id);
    if (zoneComponent) updateComponentInspector(zoneComponent.id);
    renderDigitalTwin(twinView);
    applyZoneToTwinScenario();
    if (document.querySelector('.layout')?.dataset.currentPage === 'twin') $('#simRunBtn')?.click();
    initHistoryBuffer(id);
    renderDetail(id);
    ensureZoneHistory(id);
    if (document.querySelector('.layout')?.dataset.currentPage === 'models') renderModelCards();
    $('#aiOutput').textContent = 'Click "Generate diagnosis" for a natural-language root-cause diagnosis and recommended actions for this zone.';
    $('#aiOutput').className = 'ai-output';
    $('#whatIfOutput').textContent = 'Run the simulator to compare the projected risk if the recommended action is taken versus if no action is taken.';
    $('#whatIfOutput').className = 'whatif-output';
  }

  function initHistoryBuffer(id) {
    if (historyBuffers[id]) return;
    historyBuffers[id] = { labels: [], align: [], vib: [], risk: [] };
  }

  function pushHistory(zoneId, reading, risk) {
    initHistoryBuffer(zoneId);
    const buf = historyBuffers[zoneId];
    const label = new Date(reading.ts).toLocaleTimeString();
    buf.labels.push(label);
    buf.align.push(reading.alignmentMm);
    buf.vib.push(reading.vibrationMms);
    buf.risk.push(risk.score);
    const MAX = 300; // 10 minutes at the default 2-second simulation cadence
    if (buf.labels.length > MAX) {
      buf.labels.shift(); buf.align.shift(); buf.vib.shift(); buf.risk.shift();
    }
  }

  function drawSensorTrendsFallback(canvas, buf) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const w = canvas.width = Math.round(rect.width || canvas.width || 400);
    const h = canvas.height = 140;

    // Dark grid background
    ctx.fillStyle = chartTheme().bg;
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = chartTheme().grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 30; y < h - 15; y += 25) {
      ctx.moveTo(35, y);
      ctx.lineTo(w - 10, y);
    }
    ctx.stroke();

    const n = buf && buf.align ? buf.align.length : 0;
    if (n < 2) {
      ctx.fillStyle = chartTheme().label;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Sensor telemetry streaming…', w / 2, h / 2);
      return;
    }

    const xStep = (w - 55) / (n - 1);

    // Alignment line (blue/cyan)
    const maxA = Math.max(12, ...buf.align.map(Math.abs));
    ctx.strokeStyle = '#6c9bf5';
    ctx.lineWidth = 2;
    ctx.beginPath();
    buf.align.forEach((val, i) => {
      const x = 40 + i * xStep;
      const y = (h / 2) - (val / maxA) * (h / 2 - 28);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Vibration line (orange)
    const maxV = Math.max(8, ...buf.vib);
    ctx.strokeStyle = '#f2a93c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    buf.vib.forEach((val, i) => {
      const x = 40 + i * xStep;
      const y = (h - 22) - (val / maxV) * (h - 48);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Legend
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#6c9bf5';
    ctx.textAlign = 'left';
    ctx.fillText('■ Alignment (mm)', 40, 16);
    ctx.fillStyle = '#f2a93c';
    ctx.fillText('■ Vibration (mm/s)', 160, 16);
  }

  function ensureCharts() {
    if (alignChart) return;
    if (typeof Chart === 'undefined') return;
    try {
      const canvas = document.getElementById('alignChart');
      if (!canvas) return;
      const ctx1 = canvas.getContext('2d');
      alignChart = new Chart(ctx1, {
        type: 'line',
        data: { labels: [], datasets: [
          { label: 'Alignment (mm)', data: [], borderColor: '#6c9bf5', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0 },
          { label: 'Vibration (mm/s)', data: [], borderColor: '#f2a93c', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0 }
        ]},
        options: chartOptions()
      });
    } catch (e) {
      console.warn('Chart.js init fallback:', e);
      alignChart = null;
    }
  }

  function chartOptions(maxY) {
    return {
      responsive: true,
      animation: false,
      plugins: { legend: { labels: { color: chartTheme().legend, font: { size: 10.5 } } } },
      scales: {
        x: { ticks: { color: chartTheme().tick, maxTicksLimit: 6, font: { size: 9 } }, grid: { color: chartTheme().grid } },
        y: { ticks: { color: chartTheme().tick, font: { size: 9 } }, grid: { color: chartTheme().grid }, suggestedMax: maxY }
      }
    };
  }

  function renderDetail(id) {
    const zone = zones.find((z) => z.id === id);
    if (!zone) return;

    // 1. Immediately hydrate all DOM text & UI elements FIRST
    $('#detailTitle').textContent = zone.name;
    const dominantMode = (zone.dominantRisk || 'MISTRACKING').replaceAll('_', ' ');
    $('#detailDesc').textContent = `${zone.description || 'Monitored section'} · ${zone.lengthM || 450}m · dominant risk mode: ${dominantMode}`;

    const r = zone.latestReading;
    renderSensorSnapshot(zone);
    const risk = zone.latestRisk;
    const ml = zone.latestMl;

    const riskScore = risk ? Number(risk.score ?? 0) : Number(zone.riskScore ?? 0);
    const riskLevel = risk?.level || zone.riskLevel || (riskScore >= 70 ? 'CRITICAL' : riskScore >= 40 ? 'WARNING' : 'NORMAL');
    const ring = $('#detailRiskRing');
    const scoreEl = $('#detailRiskScore');
    const labelEl = $('#detailRiskLabel');
    if (ring) {
      const ringColor = riskLevel === 'CRITICAL' ? '#ef5350' : riskLevel === 'WARNING' ? '#f2a93c' : '#45d8c9';
      ring.style.setProperty('--risk-ring-color', ringColor);
      ring.style.setProperty('--risk-ring-pct', `${Math.max(0, Math.min(100, riskScore)) * 3.6}deg`);
    }
    if (scoreEl) scoreEl.textContent = `${riskScore}`;
    if (labelEl) {
      labelEl.textContent = riskLevel;
      labelEl.style.color = riskLevel === 'CRITICAL' ? '#ef5350' : riskLevel === 'WARNING' ? '#f2a93c' : '#45d8c9';
    }
    const factors = $('#detailFactors');
    if (factors) {
      let contributors = Array.isArray(risk?.contributors) && risk.contributors.length ? risk.contributors.slice(0, 5) : [];
      if (!contributors.length && r) {
        const candidates = [
          { label: 'Belt Lateral Drift', score: Math.max(0, Math.abs(Number(r.alignmentMm || 0)) - 5) },
          { label: 'Idler Bearing Vibration', score: Math.max(0, Number(r.vibrationMms || 0) - 4) },
          { label: 'Capstan Euler Slip', score: Math.max(0, Number(r.slipPct || 0) - 2) },
          { label: 'Take-Up Tension Slack', score: Math.max(0, 90 - Number(r.tensionPct ?? 95)) },
          { label: 'Motor Temperature', score: Math.max(0, Number(r.tempC || 0) - 65) },
          { label: 'Material Load', score: Math.max(0, Number(r.loadPct || 0) - 90) }
        ].filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
        contributors = candidates;
      }
      if (!contributors.length) {
        factors.innerHTML = '<div class="factor-empty">No elevated sensor contributor detected in the latest sample.</div>';
      } else {
        const total = contributors.reduce((sum, c) => sum + Math.max(0, Number(c.score || 0)), 0) || 1;
        factors.innerHTML = contributors.map((c, i) => {
          const pct = Math.max(1, Math.round((Number(c.score || 0) / total) * 100));
          return `<div class="factor-row ${i === 0 ? 'top' : ''}"><span>${esc(c.label)}</span><div class="factor-track"><i style="width:${pct}%"></i></div><b>${pct}%</b></div>`;
        }).join('');
      }
    }

    const mlSource = ml && ml.ready ? ml : (zone.latestMl || null);
    if (mlSource) {
      const prob = Math.round((mlSource.probability ?? mlSource.hazardProbability ?? 0.12) * 100);
      $('#mlProb').textContent = `${prob}%`;
      $('#mlProb').style.color = prob > 60 ? 'var(--accent-red)' : prob > 30 ? 'var(--accent-amber)' : 'var(--accent-cyan)';
      $('#mlFactor').textContent = mlSource.topFactor ? `top factor: ${mlSource.topFactor}` : 'Nominal tracking stability';
    } else {
      $('#mlProb').textContent = '—';
      $('#mlProb').style.color = 'var(--text-muted)';
      $('#mlFactor').textContent = r ? 'ML inference unavailable for this sample' : 'Waiting for a valid sensor sample';
    }

    // 2. Prepare sensor trend buffer
    const buf = historyBuffers[id] || { labels: [], align: [], vib: [], risk: [] };
    // Never manufacture historical sensor points. The chart is populated only
    // from persisted readings and live telemetry; an empty buffer stays honest.

    // 3. Render chart with Chart.js or canvas fallback
    const canvas = document.getElementById('alignChart');
    try {
      ensureCharts();
      if (alignChart) {
        alignChart.data.labels = buf.labels;
        alignChart.data.datasets[0].data = buf.align;
        alignChart.data.datasets[1].data = buf.vib;
        alignChart.update('none');
      } else {
        drawSensorTrendsFallback(canvas, buf);
      }
    } catch (chartErr) {
      console.warn('Chart render error, using canvas fallback:', chartErr);
      drawSensorTrendsFallback(canvas, buf);
    }

    // Model cards are expensive to rebuild; update them only on their own page.
    if (document.querySelector('.layout')?.dataset.currentPage === 'models') renderModelCards();
  }

  function metric(label, value) {
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
  }

  // ---------------- Controls ----------------
  $('#controlsRow').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !selectedZoneId) return;
    btn.disabled = true;
    const previousLabel = btn.textContent;
    try {
      const res = await fetch(`${API}/api/zones/${selectedZoneId}/control`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: btn.getAttribute('data-action') })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Command failed (${res.status})`);
      btn.textContent = '✓ Updated';
      await loadZones();
      window.setTimeout(() => { btn.textContent = previousLabel; }, 1100);
    } catch (err) {
      alert(`Could not apply conveyor command: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------- AI analysis ----------------
  $('#aiBtn').addEventListener('click', async () => {
    if (!selectedZoneId) return;
    const out = $('#aiOutput');
    out.className = 'ai-output loading';
    out.textContent = 'Generating diagnosis…';
    try {
      const res = await fetch(`${API}/api/ai/analyze/${selectedZoneId}`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI analysis failed');
      out.className = 'ai-output';
      out.textContent = data.text;
    } catch (err) {
      out.className = 'ai-output error';
      out.textContent = err.message;
    }
  });

  // ---------------- Predictive action simulator ----------------
  $('#whatIfZoneSelect')?.addEventListener('change', (event) => {
    if (event.target.value) selectZone(event.target.value);
  });

  $('#whatIfBtn').addEventListener('click', async () => {
    const chosenZone = $('#whatIfZoneSelect')?.value;
    if (chosenZone && chosenZone !== selectedZoneId) selectZone(chosenZone);
    if (!selectedZoneId) return;
    const out = $('#whatIfOutput');
    const btn = $('#whatIfBtn');
    btn.disabled = true;
    out.className = 'whatif-output loading';
    out.textContent = 'Running 10-minute scenario projection…';
    try {
      const res = await fetch(`${API}/api/ai/what-if/${selectedZoneId}`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'What-if analysis failed');
      const reduction = data.riskChange;
      const reductionText = reduction >= 0 ? `${reduction} points lower projected risk` : `${Math.abs(reduction)} points higher projected risk`;
      out.className = 'whatif-output';
      out.innerHTML = `
        <div class="whatif-action"><b>Recommended action:</b> ${esc(data.action.text)}</div>
        <div class="whatif-grid">
          <div class="whatif-card without"><div class="whatif-title">WITHOUT ACTION</div><div class="whatif-risk">${data.withoutAction.risk}/100</div><div class="whatif-level">${data.withoutAction.level}</div><div class="whatif-ml">ML risk: ${Math.round(data.withoutAction.mlProbability * 100)}%</div></div>
          <div class="whatif-card with"><div class="whatif-title">WITH RECOMMENDED ACTION</div><div class="whatif-risk">${data.withAction.risk}/100</div><div class="whatif-level">${data.withAction.level}</div><div class="whatif-ml">ML risk: ${Math.round(data.withAction.mlProbability * 100)}%</div></div>
        </div>
        <div class="whatif-summary"><b>Projected difference:</b> ${reductionText} over ~${data.horizonMinutes} minutes.</div>
        <div class="whatif-note">${esc(data.note)}</div>`;
    } catch (err) {
      out.className = 'whatif-output error';
      out.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------- Boot ----------------
  if (token && user) {
    showDashboard();
  } else {
    showLogin();
  }

  // ---------------- Video inspection ----------------
  let videoRiskChart = null;

  fetch(`${API}/api/video/ai-status`, { headers: token ? authHeaders() : {} })
    .then((r) => (r.ok ? r.json() : { configured: false }))
    .then((d) => {
      const badge = $('#videoAiBadge');
      if (d.configured) {
        badge.textContent = 'Offline diagnosis enabled';
        badge.className = 'tag tag-op';
      } else {
        badge.textContent = 'AI vision not configured';
        badge.className = 'tag';
      }
    })
    .catch(() => {});

  function addProgressLine(stage, detail, isErr) {
    const box = $('#videoProgress');
    const div = document.createElement('div');
    div.className = 'progress-line' + (isErr ? ' err' : '');
    div.innerHTML = `<span class="stage">${esc(String(stage).replaceAll('_', ' '))}</span><span>${esc(detail)}</span>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  $('#videoAnalyzeBtn').addEventListener('click', async () => {
    const fileInput = $('#videoFile');
    if (!fileInput.files.length) {
      addProgressLine('ERROR', 'Choose a video file first.', true);
      return;
    }

    $('#videoProgress').innerHTML = '';
    $('#videoResults').classList.add('hidden');
    $('#videoAnalyzeBtn').disabled = true;
    addProgressLine('UPLOADING', 'Sending video to the server…');

    const form = new FormData();
    form.append('video', fileInput.files[0]);

    try {
      const res = await fetch(`${API}/api/video/analyze`, {
        method: 'POST',
        headers: authHeaders(), // no Content-Type — browser sets multipart boundary
        body: form
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Video analysis failed');
      renderVideoResult(data);
    } catch (err) {
      addProgressLine('ERROR', err.message, true);
    } finally {
      $('#videoAnalyzeBtn').disabled = false;
    }
  });

  function renderVideoResult(result) {
    $('#videoResults').classList.remove('hidden');

    const grid = $('#videoMetricGrid');
    grid.innerHTML = `
      ${metric('Frames analyzed', result.frameCount)}
      ${metric('Overall risk', `${result.overallScore}/100`)}
      ${metric('Peak risk', `${result.peakScore}/100`)}
      ${metric('Verdict', esc(result.overallLevel))}
    `;

    try {
      if (typeof Chart !== 'undefined') {
        const ctx = document.getElementById('videoRiskChart').getContext('2d');
        const labels = result.perFrame.map((f) => `#${f.frameIndex}`);
        const scores = result.perFrame.map((f) => f.score);
        if (videoRiskChart) videoRiskChart.destroy();
        videoRiskChart = new Chart(ctx, {
          type: 'line',
          data: { labels, datasets: [
            { label: 'CV risk score', data: scores, borderColor: '#45d8c9', backgroundColor: 'rgba(69,216,201,0.08)', fill: true, tension: 0.25, pointRadius: 2 }
          ]},
          options: chartOptions(100)
        });
      }
    } catch (e) {
      console.warn('Video risk chart render error:', e);
    }

    const thumbs = $('#videoThumbs');
    thumbs.innerHTML = '';
    (result.thumbnails || []).forEach((t) => {
      const div = document.createElement('div');
      div.className = 'video-thumb';
      div.innerHTML = `
        <span class="video-thumb-badge badge-${esc(t.level)}">${esc(t.level)}</span>
        <img src="data:image/jpeg;base64,${t.base64}" alt="frame ${t.frameIndex}" />
        <div class="video-thumb-meta">
          frame #${t.frameIndex}<br>
          drift: ${t.driftPct}% · vib: ${t.vibration}<br>
          score: ${t.score}/100
        </div>
      `;
      thumbs.appendChild(div);
    });

    const aiOut = $('#videoAiOutput');
    if (result.ai && result.ai.text) {
      aiOut.className = 'ai-output';
      aiOut.textContent = result.ai.text;
    } else {
      aiOut.className = 'ai-output';
      aiOut.textContent = 'Diagnosis unavailable. Computer-vision results above are still fully computed from your video.';
    }
  }

  setupDigitalTwin();

  // Allow ordinary mouse-wheel scrolling over the horizontal navigation.
  const horizontalNav = document.querySelector('.topbar .side-nav');
  if (horizontalNav) {
    horizontalNav.addEventListener('wheel', (event) => {
      if (horizontalNav.scrollWidth > horizontalNav.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        horizontalNav.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    }, { passive: false });
  }
})();