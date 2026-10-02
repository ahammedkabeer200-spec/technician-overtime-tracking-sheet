// Overtime Report Manager - Secure Frontend with Admin, Forgot Password & Auto-Backup Vault

const VAULT_STORAGE_KEY = 'ot_auto_backup_vault_v2';

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

function isAdminOrSupervisor() {
  return state.user && (state.user.role === 'Admin' || state.user.role === 'Supervisor');
}

function updateCurrentUserUI() {
  if (!state.user) return;
  document.getElementById('currentUserName').textContent = state.user.full_name || state.user.username;
  document.getElementById('currentUserRole').textContent = state.user.role;
  const addUserForm = document.getElementById('addUserForm');
  if (addUserForm) {
    addUserForm.classList.toggle('hidden', !isAdminOrSupervisor());
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

function formatDateDMY(iso) {
  if (!iso) return '';
  const parts = String(iso).split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return iso;
}

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
  setTimeout(() => toast.remove(), 3500);
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

// --- BROWSER AUTO-BACKUP VAULT (Protects data across cloud app updates) ---
function getLocalVault() {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

async function syncServerToLocalVault() {
  try {
    const res = await apiFetch('/api/backup/snapshot');
    if (!res.ok) return;
    const serverSnapshot = await res.json();
    const existingVault = getLocalVault();

    // Check if local vault has records that are missing on the server (e.g. after a cloud redeploy)
    if (
      existingVault &&
      Array.isArray(existingVault.overtime_records) &&
      existingVault.overtime_records.length > serverSnapshot.overtime_records.length &&
      isAdminOrSupervisor()
    ) {
      document.getElementById('vaultRecoveryBanner').classList.remove('hidden');
    } else {
      document.getElementById('vaultRecoveryBanner').classList.add('hidden');
      localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(serverSnapshot));
    }

    const vaultNow = getLocalVault() || serverSnapshot;
    const vaultStatus = document.getElementById('vaultStatusText');
    if (vaultStatus) {
      vaultStatus.textContent = `Auto-Vault Active: ${vaultNow.overtime_records?.length || 0} records, ${vaultNow.technicians?.length || 0} technicians, ${vaultNow.users?.length || 0} users mirrored safely.`;
    }
  } catch (_) {}
}

async function restoreFromLocalVault() {
  const vault = getLocalVault();
  if (!vault) {
    showToast('No local vault snapshot found in this browser.');
    return;
  }
  const res = await apiFetch('/api/backup/restore', {
    method: 'POST',
    body: JSON.stringify({ snapshot: vault, mode: 'merge' })
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('vaultRecoveryBanner').classList.add('hidden');
    showToast(`Restored ${data.restoredRecords} records, ${data.restoredTechs} technicians, ${data.restoredUsers} users!`);
    await loadLookups();
    await loadRecords();
  } else {
    showToast(data.error || 'Vault restore failed');
  }
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
  await syncServerToLocalVault();
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

// Render Tab 5: Admin User Management List
function renderUsersList() {
  const ul = document.getElementById('userManageList');
  if (!ul) return;
  const canManage = isAdminOrSupervisor();
  ul.innerHTML = state.users.map((u) => `
    <li>
      <div>
        <strong>${esc(u.full_name)}</strong>
        <span style="color:#64748b;font-size:0.82rem;margin-left:6px;">(@${esc(u.username)})</span>
        <span class="role-tag" style="margin-left:6px;">${esc(u.role)}</span>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        ${canManage
          ? `<button type="button" class="row-btn" onclick="startEditUser(${u.id})" title="Reset Password or Change Role">🔑 Edit / Reset Pass</button>`
          : ''}
        ${canManage && u.id !== state.user.id
          ? `<button type="button" class="row-btn" onclick="deleteUserAccount(${u.id})" title="Delete User">🗑️</button>`
          : ''}
      </div>
    </li>
  `).join('');
}

// Admin Edit User / Reset Password handler
window.startEditUser = function(id) {
  const target = state.users.find((u) => u.id === id);
  if (!target) return;

  document.getElementById('editUserId').value = target.id;
  const usernameInput = document.getElementById('newUserUsername');
  usernameInput.value = target.username;
  usernameInput.disabled = true;

  document.getElementById('newUserFullName').value = target.full_name;
  document.getElementById('newUserRole').value = target.role;

  const passInput = document.getElementById('newUserPassword');
  passInput.value = '';
  passInput.required = false;
  passInput.placeholder = 'Leave blank to keep, or type new password';
  document.getElementById('lblUserPassword').textContent = 'New Password (Optional)';

  document.getElementById('newUserPin').value = '';
  document.getElementById('newUserPin').placeholder = 'New PIN (Optional)';

  document.getElementById('btnCreateUser').textContent = `💾 Save / Reset @${target.username}`;
  document.getElementById('btnCancelUserEdit').classList.remove('hidden');
};

function resetUserForm() {
  document.getElementById('editUserId').value = '';
  const usernameInput = document.getElementById('newUserUsername');
  usernameInput.value = '';
  usernameInput.disabled = false;
  document.getElementById('newUserFullName').value = '';
  document.getElementById('newUserRole').value = 'Engineer';

  const passInput = document.getElementById('newUserPassword');
  passInput.value = '';
  passInput.required = true;
  passInput.placeholder = 'Set password';
  document.getElementById('lblUserPassword').textContent = 'Password (min 6) *';

  document.getElementById('newUserPin').value = '1234';
  document.getElementById('btnCreateUser').textContent = '➕ Create User Account';
  document.getElementById('btnCancelUserEdit').classList.add('hidden');
}

window.deleteUserAccount = async function(id) {
  if (!confirm('Delete this user account and revoke login access?')) return;
  const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
  if (res.ok) {
    showToast('User account deleted');
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
    text.textContent = 'Backup & Sync Active';
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
  document.getElementById('btnFillAdmin').addEventListener('click', () => {
    document.getElementById('loginUsername').value = 'admin';
    document.getElementById('loginPassword').value = 'Admin@123';
  });
  document.getElementById('btnFillSupervisor').addEventListener('click', () => {
    document.getElementById('loginUsername').value = 'supervisor';
    document.getElementById('loginPassword').value = 'Supervisor@123';
  });
  document.getElementById('btnFillEngineer').addEventListener('click', () => {
    document.getElementById('loginUsername').value = 'engineer1';
    document.getElementById('loginPassword').value = 'Engineer@123';
  });

  // Toggle between Sign In & Forgot Password forms
  document.getElementById('btnShowForgot').addEventListener('click', () => {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('forgotPasswordForm').classList.remove('hidden');
    document.getElementById('forgotUsername').value = document.getElementById('loginUsername').value;
  });

  document.getElementById('btnBackToLogin').addEventListener('click', () => {
    document.getElementById('forgotPasswordForm').classList.add('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
  });

  // Fetch recovery hint when typing username in Forgot Password
  document.getElementById('forgotUsername').addEventListener('blur', async (e) => {
    const u = e.target.value.trim();
    if (!u) return;
    try {
      const res = await fetch(`/api/auth/recovery-hint?username=${encodeURIComponent(u)}`);
      if (res.ok) {
        const info = await res.json();
        document.getElementById('forgotHintText').textContent = `Hint for ${info.full_name}: ${info.hint}`;
      }
    } catch (_) {}
  });

  // Forgot Password Submit
  document.getElementById('forgotPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('forgotError');
    errBox.classList.add('hidden');

    const username = document.getElementById('forgotUsername').value.trim();
    const recoveryPin = document.getElementById('forgotPin').value.trim();
    const newPassword = document.getElementById('forgotNewPassword').value;

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, recoveryPin, newPassword })
      });
      const data = await res.json();
      if (!res.ok) {
        errBox.textContent = data.error || 'Password reset failed';
        errBox.classList.remove('hidden');
        return;
      }

      document.getElementById('forgotPasswordForm').classList.add('hidden');
      document.getElementById('loginForm').classList.remove('hidden');
      document.getElementById('loginUsername').value = username;
      document.getElementById('loginPassword').value = newPassword;
      const successBox = document.getElementById('loginSuccess');
      successBox.textContent = data.message;
      successBox.classList.remove('hidden');
      showToast('Password reset! Click Sign In.');
    } catch (_) {
      errBox.textContent = 'Network error resetting password.';
      errBox.classList.remove('hidden');
    }
  });

  // Login Form Submit
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('loginError');
    const successBox = document.getElementById('loginSuccess');
    errBox.classList.add('hidden');
    successBox.classList.add('hidden');

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
      showToast(`Welcome, ${data.user.full_name} (${data.user.role})!`);
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

  // Admin Create or Edit User / Reset Password
  document.getElementById('addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editUserId = document.getElementById('editUserId').value;
    const username = document.getElementById('newUserUsername').value.trim();
    const full_name = document.getElementById('newUserFullName').value.trim();
    const role = document.getElementById('newUserRole').value;
    const password = document.getElementById('newUserPassword').value;
    const recovery_pin = document.getElementById('newUserPin').value.trim();

    if (editUserId) {
      const res = await apiFetch(`/api/users/${editUserId}`, {
        method: 'PUT',
        body: JSON.stringify({
          full_name,
          role,
          newPassword: password || undefined,
          newRecoveryPin: recovery_pin || undefined
        })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Updated user @${username} successfully!`);
        resetUserForm();
        await loadLookups();
      } else {
        showToast(data.error || 'Failed to update user');
      }
    } else {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username, full_name, role, password, recovery_pin })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Created account for ${full_name} (${role})`);
        resetUserForm();
        await loadLookups();
      } else {
        showToast(data.error || 'Could not create user');
      }
    }
  });

  document.getElementById('btnCancelUserEdit').addEventListener('click', resetUserForm);

  // Change Own Password & Recovery PIN
  document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('curPass').value;
    const newPassword = document.getElementById('newPass').value;
    const newRecoveryPin = document.getElementById('newPersonalPin').value.trim();
    const securityHint = document.getElementById('newPinHint').value.trim();

    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, newRecoveryPin, securityHint })
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('curPass').value = '';
      document.getElementById('newPass').value = '';
      document.getElementById('newPersonalPin').value = '';
      document.getElementById('newPinHint').value = '';
      showToast('Password & Recovery PIN updated!');
    } else {
      showToast(data.error || 'Failed to update password');
    }
  });

  // Full System Backup Download (.json)
  document.getElementById('btnDownloadBackup').addEventListener('click', () => {
    window.location.href = `/api/backup/export?token=${encodeURIComponent(state.token)}`;
    showToast('Downloading Full System Backup (.json)...');
  });

  // Restore / Safe Merge Backup (.json)
  document.getElementById('backupFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const mode = document.getElementById('restoreModeSelect').value;
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      const res = await apiFetch('/api/backup/restore', {
        method: 'POST',
        body: JSON.stringify({ snapshot, mode })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(
          `Restored ${data.restoredRecords} records, ${data.restoredTechs} technicians, ${data.restoredSites} sites, ${data.restoredUsers} users!`
        );
        await loadLookups();
        await loadRecords();
      } else {
        showToast(`Restore failed: ${data.error}`);
      }
    } catch (err) {
      showToast('Invalid JSON backup file');
    }
    e.target.value = '';
  });

  // Browser Auto-Vault Restore & 1-Click Render Update buttons
  document.getElementById('btnRestoreVaultNow').addEventListener('click', restoreFromLocalVault);
  document.getElementById('btnManualVaultSync').addEventListener('click', restoreFromLocalVault);

  const btnPublishRender = document.getElementById('btnPublishRenderUpdate');
  if (btnPublishRender) {
    btnPublishRender.addEventListener('click', async () => {
      btnPublishRender.disabled = true;
      btnPublishRender.textContent = '⏳ Pushing to GitHub & Render...';
      try {
        const res = await apiFetch('/api/admin/publish-update', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message);
        } else {
          showToast(data.error || 'Failed to push update');
        }
      } catch (err) {
        showToast('Error pushing update');
      } finally {
        btnPublishRender.disabled = false;
        btnPublishRender.textContent = '🚀 Push Update to Render.com';
      }
    });
  }

  // Export Excel (.xlsx)
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

  if (state.token) {
    await bootstrapAuthenticatedSession();
  } else {
    showLoginScreen();
  }
});
