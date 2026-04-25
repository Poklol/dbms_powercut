const API_BASE_URL = 'http://127.0.0.1:5000';

let transformerLoadChart;
let outageChart;
let adminRefreshTimer;
let transformerMap;
let transformerMarkerLayer;

function setMessage(elementId, text, ok = true) {
  const target = document.getElementById(elementId);
  if (!target) {
    return;
  }

  target.textContent = text;
  target.classList.remove('ok', 'err');
  target.classList.add(ok ? 'ok' : 'err');
}

function statusPillClass(statusText) {
  const value = String(statusText || '').toUpperCase();
  if (value.includes('FAULT') || value.includes('DOWN') || value.includes('OUTAGE') || value.includes('OPEN')) {
    return 'pill-red';
  }
  if (value.includes('MAINTENANCE') || value.includes('PROGRESS') || value.includes('PENDING') || value.includes('HIGH')) {
    return 'pill-orange';
  }
  return 'pill-yellow';
}

function transformerStatusPill(item) {
  const status = String(item.operational_status || 'UNKNOWN').toUpperCase();
  const load = Number(item.current_load || 0);
  const capacity = Number(item.capacity || 0);

  if (status === 'FAULT') {
    return 'pill-red';
  }

  if (capacity > 0 && load / capacity >= 0.8) {
    return 'pill-orange';
  }

  return 'pill-yellow';
}

function mapStyleForStatus(statusText) {
  const value = String(statusText || '').toUpperCase();
  if (value === 'FAULT') {
    return { color: '#ff3300', icon: '❌' };
  }
  if (value === 'MAINTENANCE') {
    return { color: '#ff6600', icon: '📍' };
  }
  if (value === 'ACTIVE') {
    return { color: '#00ff88', icon: '✔' };
  }
  return { color: '#ffcc00', icon: '•' };
}

function createMapIcon(style) {
  return L.divIcon({
    className: 'map-marker-shell',
    html: `<span class="map-marker-dot" style="background:${style.color}">${style.icon}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function initTransformerMap() {
  const mapContainer = document.getElementById('map');
  if (!mapContainer || typeof L === 'undefined' || transformerMap) {
    return;
  }

  transformerMap = L.map('map').setView([11.1271, 78.6569], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(transformerMap);
  transformerMarkerLayer = L.layerGroup().addTo(transformerMap);
}

function updateTransformerMap(transformers) {
  if (!transformerMap || !transformerMarkerLayer) {
    return;
  }

  transformerMarkerLayer.clearLayers();

  transformers.forEach((item) => {
    const lat = Number(item.latitude);
    const lon = Number(item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return;
    }

    const status = item.operational_status || 'UNKNOWN';
    const markerStyle = mapStyleForStatus(status);

    const marker = L.marker([lat, lon], {
      icon: createMapIcon(markerStyle),
      title: `Transformer ${item.transformer_id}`
    });

    marker.bindPopup(
      `<strong>Transformer ID:</strong> ${item.transformer_id}<br>` +
      `<strong>Status:</strong> ${status}<br>` +
      `<strong>Load:</strong> ${item.current_load ?? 'N/A'}`
    );
    marker.addTo(transformerMarkerLayer);
  });
}

async function handleLogin() {
  const form = document.getElementById('login-form');
  if (!form) {
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('login-message', 'Checking credentials...', true);

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const payload = await response.json();

      if (!response.ok || payload.status !== 'success') {
        setMessage('login-message', payload.message || 'Login failed', false);
        return;
      }

      localStorage.setItem('user_id', String(payload.user_id));
      localStorage.setItem('role', payload.role);
      localStorage.setItem('citizen_id', payload.citizen_id === null ? '' : String(payload.citizen_id));
      localStorage.setItem('username', username);

      const rolePageMap = {
        citizen: 'citizen.html',
        worker: 'worker.html',
        admin: 'admin.html'
      };

      const nextPage = rolePageMap[payload.role];
      if (!nextPage) {
        setMessage('login-message', 'Unknown role returned by backend', false);
        return;
      }

      window.location.href = nextPage;
    } catch (error) {
      setMessage('login-message', 'Backend not reachable. Confirm Flask is running.', false);
    }
  });
}

async function handleCitizenComplaint() {
  const form = document.getElementById('complaint-form');
  if (!form) {
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const description = document.getElementById('description').value.trim();
    const citizenId = Number(localStorage.getItem('citizen_id'));

    if (!description) {
      setMessage('complaint-message', 'Description is required.', false);
      return;
    }
    if (!citizenId) {
      setMessage('complaint-message', 'Citizen ID missing. Please login again as a citizen user.', false);
      return;
    }

    setMessage('complaint-message', 'Submitting complaint...', true);

    try {
      const response = await fetch(`${API_BASE_URL}/add-complaint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, citizen_id: citizenId })
      });

      const payload = await response.json();
      if (!response.ok || payload.status !== 'success') {
        setMessage('complaint-message', payload.message || 'Failed to add complaint', false);
        return;
      }

      form.reset();
      setMessage('complaint-message', `Complaint submitted (ID: ${payload.report_id}).`, true);
      alert('Complaint submitted successfully');
    } catch (error) {
      setMessage('complaint-message', 'Unable to submit complaint now.', false);
    }
  });
}

