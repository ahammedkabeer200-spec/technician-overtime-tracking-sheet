// Overtime Report Manager - Secure Frontend Application

const state = {
  token: localStorage.getItem('ot_auth_token') || '',
  user: null,
  records: [],
  technicians: [],
  sites: [],
  users: [],
  activeTab: 'sheetView',
  sse: null
};

// Authenticated Fetch Wrapper
async function apiFetch(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    handleLogout();
    throw new Error('Unauthorized');
  }
  return res;
}

function showLoginScreen() {
  document.getElementById('loginScreen').classList.remove('hidden');
}

function hideLoginScreen() {
  document.getElementById('loginScreen').classList.add('hidden');
}

function handleLogout() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('ot_auth_token');
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  showLoginScreen();
}

function updateCurrentUserUI() {
  if (!state.user) return;
  document.getElementById('currentUserName').textContent = state.user.full_name || state.user.username;
  document.getElementById('currentUserRole').textContent = state.user.role;
  // Only Supervisors can create/delete other user logins
  const addUserForm = document.getElementById('addUserForm');
  if (addUserForm) {
    addUserForm.classList.toggle('hidden', state.user.role !== 'Supervisor');
  }
}

// Utility: Today's date in YYYY-MM-DD
function getTodayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Utility: Format YYYY-MM-DD to DD/MM/YYYY for supervisor table display
function formatDateDMY(iso) {
  if (!iso) return '';
  const parts = String(iso).split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return iso;
}

// Utility: Calculate hours between two HH:MM strings (handles overnight shifts)
function computeHours(startStr, endStr) {
  if (!startStr || !endStr) return { hours: 0, overnight: false };
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) {
    return { hours: 0, overnight: false };
  }
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  let diff = endMins - startMins;
  let overnight = false;
  if (diff < 0) {
    diff += 24 * 60;
    overnight = true;
  }
  return {
    hours: Math.round((diff / 60) * 100) / 100,
    overnight
  };
}

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getFilterQuery() {
  const params = new URLSearchParams();
  const startDate = document.getElementById('filterStartDate').value;
  const endDate = document.getElementById('filterEndDate').value;
  const technician = document.getElementById('filterTechnician').value;
  const site = document.getElementById('filterSite').value;
  const search = document.getElementById('filterSearch').value.trim();

  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  if (technician) params.set('technician', technician);
  if (site) params.set('site', site);
  if (search) params.set('search', search);
  return params.toString();
}

// Load Technicians, Sites & Users
async function loadLookups() {
  const [techRes, siteRes, userRes] = await Promise.all([
    apiFetch('/api/technicians'),
    apiFetch('/api/sites'),
    apiFetch('/api/users')
  ]);
  state.technicians = await techRes.json();
  state.sites = await siteRes.json();
  state.users = await userRes.json();

  const techList = document.getElementById('techniciansDatalist');
  techList.innerHTML = state.technicians.map((t) => `<option value="${esc(t.name)}"></option>`).join('');

  const siteList = document.getElementById('sitesDatalist');
  siteList.innerHTML = state.sites.map((s) => `<option value="${esc(s.name)}"></option>`).join('');

  const filterTech = document.getElementById('filterTechnician');
  const curTech = filterTech.value;
  filterTech.innerHTML = `<option value="">All Technicians</option>` +
    state.technicians.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
  filterTech.value = curTech;

  const filterSite = document.getElementById('filterSite');
  const curSite = filterSite.value;
  filterSite.innerHTML = `<option value="">All Sites</option>` +
    state.sites.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  filterSite.value = curSite;

  renderManageLists();
  renderUsersList();
}

// Load Overtime Records
async function loadRecords() {
  const qs = getFilterQuery();
  const res = await apiFetch(`/api/records${qs ? '?' + qs : ''}`);
  state.records = await res.json();
  renderExcelSheet();
  renderRecentEntries();
  renderDashboard();
}

