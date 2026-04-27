const API_BASE_URL = 'http://127.0.0.1:5000';

const ISSUE_CATEGORIES = ['TRANSFORMER_FAULT', 'OVERLOAD', 'VOLTAGE', 'SUPPLY_OUTAGE', 'UNKNOWN'];
const QUICK_ACTIONS = [
  { key: 'POWER_CYCLE', label: 'Power cycle done', note: 'Power cycle performed at site.' },
  { key: 'FUSE_REPLACED', label: 'Fuse replaced', note: 'Fuse replaced and basic checks completed.' },
  { key: 'ESCALATED', label: 'Escalated to substation', note: 'Escalated to substation control room for advanced support.' },
  { key: 'SITE_BLOCKED', label: 'Site not accessible', note: 'Site was not accessible, revisit scheduled.' }
];

let complaints = [];
let technicians = [];
let allTransformers = [];
let workerMap;
let workerComplaintLayer;
let workerTransformerLayer;
let refreshTimer;
let previousCriticalOpenIds = new Set();
let activeModalReportId = null;

function statusPillClass(value) {
  const v = String(value || '').toUpperCase();
  if (v.includes('CRITICAL') || v.includes('FAULT') || v.includes('OVERDUE')) return 'pill-red';
  if (v.includes('HIGH') || v.includes('IN_PROGRESS') || v.includes('ACCEPTED')) return 'pill-orange';
  if (v.includes('OPEN')) return 'pill-red';
  return 'pill-yellow';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function parseDate(value) {
  return value ? new Date(value) : null;
}

function formatAgo(dateValue) {
  const dt = parseDate(dateValue);
  if (!dt || Number.isNaN(dt.getTime())) return 'N/A';
  const diff = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatRemaining(seconds) {
  if (seconds == null) return 'N/A';
  const abs = Math.abs(Number(seconds));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sign = seconds < 0 ? '-' : '';
  return `${sign}${h}h ${m}m`;
}

function soundEnabled() {
  const el = document.getElementById('critical-sound-toggle');
  return Boolean(el && el.checked);
}

function playCriticalAlert() {
  if (!soundEnabled()) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (_err) {
    // ignore audio errors
  }
}

async function fetchTechnicians() {
  try {
    const res = await fetch(`${API_BASE_URL}/worker-technicians`);
    const payload = await res.json();
    if (res.ok && payload.status === 'success' && Array.isArray(payload.technicians)) {
      technicians = payload.technicians;
    }
  } catch (_err) {
    technicians = technicians.length ? technicians : ['Field Team A', 'Field Team B'];
  }

  const select = document.getElementById('filter-assigned');
  if (!select) return;
  const existing = new Set(Array.from(select.options).map((o) => o.value));
  technicians.forEach((name) => {
    if (!existing.has(name)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
  });
}

function complaintComparator(a, b) {
  const aResolved = String(a.report_status || '').toUpperCase() === 'RESOLVED';
  const bResolved = String(b.report_status || '').toUpperCase() === 'RESOLVED';
  if (aResolved !== bResolved) return aResolved ? 1 : -1;

  if (Boolean(a.is_overdue) !== Boolean(b.is_overdue)) return a.is_overdue ? -1 : 1;

  const ap = Number(a.priority_rank || 1);
  const bp = Number(b.priority_rank || 1);
  if (ap !== bp) return bp - ap;

  const at = parseDate(a.report_time)?.getTime() || 0;
  const bt = parseDate(b.report_time)?.getTime() || 0;
  return at - bt;
}

function filteredComplaints() {
  const status = document.getElementById('filter-status')?.value || 'ALL';
  const priority = document.getElementById('filter-priority')?.value || 'ALL';
  const assigned = document.getElementById('filter-assigned')?.value || 'ALL';
  const slaFilter = document.getElementById('filter-sla')?.value || 'ALL';
  const search = (document.getElementById('search-complaint')?.value || '').trim().toLowerCase();

  return complaints
    .filter((item) => (status === 'ALL' ? true : String(item.report_status || '').toUpperCase() === status))
    .filter((item) => (priority === 'ALL' ? true : String(item.priority || '').toUpperCase() === priority))
    .filter((item) => {
      if (assigned === 'ALL') return true;
      return (item.assigned_to || '') === assigned;
    })
    .filter((item) => {
      if (slaFilter === 'ALL') return true;
      if (slaFilter === 'ONLY_BREACHED') return Boolean(item.is_overdue);
      if (slaFilter === 'HIDE_BREACHED') return !Boolean(item.is_overdue);
      return true;
    })
    .filter((item) => {
      if (!search) return true;
      const hay = `${item.report_id} ${item.citizen_id} ${item.description || ''} ${item.issue_category || ''} ${item.assigned_to || ''}`.toLowerCase();
      return hay.includes(search);
    })
    .sort(complaintComparator);
}

function renderKpis(items) {
  const wrap = document.getElementById('worker-kpi-grid');
  if (!wrap) return;

  const now = Date.now();
  const open = items.filter((i) => String(i.report_status || '').toUpperCase() === 'OPEN').length;
  const inProgress = items.filter((i) => ['IN_PROGRESS', 'ACCEPTED'].includes(String(i.report_status || '').toUpperCase())).length;
  const critical = items.filter((i) => String(i.priority || '').toUpperCase() === 'CRITICAL' && String(i.report_status || '').toUpperCase() !== 'RESOLVED').length;
  const overdue = items.filter((i) => Boolean(i.is_overdue)).length;
  const resolvedToday = items.filter((i) => {
    const r = parseDate(i.resolved_at);
    if (!r) return false;
    const d = new Date(now);
    return r.getDate() === d.getDate() && r.getMonth() === d.getMonth() && r.getFullYear() === d.getFullYear();
  }).length;

  const cards = [
    { label: 'Open', value: open },
    { label: 'In Progress', value: inProgress },
    { label: 'Critical', value: critical },
    { label: 'Overdue', value: overdue },
    { label: 'Resolved Today', value: resolvedToday }
  ];

  wrap.innerHTML = cards.map((c) => `<article class="kpi-card"><p>${esc(c.label)}</p><strong>${c.value}</strong></article>`).join('');

  const currentCriticalOpen = new Set(
    items
      .filter((i) => String(i.priority || '').toUpperCase() === 'CRITICAL' && String(i.report_status || '').toUpperCase() !== 'RESOLVED')
      .map((i) => i.report_id)
  );

  const hasNewCritical = Array.from(currentCriticalOpen).some((id) => !previousCriticalOpenIds.has(id));
  if (hasNewCritical) playCriticalAlert();
  previousCriticalOpenIds = currentCriticalOpen;
}

function renderWorkerMap(items, transformers) {
  const mapEl = document.getElementById('worker-map');
  if (!mapEl || typeof L === 'undefined') return;

  if (!workerMap) {
    workerMap = L.map('worker-map').setView([13.05, 80.24], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(workerMap);
    workerComplaintLayer = L.layerGroup().addTo(workerMap);
    workerTransformerLayer = L.layerGroup().addTo(workerMap);
  }

  workerComplaintLayer.clearLayers();
  workerTransformerLayer.clearLayers();

  const bounds = [];
  const transformerSeen = new Set();

  // Show all transformers from backend first.
  (transformers || []).forEach((t) => {
    const lat = Number(t.latitude);
    const lon = Number(t.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    bounds.push([lat, lon]);

    const status = String(t.operational_status || 'UNKNOWN').toUpperCase();
    const tColor = status === 'FAULT' ? '#ff3300' : status === 'MAINTENANCE' ? '#ff6600' : '#00ff88';

    const marker = L.circleMarker([lat, lon], {
      radius: 9,
      color: '#111',
      weight: 2,
      fillColor: tColor,
      fillOpacity: 0.86
    });

    // Hover content requested: transformer identity + state.
    marker.bindTooltip(
      `Transformer T${t.transformer_id} · ${status} · Load ${t.current_load ?? 'N/A'}`,
      { direction: 'top', sticky: true, opacity: 0.92 }
    );
    marker.addTo(workerTransformerLayer);
    transformerSeen.add(String(t.transformer_id));
  });

  // Overlay complaint markers on top.
  items.forEach((item) => {
    const ctx = item.transformer_context;
    if (!ctx || ctx.latitude == null || ctx.longitude == null) return;

    const lat = Number(ctx.latitude);
    const lon = Number(ctx.longitude);
    bounds.push([lat, lon]);

    const markerColor = String(item.priority || '').toUpperCase() === 'CRITICAL'
      ? '#ff3300'
      : String(item.priority || '').toUpperCase() === 'HIGH'
        ? '#ff6600'
        : '#ffcc00';

    const complaintMarker = L.circleMarker([lat, lon], {
      radius: 6,
      color: markerColor,
      weight: 2,
      fillColor: markerColor,
      fillOpacity: 0.45
    });

    complaintMarker.bindPopup(
      `<strong>Complaint #${item.report_id}</strong><br>` +
      `Priority: ${item.priority}<br>` +
      `Status: ${item.report_status}<br>` +
      `Transformer: T${ctx.transformer_id}`
    );
    complaintMarker.addTo(workerComplaintLayer);

    const tKey = String(ctx.transformer_id);
    if (!transformerSeen.has(tKey)) {
      transformerSeen.add(tKey);
      const tColor = String(ctx.status || '').toUpperCase() === 'FAULT'
        ? '#ff3300'
        : String(ctx.status || '').toUpperCase() === 'MAINTENANCE'
          ? '#ff6600'
          : '#00ff88';

      const transformerMarker = L.circleMarker([lat, lon], {
        radius: 9,
        color: '#111',
        weight: 2,
        fillColor: tColor,
        fillOpacity: 0.86
      });
      transformerMarker.bindTooltip(
        `Transformer T${ctx.transformer_id} · ${ctx.status || 'UNKNOWN'} · Load ${ctx.current_load ?? 'N/A'}`,
        { direction: 'top', sticky: true, opacity: 0.92 }
      );
      transformerMarker.addTo(workerTransformerLayer);
    }
  });

  if (bounds.length) {
    workerMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
  }
}

function compactComplaintCard(item) {
  const statusClass = statusPillClass(item.report_status);
  const priorityClass = statusPillClass(item.priority);
  const overdueClass = item.is_overdue ? 'overdue-card' : '';
  const shortDesc = String(item.description || '').slice(0, 120);

  return `
    <article class="item-card complaint-card compact ${overdueClass}" data-open-modal="${item.report_id}" tabindex="0" role="button" aria-label="Open complaint ${item.report_id}">
      <div class="section-head">
        <p><strong>ID:</strong> ${item.report_id}</p>
        <div class="button-row">
          <span class="status-pill ${priorityClass}">${esc(item.priority)}</span>
          <span class="status-pill ${statusClass}">${esc(item.report_status)}</span>
        </div>
      </div>
      <p><strong>${esc(item.issue_category || 'UNKNOWN')}</strong> ${item.is_overdue ? '<span class="chip chip-danger">SLA BREACH</span>' : ''}</p>
      <p>${esc(shortDesc)}${String(item.description || '').length > 120 ? '...' : ''}</p>
      <div class="button-row compact-meta">
        <span>Citizen ${item.citizen_id ?? 'N/A'}</span>
        <span>Reported ${esc(formatAgo(item.report_time))}</span>
        <span>ETA ${esc(formatRemaining(item.eta_seconds_remaining))}</span>
      </div>
      <p class="hint">Click to open action center</p>
    </article>
  `;
}

function technicianOptions(selected) {
  const names = technicians.length ? technicians : ['Field Team A', 'Field Team B', 'Rapid Response Crew'];
  return names.map((name) => `<option value="${esc(name)}" ${name === selected ? 'selected' : ''}>${esc(name)}</option>`).join('');
}

function issueCategoryOptions(selected) {
  return ISSUE_CATEGORIES.map((cat) => `<option value="${cat}" ${cat === selected ? 'selected' : ''}>${cat}</option>`).join('');
}

function noteTimeline(notes) {
  if (!Array.isArray(notes) || !notes.length) {
    return '<p class="hint">No maintenance notes yet.</p>';
  }

  return `<div class="note-list">${notes.slice(0, 8).map((n) => `
      <article class="note-item">
        <p><strong>${esc(n.action_type || 'NOTE')}</strong> · ${esc(n.created_by || 'Worker')}</p>
        <p>${esc(n.note_text || '')}</p>
        <p class="hint">${esc(formatAgo(n.created_at))}</p>
      </article>
    `).join('')}</div>`;
}

function workflowButtons(item) {
  const status = String(item.report_status || '').toUpperCase();
  const buttons = [];

  if (status === 'OPEN') {
    buttons.push(`<button class="mini-btn" data-action="accept" data-id="${item.report_id}" type="button">Accept</button>`);
  }
  if (status === 'OPEN' || status === 'ACCEPTED') {
    buttons.push(`<button class="mini-btn" data-action="start_progress" data-id="${item.report_id}" type="button">Start Work</button>`);
  }
  if (status !== 'RESOLVED') {
    buttons.push(`<button class="mini-btn danger" data-action="resolve" data-id="${item.report_id}" type="button">Resolve</button>`);
  }

  return `<div class="button-row">${buttons.join('')}</div>`;
}

function quickActionButtons(item) {
  return `<div class="button-row quick-actions">${QUICK_ACTIONS.map((qa) => `
      <button class="mini-btn" data-action="quick" data-quick-key="${qa.key}" data-id="${item.report_id}" type="button">${qa.label}</button>
    `).join('')}</div>`;
}

function modalContent(item) {
  const ctx = item.transformer_context;
  return `
    <article class="modal-section">
      <div class="section-head">
        <p><strong>Complaint #${item.report_id}</strong></p>
        <div class="button-row">
          <span class="status-pill ${statusPillClass(item.priority)}">${esc(item.priority)}</span>
          <span class="status-pill ${statusPillClass(item.report_status)}">${esc(item.report_status)}</span>
        </div>
      </div>
      <p><strong>Description:</strong> ${esc(item.description || '')}</p>
      <p><strong>Citizen ID:</strong> ${item.citizen_id ?? 'N/A'}</p>
      <p><strong>Reported:</strong> ${esc(formatAgo(item.report_time))} · <strong>ETA:</strong> ${esc(formatRemaining(item.eta_seconds_remaining))}</p>
      ${item.is_overdue ? '<p><span class="chip chip-danger">SLA BREACH</span></p>' : ''}

      <div class="worker-form-row">
        <div>
          <label>Assigned To</label>
          <select data-role="assign" data-id="${item.report_id}">
            <option value="">Unassigned</option>
            ${technicianOptions(item.assigned_to || '')}
          </select>
        </div>
        <div>
          <label>Issue Category</label>
          <select data-role="category" data-id="${item.report_id}">
            ${issueCategoryOptions(item.issue_category || 'UNKNOWN')}
          </select>
        </div>
      </div>

      ${workflowButtons(item)}
      ${quickActionButtons(item)}

      ${ctx ? `
        <section class="inner-box">
          <p><strong>Nearest Transformer:</strong> T${ctx.transformer_id} · <span class="status-pill ${statusPillClass(ctx.status)}">${esc(ctx.status || 'UNKNOWN')}</span></p>
          <p><strong>Load:</strong> ${ctx.current_load ?? 'N/A'} / ${ctx.capacity ?? 'N/A'}</p>
          <p><strong>Last Reading:</strong> ${ctx.last_sensor_reading ? `Temp ${ctx.last_sensor_reading.temperature}, Volt ${ctx.last_sensor_reading.voltage}, Load ${ctx.last_sensor_reading.load_value}` : 'N/A'}</p>
          ${ctx.map_url ? `<a class="inline-link" target="_blank" href="${esc(ctx.map_url)}">Open location map</a>` : ''}
        </section>
      ` : ''}

      <section class="inner-box">
        <p><strong>Maintenance Notes Timeline</strong></p>
        ${noteTimeline(item.notes)}
      </section>
    </article>
  `;
}

function openModal(reportId) {
  const item = complaints.find((c) => Number(c.report_id) === Number(reportId));
  if (!item) return;

  const overlay = document.getElementById('worker-modal-overlay');
  const content = document.getElementById('worker-modal-content');
  if (!overlay || !content) return;

  activeModalReportId = Number(reportId);
  content.innerHTML = modalContent(item);
  overlay.classList.remove('hidden-card');
  document.body.classList.add('modal-open');
}

function closeModal() {
  const overlay = document.getElementById('worker-modal-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden-card');
  document.body.classList.remove('modal-open');
  activeModalReportId = null;
}

async function postUpdate(payload) {
  const res = await fetch(`${API_BASE_URL}/update-complaint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || data.status !== 'success') {
    throw new Error(data.message || 'Update failed');
  }
}

async function handleModalAction(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;

  const reportId = Number(btn.dataset.id);
  const action = btn.dataset.action;

  try {
    if (action === 'quick') {
      const qa = QUICK_ACTIONS.find((x) => x.key === btn.dataset.quickKey);
      if (!qa) return;
      await postUpdate({ report_id: reportId, action: 'set_status', note_text: qa.note, updated_by: localStorage.getItem('username') || 'Worker', report_status: 'IN_PROGRESS' });
    } else {
      await postUpdate({ report_id: reportId, action, updated_by: localStorage.getItem('username') || 'Worker' });
    }
    await refreshWorkerData();
    openModal(reportId);
  } catch (err) {
    alert(err.message);
  }
}

async function handleModalChange(event) {
  const select = event.target.closest('select[data-role]');
  if (!select) return;

  const reportId = Number(select.dataset.id);
  const role = select.dataset.role;
  const base = complaints.find((c) => Number(c.report_id) === reportId);
  if (!base) return;

  try {
    if (role === 'assign') {
      await postUpdate({ report_id: reportId, assigned_to: select.value || null, action: 'set_status', report_status: base.report_status || 'OPEN', note_text: `Assigned to ${select.value || 'Unassigned'}`, updated_by: localStorage.getItem('username') || 'Worker' });
    }
    if (role === 'category') {
      await postUpdate({ report_id: reportId, issue_category: select.value, action: 'set_status', report_status: base.report_status || 'OPEN', note_text: `Issue category set to ${select.value}`, updated_by: localStorage.getItem('username') || 'Worker' });
    }
    await refreshWorkerData();
    openModal(reportId);
  } catch (err) {
    alert(err.message);
  }
}

function renderQueue() {
  const wrap = document.getElementById('worker-complaints-list');
  if (!wrap) return;

  const items = filteredComplaints();
  if (!items.length) {
    wrap.innerHTML = '<p>No complaints match the current filters.</p>';
    renderWorkerMap([], allTransformers);
    renderKpis(complaints);
    return;
  }

  wrap.innerHTML = items.map(compactComplaintCard).join('');
  renderKpis(complaints);
  renderWorkerMap(items, allTransformers);
}

async function refreshWorkerData() {
  try {
    const [complaintsRes, transformersRes] = await Promise.all([
      fetch(`${API_BASE_URL}/complaints`),
      fetch(`${API_BASE_URL}/transformers`)
    ]);

    const complaintsData = await complaintsRes.json();
    const transformersData = await transformersRes.json();

    if (!complaintsRes.ok || !Array.isArray(complaintsData)) {
      throw new Error('Unable to fetch complaints');
    }

    complaints = complaintsData;
    allTransformers = Array.isArray(transformersData) ? transformersData : [];
    renderQueue();
    if (activeModalReportId) {
      openModal(activeModalReportId);
    }
  } catch (err) {
    const wrap = document.getElementById('worker-complaints-list');
    if (wrap) wrap.innerHTML = `<p>${esc(err.message)}</p>`;
  }
}

function bindFilters() {
  ['filter-status', 'filter-priority', 'filter-assigned', 'filter-sla', 'search-complaint'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', renderQueue);
    el.addEventListener('change', renderQueue);
  });
}

function initModalBindings() {
  const overlay = document.getElementById('worker-modal-overlay');
  const closeBtn = document.getElementById('close-worker-modal');
  const content = document.getElementById('worker-modal-content');

  closeModal();

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (overlay) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeModal();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });

  if (content) {
    content.addEventListener('click', handleModalAction);
    content.addEventListener('change', handleModalChange);
  }
}

function initWorkerDeck() {
  const refreshBtn = document.getElementById('refresh-worker');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshWorkerData);

  const queue = document.getElementById('worker-complaints-list');
  if (queue) {
    queue.addEventListener('click', (event) => {
      const card = event.target.closest('[data-open-modal]');
      if (!card) return;
      openModal(Number(card.dataset.openModal));
    });

    queue.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-open-modal]');
      if (!card) return;
      event.preventDefault();
      openModal(Number(card.dataset.openModal));
    });
  }

  bindFilters();
  initModalBindings();

  fetchTechnicians().then(() => refreshWorkerData());

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshWorkerData, 8000);
}

document.addEventListener('DOMContentLoaded', initWorkerDeck);