async function loadComplaints() {
  const wrap = document.getElementById('complaints-list');
  if (!wrap) {
    return;
  }

  wrap.innerHTML = '<p>Loading complaints...</p>';
  try {
    const response = await fetch(`${API_BASE_URL}/complaints`);
    const complaints = await response.json();

    if (!response.ok) {
      wrap.innerHTML = '<p>Failed to fetch complaints.</p>';
      return;
    }

    if (!complaints.length) {
      wrap.innerHTML = '<p>No complaints available.</p>';
      return;
    }

    wrap.innerHTML = complaints.map((item) => {
      const status = item.report_status || 'UNKNOWN';
      const canResolve = String(status).toUpperCase() !== 'RESOLVED';
      const resolveButton = canResolve
        ? `<button class="resolve-btn" data-id="${item.report_id}">Mark Resolved</button>`
        : '<span class="status-pill pill-yellow">RESOLVED</span>';

      return `
        <article class="item-card">
          <p><strong>ID:</strong> ${item.report_id}</p>
          <p><strong>Description:</strong> ${item.description || ''}</p>
          <p><strong>Status:</strong> <span class="status-pill ${statusPillClass(status)}">${status}</span></p>
          <p><strong>Citizen ID:</strong> ${item.citizen_id ?? 'N/A'}</p>
          ${resolveButton}
        </article>
      `;
    }).join('');

    wrap.querySelectorAll('.resolve-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        const reportId = Number(button.dataset.id);
        await updateComplaint(reportId, 'RESOLVED');
        await loadComplaints();
      });
    });
  } catch (error) {
    wrap.innerHTML = '<p>Backend not reachable. Verify Flask is running.</p>';
  }
}