// Render Tab 1: Supervisor Excel Sheet View
function renderExcelSheet() {
  const tbody = document.getElementById('excelSheetBody');
  const records = state.records;
  const minGridRows = Math.max(records.length, 18);
  let html = '';
  let totalHours = 0;

  for (let i = 0; i < minGridRows; i++) {
    const excelRowNum = 6 + i;
    const rec = records[i];
    if (rec) {
      const hrs = Number(rec.hours || 0);
      totalHours += hrs;
      html += `
        <tr data-id="${rec.id}" title="Recorded by: ${esc(rec.recorded_by || 'Supervisor')}">
          <td class="excel-row-number no-print">${excelRowNum}</td>
          <td class="cell-center">${i + 1}</td>
          <td class="cell-center">${esc(formatDateDMY(rec.date))}</td>
          <td>${esc(rec.technician_name)}</td>
          <td>${esc(rec.site)}</td>
          <td class="cell-center">${esc(rec.commenced_on)}</td>
          <td class="cell-center">${esc(rec.finished_on)}</td>
          <td class="cell-right">${hrs.toFixed(2)}</td>
          <td class="cell-actions no-print">
            <button type="button" class="row-btn" onclick="editRecord(${rec.id})" title="Edit row">✏️</button>
            <button type="button" class="row-btn" onclick="deleteRecord(${rec.id})" title="Delete row">🗑️</button>
          </td>
        </tr>
      `;
    } else {
      html += `
        <tr class="empty-grid-row">
          <td class="excel-row-number no-print">${excelRowNum}</td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
          <td class="no-print"></td>
        </tr>
      `;
    }
  }

  tbody.innerHTML = html;
  document.getElementById('sheetTotalHours').textContent = totalHours.toFixed(2);
}

// Render Tab 2: Recent Entries sidebar
function renderRecentEntries() {
  const container = document.getElementById('recentEntriesList');
  if (state.records.length === 0) {
    container.innerHTML = `<p style="color:#64748b;font-size:0.88rem;">No overtime records yet. Add one using the form!</p>`;
    return;
  }

  const latest = [...state.records].reverse().slice(0, 15);
  container.innerHTML = latest.map((r) => `
    <div class="recent-item">
      <div class="recent-item-main">
        <strong>${esc(r.technician_name)}</strong>
        <div class="recent-item-meta">
          📅 ${esc(formatDateDMY(r.date))} • 🏭 ${esc(r.site)} • ⏰ ${esc(r.commenced_on)} → ${esc(r.finished_on)}
          <br/><small style="color:#94a3b8;">Logged by: ${esc(r.recorded_by || 'Supervisor')}</small>
        </div>
      </div>
      <div class="recent-item-right">
        <span class="hours-badge">${Number(r.hours).toFixed(2)}h</span>
        <button type="button" class="row-btn" onclick="editRecord(${r.id})">✏️</button>
        <button type="button" class="row-btn" onclick="deleteRecord(${r.id})">🗑️</button>
      </div>
    </div>
  `).join('');
}

// Render Tab 3: Summary Dashboard & Analytics
function renderDashboard() {
  const records = state.records;
  const totalHours = records.reduce((sum, r) => sum + Number(r.hours || 0), 0);
  const totalShifts = records.length;
  const uniqueTechs = new Set(records.map((r) => r.technician_name)).size;
  const avgHours = totalShifts > 0 ? totalHours / totalShifts : 0;

  document.getElementById('kpiTotalHours').textContent = totalHours.toFixed(2);
  document.getElementById('kpiTotalShifts').textContent = String(totalShifts);
  document.getElementById('kpiActiveTechs').textContent = String(uniqueTechs);
  document.getElementById('kpiAvgHours').textContent = `${avgHours.toFixed(2)} hrs`;

  const byTech = {};
  records.forEach((r) => {
    if (!byTech[r.technician_name]) byTech[r.technician_name] = { hours: 0, shifts: 0 };
    byTech[r.technician_name].hours += Number(r.hours || 0);
    byTech[r.technician_name].shifts += 1;
  });

  const techSorted = Object.entries(byTech).sort((a, b) => b[1].hours - a[1].hours);
  const maxTechHours = techSorted.length > 0 ? techSorted[0][1].hours : 1;

  const techContainer = document.getElementById('techSummaryList');
  techContainer.innerHTML = techSorted.length === 0
    ? `<p style="color:#64748b;font-size:0.88rem;">No data for selected filters.</p>`
    : techSorted.map(([name, stats]) => {
        const pct = Math.min(100, Math.round((stats.hours / maxTechHours) * 100));
        return `
          <div class="summary-row">
            <div class="summary-row-top">
              <span>${esc(name)} <small style="color:#64748b">(${stats.shifts} shifts)</small></span>
              <span>${stats.hours.toFixed(2)} hrs</span>
            </div>
            <div class="summary-bar-track">
              <div class="summary-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      }).join('');

  const bySite = {};
  records.forEach((r) => {
    if (!bySite[r.site]) bySite[r.site] = { hours: 0, shifts: 0 };
    bySite[r.site].hours += Number(r.hours || 0);
    bySite[r.site].shifts += 1;
  });

  const siteSorted = Object.entries(bySite).sort((a, b) => b[1].hours - a[1].hours);
  const maxSiteHours = siteSorted.length > 0 ? siteSorted[0][1].hours : 1;

  const siteContainer = document.getElementById('siteSummaryList');
  siteContainer.innerHTML = siteSorted.length === 0
    ? `<p style="color:#64748b;font-size:0.88rem;">No data for selected filters.</p>`
    : siteSorted.map(([name, stats]) => {
        const pct = Math.min(100, Math.round((stats.hours / maxSiteHours) * 100));
        return `
          <div class="summary-row">
            <div class="summary-row-top">
              <span>${esc(name)} <small style="color:#64748b">(${stats.shifts} shifts)</small></span>
              <span>${stats.hours.toFixed(2)} hrs</span>
            </div>
            <div class="summary-bar-track">
              <div class="summary-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      }).join('');
}

// Render Tab 4: Manage Technicians & Sites
function renderManageLists() {
  const techUl = document.getElementById('techManageList');
  techUl.innerHTML = state.technicians.map((t) => `
    <li>
      <div>
        <strong>${esc(t.name)}</strong>
        ${t.employee_id ? `<span style="color:#64748b;font-size:0.8rem;margin-left:6px;">(${esc(t.employee_id)})</span>` : ''}
      </div>
      <button type="button" class="row-btn" onclick="deleteTechnician(${t.id})">🗑️</button>
    </li>
  `).join('');

  const siteUl = document.getElementById('siteManageList');
  siteUl.innerHTML = state.sites.map((s) => `
    <li>
      <div>
        <strong>${esc(s.name)}</strong>
        ${s.location ? `<span style="color:#64748b;font-size:0.8rem;margin-left:6px;">• ${esc(s.location)}</span>` : ''}
      </div>
      <button type="button" class="row-btn" onclick="deleteSite(${s.id})">🗑️</button>
    </li>
  `).join('');
}

// Render Tab 5: Authorized Users List
function renderUsersList() {
  const ul = document.getElementById('userManageList');
  if (!ul) return;
  const isSupervisor = state.user && state.user.role === 'Supervisor';
  ul.innerHTML = state.users.map((u) => `
    <li>
      <div>
        <strong>${esc(u.full_name)}</strong>
        <span style="color:#64748b;font-size:0.82rem;margin-left:6px;">(@${esc(u.username)})</span>
        <span class="role-tag" style="margin-left:6px;">${esc(u.role)}</span>
      </div>
      ${isSupervisor && u.id !== state.user.id
        ? `<button type="button" class="row-btn" onclick="deleteUserAccount(${u.id})" title="Revoke Login Permission">🗑️ Revoke</button>`
        : `<small style="color:#64748b;">Active</small>`}
    </li>
  `).join('');
}

window.deleteUserAccount = async function(id) {
  if (!confirm('Revoke login permission for this user?')) return;
  const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
  if (res.ok) {
    showToast('User login revoked');
    await loadLookups();
  }
};

window.editRecord = function(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;

  switchTab('quickLogView');
  document.getElementById('editRecordId').value = rec.id;
  document.getElementById('formDate').value = rec.date;
  document.getElementById('formTechnician').value = rec.technician_name;
  document.getElementById('formSite').value = rec.site;
  document.getElementById('formCommenced').value = rec.commenced_on;
  document.getElementById('formFinished').value = rec.finished_on;
  document.getElementById('formHours').value = rec.hours;
  document.getElementById('formRemarks').value = rec.remarks || '';

  document.getElementById('formModeTitle').textContent = `✏️ Edit Overtime Record #${rec.id}`;
  document.getElementById('btnSubmitForm').textContent = '💾 Update Overtime Record';
  document.getElementById('btnCancelEdit').classList.remove('hidden');
};

window.deleteRecord = async function(id) {
  if (!confirm('Delete this overtime record?')) return;
  await apiFetch(`/api/records/${id}`, { method: 'DELETE' });
  showToast('Overtime record deleted');
  await loadRecords();
};

window.deleteTechnician = async function(id) {
  await apiFetch(`/api/technicians/${id}`, { method: 'DELETE' });
  await loadLookups();
};

window.deleteSite = async function(id) {
  await apiFetch(`/api/sites/${id}`, { method: 'DELETE' });
  await loadLookups();
};

function resetMainForm() {
  document.getElementById('editRecordId').value = '';
  document.getElementById('formDate').value = getTodayISO();
  document.getElementById('formTechnician').value = '';
  document.getElementById('formSite').value = '';
  document.getElementById('formCommenced').value = '17:00';
  document.getElementById('formFinished').value = '20:00';
  document.getElementById('formHours').value = '3';
  document.getElementById('formRemarks').value = '';
  document.getElementById('overnightNotice').classList.add('hidden');
  document.getElementById('formModeTitle').textContent = '📝 Record Technician Overtime';
  document.getElementById('btnSubmitForm').textContent = '✅ Save Overtime Record';
  document.getElementById('btnCancelEdit').classList.add('hidden');
}

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === tabId);
  });
  const filterBar = document.getElementById('filterBar');
  filterBar.classList.toggle('hidden', tabId === 'manageListsView' || tabId === 'securityView');
}