async function updateComplaint(reportId, reportStatus) {
  await fetch(`${API_BASE_URL}/update-complaint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report_id: reportId, report_status: reportStatus })
  });
}

function updateTransformerChart(transformers) {
  const canvas = document.getElementById('transformer-load-chart');
  if (!canvas || typeof Chart === 'undefined') {
    return;
  }

  const labels = transformers.map((t) => `T-${t.transformer_id}`);
  const loads = transformers.map((t) => Number(t.current_load || 0));
  const colors = transformers.map((t) => {
    const cls = transformerStatusPill(t);
    if (cls === 'pill-red') {
      return 'rgba(255, 51, 0, 0.85)';
    }
    if (cls === 'pill-orange') {
      return 'rgba(255, 102, 0, 0.85)';
    }
    return 'rgba(255, 204, 0, 0.9)';
  });

  if (transformerLoadChart) {
    transformerLoadChart.data.labels = labels;
    transformerLoadChart.data.datasets[0].data = loads;
    transformerLoadChart.data.datasets[0].backgroundColor = colors;
    transformerLoadChart.update();
    return;
  }

  transformerLoadChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Current Load',
        data: loads,
        backgroundColor: colors,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#ffffff' } }
      },
      scales: {
        x: { ticks: { color: '#ffffff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
        y: { ticks: { color: '#ffffff' }, grid: { color: 'rgba(255,255,255,0.08)' } }
      }
    }
  });
}

function updateOutageChart(outages) {
  const canvas = document.getElementById('outage-chart');
  if (!canvas || typeof Chart === 'undefined') {
    return;
  }

  const counts = { ONGOING: 0, RESOLVED: 0, OTHER: 0 };
  outages.forEach((o) => {
    const s = String(o.outage_status || '').toUpperCase();
    if (s === 'ONGOING') {
      counts.ONGOING += 1;
    } else if (s === 'RESOLVED') {
      counts.RESOLVED += 1;
    } else {
      counts.OTHER += 1;
    }
  });

  const data = [counts.ONGOING, counts.RESOLVED, counts.OTHER];
  const labels = ['ONGOING', 'RESOLVED', 'OTHER'];

  if (outageChart) {
    outageChart.data.labels = labels;
    outageChart.data.datasets[0].data = data;
    outageChart.update();
    return;
  }

  outageChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: ['rgba(255, 51, 0, 0.9)', 'rgba(255, 204, 0, 0.95)', 'rgba(255, 102, 0, 0.8)'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#ffffff' } }
      }
    }
  });
}

async function loadTransformers() {
  const wrap = document.getElementById('transformer-list');
  if (!wrap) {
    return [];
  }

  wrap.innerHTML = '<p>Loading transformers...</p>';
  try {
    const response = await fetch(`${API_BASE_URL}/transformers`);
    const transformers = await response.json();

    if (!response.ok) {
      wrap.innerHTML = '<p>Failed to fetch transformers.</p>';
      return [];
    }

    if (!transformers.length) {
      wrap.innerHTML = '<p>No transformer data found.</p>';
      updateTransformerChart([]);
      return [];
    }

    wrap.innerHTML = transformers.map((item) => {
      const status = item.operational_status || 'UNKNOWN';
      const badgeClass = transformerStatusPill(item);
      return `
        <article class="item-card">
          <p><strong>Transformer ID:</strong> ${item.transformer_id}</p>
          <p><strong>Load:</strong> ${item.current_load ?? 'N/A'}</p>
          <p><strong>Capacity:</strong> ${item.capacity ?? 'N/A'}</p>
          <p><strong>Status:</strong> <span class="status-pill ${badgeClass}">${status}</span></p>
        </article>
      `;
    }).join('');

    updateTransformerChart(transformers);
    updateTransformerMap(transformers);
    return transformers;
  } catch (error) {
    wrap.innerHTML = '<p>Backend not reachable. Verify Flask is running.</p>';
    return [];
  }
}

async function loadOutages() {
  const wrap = document.getElementById('outage-list');
  if (!wrap) {
    return [];
  }

  wrap.innerHTML = '<p>Loading outages...</p>';

  try {
    const response = await fetch(`${API_BASE_URL}/outages`);
    const outages = await response.json();

    if (!response.ok) {
      wrap.innerHTML = '<p>Failed to fetch outages.</p>';
      return [];
    }

    if (!outages.length) {
      wrap.innerHTML = '<p>No outages found.</p>';
      updateOutageChart([]);
      return [];
    }

    wrap.innerHTML = outages.map((item) => {
      const status = item.outage_status || 'UNKNOWN';
      return `
        <article class="item-card">
          <p><strong>Outage ID:</strong> ${item.outage_id}</p>
          <p><strong>Transformer:</strong> ${item.transformer_id ?? 'N/A'}</p>
          <p><strong>Reason:</strong> ${item.reason || 'N/A'}</p>
          <p><strong>Severity:</strong> ${item.severity || 'N/A'}</p>
          <p><strong>Status:</strong> <span class="status-pill ${statusPillClass(status)}">${status}</span></p>
        </article>
      `;
    }).join('');

    updateOutageChart(outages);
    return outages;
  } catch (error) {
    wrap.innerHTML = '<p>Backend not reachable. Verify Flask is running.</p>';
    return [];
  }
}

async function refreshAdminData() {
  await Promise.all([loadTransformers(), loadOutages()]);
}

async function submitSensorReading(payload) {
  const response = await fetch(`${API_BASE_URL}/add-reading`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  return { response, data };
}

function handleSensorInput() {
  const form = document.getElementById('sensor-form');
  if (!form) {
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      sensor_id: Number(document.getElementById('sensor-id').value),
      temperature: Number(document.getElementById('sensor-temperature').value),
      voltage: Number(document.getElementById('sensor-voltage').value),
      load: Number(document.getElementById('sensor-load').value)
    };

    setMessage('sensor-message', 'Submitting reading and running triggers...', true);

    try {
      const { response, data } = await submitSensorReading(payload);
      if (!response.ok || data.status !== 'success') {
        setMessage('sensor-message', data.message || 'Failed to add reading.', false);
        return;
      }

      setMessage('sensor-message', 'Reading added. Dashboard refreshed with latest transformer and outage data.', true);
      form.reset();
      await refreshAdminData();
    } catch (error) {
      setMessage('sensor-message', 'Backend not reachable. Confirm Flask is running.', false);
    }
  });

  const demoButton = document.getElementById('demo-fault');
  if (demoButton) {
    demoButton.addEventListener('click', async () => {
      const demoPayload = { sensor_id: 1, temperature: 95, voltage: 231, load: 500 };
      setMessage('sensor-message', 'Running fault demo with temperature 95...', true);

      try {
        const { response, data } = await submitSensorReading(demoPayload);
        if (!response.ok || data.status !== 'success') {
          setMessage('sensor-message', data.message || 'Demo run failed.', false);
          return;
        }

        setMessage('sensor-message', 'Fault demo completed. Check red FAULT badges and outage feed.', true);
        await refreshAdminData();
      } catch (error) {
        setMessage('sensor-message', 'Backend not reachable. Confirm Flask is running.', false);
      }
    });
  }
}

function bindPageActions() {
  const currentPage = document.body.dataset.page;

  if (currentPage === 'login') {
    handleLogin();
    return;
  }

  if (currentPage === 'citizen') {
    handleCitizenComplaint();
    return;
  }

  if (currentPage === 'worker') {
    loadComplaints();
    const refreshButton = document.getElementById('refresh-complaints');
    if (refreshButton) {
      refreshButton.addEventListener('click', loadComplaints);
    }
    return;
  }

  if (currentPage === 'admin') {
    initTransformerMap();
    handleSensorInput();
    refreshAdminData();

    if (adminRefreshTimer) {
      clearInterval(adminRefreshTimer);
    }
    adminRefreshTimer = setInterval(refreshAdminData, 5000);

    const refreshTransformers = document.getElementById('refresh-transformers');
    if (refreshTransformers) {
      refreshTransformers.addEventListener('click', loadTransformers);
    }

    const refreshOutages = document.getElementById('refresh-outages');
    if (refreshOutages) {
      refreshOutages.addEventListener('click', loadOutages);
    }
  }
}

document.addEventListener('DOMContentLoaded', bindPageActions);