function initSSE() {
  if (state.sse) state.sse.close();
  if (!state.token) return;

  const badge = document.getElementById('syncStatus');
  const text = document.getElementById('syncText');
  const es = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  state.sse = es;

  es.onopen = () => {
    badge.classList.add('connected');
    text.textContent = 'Live Sync';
  };

  es.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type && msg.type !== 'connected') {
        loadLookups();
        loadRecords();
      }
    } catch (_) {}
  };

  es.onerror = () => {
    text.textContent = 'Reconnecting...';
  };
}

async function bootstrapAuthenticatedSession() {
  try {
    const meRes = await apiFetch('/api/auth/me');
    if (!meRes.ok) throw new Error('Invalid session');
    const { user } = await meRes.json();
    state.user = user;
    hideLoginScreen();
    updateCurrentUserUI();
    await loadLookups();
    await loadRecords();
    initSSE();
  } catch (_) {
    showLoginScreen();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const today = getTodayISO();
  document.getElementById('inlineDate').value = today;
  document.getElementById('formDate').value = today;

  // Demo quick-fill buttons on Login Screen
  document.getElementById('btnFillSupervisor').addEventListener('click', () => {
    document.getElementById('loginUsername').value = 'supervisor';
    document.getElementById('loginPassword').value = 'Supervisor@123';
  });
  document.getElementById('btnFillEngineer').addEventListener('click', () => {
    document.getElementById('loginUsername').value = 'engineer1';
    document.getElementById('loginPassword').value = 'Engineer@123';
  });

  // Login Form Submit
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('loginError');
    errBox.classList.add('hidden');

    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        errBox.textContent = data.error || 'Login failed';
        errBox.classList.remove('hidden');
        return;
      }

      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('ot_auth_token', data.token);
      document.getElementById('loginPassword').value = '';
      hideLoginScreen();
      updateCurrentUserUI();
      showToast(`Welcome, ${data.user.full_name}!`);
      await loadLookups();
      await loadRecords();
      initSSE();
    } catch (err) {
      errBox.textContent = 'Network error signing in.';
      errBox.classList.remove('hidden');
    }
  });

  // Logout Button
  document.getElementById('btnLogout').addEventListener('click', () => {
    handleLogout();
    showToast('Signed out securely');
  });

  // Navigation Tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Inline Quick Bar hours auto-calculation
  const updateInlineHours = () => {
    const s = document.getElementById('inlineStart').value;
    const e = document.getElementById('inlineEnd').value;
    const { hours, overnight } = computeHours(s, e);
    document.getElementById('inlineHoursPreview').textContent =
      `${hours.toFixed(2)} hrs${overnight ? ' (Night)' : ''}`;
  };
  document.getElementById('inlineStart').addEventListener('input', updateInlineHours);
  document.getElementById('inlineEnd').addEventListener('input', updateInlineHours);

  // Inline Quick Add Submit
  document.getElementById('inlineAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById('inlineDate').value;
    const technician_name = document.getElementById('inlineTech').value;
    const site = document.getElementById('inlineSite').value;
    const commenced_on = document.getElementById('inlineStart').value;
    const finished_on = document.getElementById('inlineEnd').value;
    const { hours } = computeHours(commenced_on, finished_on);

    const res = await apiFetch('/api/records', {
      method: 'POST',
      body: JSON.stringify({ date, technician_name, site, commenced_on, finished_on, hours })
    });

    if (res.ok) {
      document.getElementById('inlineTech').value = '';
      document.getElementById('inlineSite').value = '';
      showToast('Added to Overtime Report!');
      await loadLookups();
      await loadRecords();
    }
  });

  // Main Log Overtime Form auto-calculation
  const updateFormHours = () => {
    const s = document.getElementById('formCommenced').value;
    const e = document.getElementById('formFinished').value;
    const { hours, overnight } = computeHours(s, e);
    document.getElementById('formHours').value = hours;
    document.getElementById('overnightNotice').classList.toggle('hidden', !overnight);
  };
  document.getElementById('formCommenced').addEventListener('input', updateFormHours);
  document.getElementById('formFinished').addEventListener('input', updateFormHours);

  document.querySelectorAll('.chip-btn').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('formCommenced').value = chip.dataset.start;
      document.getElementById('formFinished').value = chip.dataset.end;
      updateFormHours();
    });
  });

  document.getElementById('overtimeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('editRecordId').value;
    const payload = {
      date: document.getElementById('formDate').value,
      technician_name: document.getElementById('formTechnician').value,
      site: document.getElementById('formSite').value,
      commenced_on: document.getElementById('formCommenced').value,
      finished_on: document.getElementById('formFinished').value,
      hours: Number(document.getElementById('formHours').value),
      remarks: document.getElementById('formRemarks').value
    };

    const url = editId ? `/api/records/${editId}` : '/api/records';
    const method = editId ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showToast(editId ? 'Record updated!' : 'Overtime logged!');
      resetMainForm();
      await loadLookups();
      await loadRecords();
    }
  });

  document.getElementById('btnCancelEdit').addEventListener('click', resetMainForm);

  ['filterStartDate', 'filterEndDate', 'filterTechnician', 'filterSite', 'filterSearch'].forEach((id) => {
    document.getElementById(id).addEventListener('input', loadRecords);
  });

  document.getElementById('btnClearFilters').addEventListener('click', () => {
    document.getElementById('filterStartDate').value = '';
    document.getElementById('filterEndDate').value = '';
    document.getElementById('filterTechnician').value = '';
    document.getElementById('filterSite').value = '';
    document.getElementById('filterSearch').value = '';
    loadRecords();
  });

  // Manage Technicians & Sites
  document.getElementById('addTechForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newTechName').value;
    const employee_id = document.getElementById('newTechEmpId').value;
    await apiFetch('/api/technicians', {
      method: 'POST',
      body: JSON.stringify({ name, employee_id })
    });
    document.getElementById('newTechName').value = '';
    document.getElementById('newTechEmpId').value = '';
    showToast('Technician saved!');
    await loadLookups();
  });

  document.getElementById('addSiteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newSiteName').value;
    const location = document.getElementById('newSiteLocation').value;
    await apiFetch('/api/sites', {
      method: 'POST',
      body: JSON.stringify({ name, location })
    });
    document.getElementById('newSiteName').value = '';
    document.getElementById('newSiteLocation').value = '';
    showToast('Site saved!');
    await loadLookups();
  });

  // Add Authorized User (Supervisor only)
  document.getElementById('addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('newUserUsername').value.trim();
    const full_name = document.getElementById('newUserFullName').value.trim();
    const role = document.getElementById('newUserRole').value;
    const password = document.getElementById('newUserPassword').value;

    const res = await apiFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, full_name, role, password })
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('newUserUsername').value = '';
      document.getElementById('newUserFullName').value = '';
      document.getElementById('newUserPassword').value = '';
      showToast(`Granted login permission to ${full_name}`);
      await loadLookups();
    } else {
      showToast(data.error || 'Could not create user');
    }
  });

  // Change Password Form
  document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('curPass').value;
    const newPassword = document.getElementById('newPass').value;
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('curPass').value = '';
      document.getElementById('newPass').value = '';
      showToast('Password updated successfully!');
    } else {
      showToast(data.error || 'Failed to update password');
    }
  });

  // Export Excel (.xlsx) with Auth Token
  document.getElementById('btnExportExcel').addEventListener('click', () => {
    const qs = getFilterQuery();
    const sep = qs ? '&' : '';
    window.location.href = `/api/export-excel?${qs}${sep}token=${encodeURIComponent(state.token)}`;
    showToast('Downloading Supervisor Overtime_Report.xlsx...');
  });

  // Import Excel (.xlsx)
  document.getElementById('excelFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result.split(',')[1];
      const res = await apiFetch('/api/import-excel', {
        method: 'POST',
        body: JSON.stringify({ base64Data })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Imported ${data.importedCount} rows from Excel!`);
        await loadLookups();
        await loadRecords();
      } else {
        showToast(`Import error: ${data.error}`);
      }
      e.target.value = '';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btnPrintReport').addEventListener('click', () => {
    window.print();
  });

  const modal = document.getElementById('connectModal');
  document.getElementById('btnConnectDevices').addEventListener('click', async () => {
    modal.classList.remove('hidden');
    const res = await apiFetch('/api/network-info');
    const info = await res.json();
    const box = document.getElementById('networkUrlsContainer');
    const publicOrLanUrl = window.location.origin.includes('localhost') && info.networkUrls.length > 0
      ? info.networkUrls[0].url
      : window.location.origin;

    box.innerHTML = `
      <div class="url-pill">
        <span>${esc(publicOrLanUrl)}</span>
        <small>Share Link</small>
      </div>
    `;
    document.getElementById('qrCodeImage').src =
      `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(publicOrLanUrl)}`;
  });

  document.getElementById('btnCloseModal').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  let deferredPrompt = null;
  const btnInstall = document.getElementById('btnInstallPwa');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btnInstall.classList.remove('hidden');
  });

  btnInstall.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btnInstall.classList.add('hidden');
  });

  // Check if user already has a valid token
  if (state.token) {
    await bootstrapAuthenticatedSession();
  } else {
    showLoginScreen();
  }
});
