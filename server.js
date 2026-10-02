const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || 'overtime-secure-hmac-key-2026-change-in-prod';
const MASTER_RECOVERY_KEY = process.env.MASTER_RECOVERY_KEY || 'ADMIN-RECOVERY-2026';

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data and backup directories exist
const dataDir = process.env.DATA_DIR || __dirname;
const backupDir = path.join(dataDir, 'backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}
const latestBackupPath = path.join(backupDir, 'latest-auto-backup.json');

// --- CRYPTO PASSWORD & RECOVERY PIN HASHING ---
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(secret).trim(), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifySecret(secret, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  try {
    const [salt, key] = storedHash.split(':');
    const derived = crypto.scryptSync(String(secret).trim(), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
  } catch (_) {
    return false;
  }
}

function createToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

// --- UNIVERSAL CLOUD & LOCAL STORAGE ENGINE (Works on all Node versions 18..26 without native crash) ---
const store = {
  users: [],
  technicians: [],
  sites: [],
  overtime_records: []
};

function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map((x) => Number(x.id) || 0)) + 1;
}

function createSystemSnapshotObject() {
  return {
    version: '2.0',
    exported_at: new Date().toISOString(),
    users: store.users,
    technicians: store.technicians,
    sites: store.sites,
    overtime_records: store.overtime_records
  };
}

function saveAutoBackupToDisk() {
  try {
    const snapshot = createSystemSnapshotObject();
    fs.writeFileSync(latestBackupPath, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    console.error('Auto-backup warning:', err.message);
  }
}

function restoreSystemFromSnapshot(snapshot, mode = 'merge') {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Invalid backup file format.');
  }

  let restoredRecords = 0;
  let restoredTechs = 0;
  let restoredSites = 0;
  let restoredUsers = 0;

  if (mode === 'replace') {
    store.overtime_records = [];
    store.technicians = [];
    store.sites = [];
  }

  // 1. Restore Users safely
  if (Array.isArray(snapshot.users)) {
    for (const u of snapshot.users) {
      if (u.username && u.password_hash) {
        const exists = store.users.find((x) => x.username.toLowerCase() === String(u.username).toLowerCase());
        if (!exists) {
          store.users.push({
            id: u.id || nextId(store.users),
            username: String(u.username).trim(),
            full_name: u.full_name || u.username,
            role: u.role || 'Engineer',
            password_hash: u.password_hash,
            recovery_pin_hash: u.recovery_pin_hash || hashSecret('1234'),
            security_hint: u.security_hint || 'Default PIN: 1234',
            created_at: u.created_at || new Date().toISOString()
          });
          restoredUsers++;
        }
      }
    }
  }

  // 2. Restore Technicians
  if (Array.isArray(snapshot.technicians)) {
    for (const t of snapshot.technicians) {
      if (t.name) {
        const exists = store.technicians.find((x) => x.name.toLowerCase() === String(t.name).trim().toLowerCase());
        if (!exists) {
          store.technicians.push({
            id: nextId(store.technicians),
            name: String(t.name).trim(),
            employee_id: t.employee_id || '',
            phone: t.phone || '',
            created_at: t.created_at || new Date().toISOString()
          });
          restoredTechs++;
        }
      }
    }
  }

  // 3. Restore Sites
  if (Array.isArray(snapshot.sites)) {
    for (const s of snapshot.sites) {
      if (s.name) {
        const exists = store.sites.find((x) => x.name.toLowerCase() === String(s.name).trim().toLowerCase());
        if (!exists) {
          store.sites.push({
            id: nextId(store.sites),
            name: String(s.name).trim(),
            location: s.location || '',
            created_at: s.created_at || new Date().toISOString()
          });
          restoredSites++;
        }
      }
    }
  }

  // 4. Restore Overtime Records
  if (Array.isArray(snapshot.overtime_records)) {
    for (const r of snapshot.overtime_records) {
      if (r.date && r.technician_name && r.site) {
        if (mode === 'merge') {
          const dup = store.overtime_records.find(
            (x) =>
              x.date === r.date &&
              x.technician_name.toLowerCase() === String(r.technician_name).toLowerCase() &&
              x.site.toLowerCase() === String(r.site).toLowerCase() &&
              x.commenced_on === (r.commenced_on || '') &&
              x.finished_on === (r.finished_on || '')
          );
          if (dup) continue;
        }
        store.overtime_records.push({
          id: nextId(store.overtime_records),
          date: r.date,
          technician_name: String(r.technician_name).trim(),
          site: String(r.site).trim(),
          commenced_on: r.commenced_on || '17:00',
          finished_on: r.finished_on || '20:00',
          hours: Number(r.hours || 0),
          remarks: r.remarks || '',
          recorded_by: r.recorded_by || 'Supervisor',
          created_at: r.created_at || new Date().toISOString(),
          updated_at: r.updated_at || new Date().toISOString()
        });
        restoredRecords++;
      }
    }
  }

  saveAutoBackupToDisk();
  return { restoredRecords, restoredTechs, restoredSites, restoredUsers };
}

// Load existing data from backups/latest-auto-backup.json on startup
if (fs.existsSync(latestBackupPath)) {
  try {
    const savedSnapshot = JSON.parse(fs.readFileSync(latestBackupPath, 'utf8'));
    restoreSystemFromSnapshot(savedSnapshot, 'merge');
    console.log('Loaded existing data from backups/latest-auto-backup.json');
  } catch (e) {
    console.error('Could not load snapshot:', e.message);
  }
}

// Ensure default Admin, Supervisor & Engineer accounts exist
const ensureDefaultUser = (username, full_name, role, defaultPass) => {
  const existing = store.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!existing) {
    store.users.push({
      id: nextId(store.users),
      username,
      full_name,
      role,
      password_hash: hashSecret(defaultPass),
      recovery_pin_hash: hashSecret('1234'),
      security_hint: 'Default PIN: 1234',
      created_at: new Date().toISOString()
    });
  } else if (!existing.recovery_pin_hash) {
    existing.recovery_pin_hash = hashSecret('1234');
    existing.security_hint = 'Default PIN: 1234';
  }
};

ensureDefaultUser('admin', 'System Administrator', 'Admin', 'Admin@123');
ensureDefaultUser('supervisor', 'Main Supervisor', 'Supervisor', 'Supervisor@123');
ensureDefaultUser('engineer1', 'Duty Site Engineer', 'Engineer', 'Engineer@123');

// Seed default technicians, sites, and initial records if empty
if (store.technicians.length === 0) {
  [
    ['Ahmed Al-Mansoor', 'TECH-101'],
    ['Rajesh Kumar', 'TECH-102'],
    ['Mohammed Tariq', 'TECH-103'],
    ['Suresh Nair', 'TECH-104'],
    ['John Bautista', 'TECH-105']
  ].forEach(([name, employee_id]) => {
    store.technicians.push({ id: nextId(store.technicians), name, employee_id, phone: '', created_at: new Date().toISOString() });
  });
}

if (store.sites.length === 0) {
  [
    ['Main Plant - Block A', 'Industrial Zone 1'],
    ['Substation 4', 'North Sector'],
    ['HVAC Central Chiller', 'Building B'],
    ['Warehouse Logistics Hub', 'South Gate'],
    ['Water Treatment Facility', 'Sector 7']
  ].forEach(([name, location]) => {
    store.sites.push({ id: nextId(store.sites), name, location, created_at: new Date().toISOString() });
  });
}

if (store.overtime_records.length === 0) {
  const today = new Date().toISOString().slice(0, 10);
  [
    [today, 'Ahmed Al-Mansoor', 'Main Plant - Block A', '17:00', '20:30', 3.5, 'Chiller pump maintenance', 'Main Supervisor'],
    [today, 'Rajesh Kumar', 'Substation 4', '18:00', '22:00', 4.0, 'Switchgear inspection', 'Duty Site Engineer'],
    [today, 'Mohammed Tariq', 'HVAC Central Chiller', '22:00', '02:00', 4.0, 'Overnight emergency repair', 'Main Supervisor']
  ].forEach(([date, technician_name, site, commenced_on, finished_on, hours, remarks, recorded_by]) => {
    store.overtime_records.push({
      id: nextId(store.overtime_records),
      date,
      technician_name,
      site,
      commenced_on,
      finished_on,
      hours,
      remarks,
      recorded_by,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  });
}

saveAutoBackupToDisk();

//Helper: Ensure technician/site exists in lookup list
function ensureTechAndSite(techName, siteName) {
  if (techName && !store.technicians.some((t) => t.name.toLowerCase() === techName.toLowerCase())) {
    store.technicians.push({ id: nextId(store.technicians), name: techName, employee_id: '', phone: '', created_at: new Date().toISOString() });
  }
  if (siteName && !store.sites.some((s) => s.name.toLowerCase() === siteName.toLowerCase())) {
    store.sites.push({ id: nextId(store.sites), name: siteName, location: '', created_at: new Date().toISOString() });
  }
}

// Brute-force login rate limiting
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 15 * 60 * 1000;
  }
  loginAttempts.set(ip, entry);
  return entry.count < 12;
}
function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (entry) entry.count += 1;
}
function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

// Authentication Middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.query.token;

  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. Please sign in.' });
  }
  req.user = user;
  next();
}

function requireAdminOrSupervisor(req, res, next) {
  if (!req.user || (req.user.role !== 'Admin' && req.user.role !== 'Supervisor')) {
    return res.status(403).json({ error: 'Access denied. Admin or Supervisor permission required.' });
  }
  next();
}

// Health check endpoint for Render.com
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// --- AUTHENTICATION, FORGOT PASSWORD & CHANGE PASSWORD API ---
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Please wait 15 minutes.' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = store.users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase());
  if (!user || !verifySecret(password, user.password_hash)) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearFailedAttempts(ip);
  const token = createToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      security_hint: user.security_hint
    }
  });
});

app.get('/api/auth/recovery-hint', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const user = store.users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'Username not found.' });
  res.json({
    username: user.username,
    full_name: user.full_name,
    hint: user.security_hint || 'Enter your Recovery PIN'
  });
});

app.post('/api/auth/forgot-password', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });
  }

  const { username, recoveryPin, newPassword } = req.body;
  if (!username || !recoveryPin || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Username, Recovery PIN/Key, and New Password (min 6 chars) are required.' });
  }

  const user = store.users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase());
  if (!user) {
    recordFailedAttempt(ip);
    return res.status(404).json({ error: 'User account not found.' });
  }

  const matchesMasterKey = String(recoveryPin).trim() === MASTER_RECOVERY_KEY;
  const matchesUserPin = verifySecret(String(recoveryPin).trim(), user.recovery_pin_hash);

  if (!matchesMasterKey && !matchesUserPin) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid Recovery PIN or Master Recovery Key.' });
  }

  clearFailedAttempts(ip);
  user.password_hash = hashSecret(newPassword);
  saveAutoBackupToDisk();
  res.json({ success: true, message: `Password for "${user.username}" has been reset! Please sign in.` });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = store.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: 'User account no longer exists.' });
  res.json({
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      security_hint: user.security_hint,
      created_at: user.created_at
    }
  });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, newRecoveryPin, securityHint } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Current password and new password (min 6 chars) are required.' });
  }
  const user = store.users.find((u) => u.id === req.user.id);
  if (!user || !verifySecret(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  user.password_hash = hashSecret(newPassword);
  if (newRecoveryPin && String(newRecoveryPin).trim().length >= 4) {
    user.recovery_pin_hash = hashSecret(String(newRecoveryPin).trim());
    user.security_hint = (securityHint || 'Personal Recovery PIN').trim();
  }
  saveAutoBackupToDisk();
  res.json({ success: true });
});

// --- ADMIN USER MANAGEMENT API ---
const sanitizeUsers = () =>
  store.users.map(({ id, username, full_name, role, security_hint, created_at }) => ({
    id,
    username,
    full_name,
    role,
    security_hint,
    created_at
  }));

app.get('/api/users', requireAuth, (req, res) => {
  res.json(sanitizeUsers());
});

app.post('/api/users', requireAuth, requireAdminOrSupervisor, (req, res) => {
  try {
    const { username, full_name, role, password, recovery_pin, security_hint } = req.body;
    if (!username || !full_name || !password || password.length < 6) {
      return res.status(400).json({ error: 'Username, full name, and password (min 6 chars) are required.' });
    }
    const validRoles = ['Admin', 'Supervisor', 'Engineer'];
    const cleanRole = validRoles.includes(role) ? role : 'Engineer';
    const existing = store.users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
    if (existing) {
      return res.status(400).json({ error: 'Username already exists.' });
    }
    const pinToUse = recovery_pin && String(recovery_pin).trim() ? String(recovery_pin).trim() : '1234';
    const hintToUse = security_hint && String(security_hint).trim() ? String(security_hint).trim() : `Recovery PIN set by ${req.user.username}`;

    store.users.push({
      id: nextId(store.users),
      username: username.trim(),
      full_name: full_name.trim(),
      role: cleanRole,
      password_hash: hashSecret(password),
      recovery_pin_hash: hashSecret(pinToUse),
      security_hint: hintToUse,
      created_at: new Date().toISOString()
    });

    saveAutoBackupToDisk();
    res.status(201).json(sanitizeUsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAuth, requireAdminOrSupervisor, (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { full_name, role, newPassword, newRecoveryPin, security_hint } = req.body;
    const user = store.users.find((u) => u.id === targetId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const validRoles = ['Admin', 'Supervisor', 'Engineer'];
    if (full_name) user.full_name = full_name.trim();
    if (validRoles.includes(role)) user.role = role;

    if (newPassword && String(newPassword).length >= 6) {
      user.password_hash = hashSecret(newPassword);
    }
    if (newRecoveryPin && String(newRecoveryPin).trim().length >= 4) {
      user.recovery_pin_hash = hashSecret(String(newRecoveryPin).trim());
      user.security_hint = (security_hint || user.security_hint || 'Admin Reset PIN').trim();
    }

    saveAutoBackupToDisk();
    res.json({ success: true, users: sanitizeUsers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdminOrSupervisor, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own active account.' });
  }
  store.users = store.users.filter((u) => u.id !== targetId);
  saveAutoBackupToDisk();
  res.json({ success: true });
});

// --- FULL BACKUP & RESTORE API ---
app.get('/api/backup/export', requireAuth, (req, res) => {
  const snapshot = createSystemSnapshotObject();
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="Overtime_System_Backup_${dateStr}.json"`);
  res.send(JSON.stringify(snapshot, null, 2));
});

app.get('/api/backup/snapshot', requireAuth, (req, res) => {
  res.json(createSystemSnapshotObject());
});

app.post('/api/backup/restore', requireAuth, requireAdminOrSupervisor, (req, res) => {
  try {
    const { snapshot, mode } = req.body;
    const stats = restoreSystemFromSnapshot(snapshot, mode || 'merge');
    broadcastChange('system_restored', stats);
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/publish-update', requireAuth, requireAdminOrSupervisor, (req, res) => {
  try {
    saveAutoBackupToDisk();
    const { execSync } = require('child_process');
    execSync('git add .', { cwd: __dirname, stdio: 'pipe' });
    try {
      execSync('git -c user.name="ahammedkabeer" -c user.email="ahammedkabeer200@gmail.com" commit -m "Auto-publish application update & backup to Render"', {
        cwd: __dirname,
        stdio: 'pipe'
      });
    } catch (_) {}
    execSync('git push origin main', { cwd: __dirname, stdio: 'pipe' });
    res.json({
      success: true,
      message: 'Published to GitHub! Render.com is now automatically updating your live web application.'
    });
  } catch (err) {
    res.status(500).json({
      error: 'Could not push to GitHub from this environment: ' + (err.stderr ? err.stderr.toString() : err.message)
    });
  }
});

// Helper: Calculate hours between two HH:MM strings (handles overnight shifts)
function calculateHours(commencedOn, finishedOn) {
  if (!commencedOn || !finishedOn) return 0;
  const parseTime = (str) => {
    const clean = String(str).trim();
    const ampmMatch = clean.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampmMatch) {
      let h = parseInt(ampmMatch[1], 10);
      const m = parseInt(ampmMatch[2], 10);
      const period = ampmMatch[3].toUpperCase();
      if (period === 'PM' && h < 12) h += 12;
      if (period === 'AM' && h === 12) h = 0;
      return h * 60 + m;
    }
    const parts = clean.split(':');
    if (parts.length >= 2) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (!isNaN(h) && !isNaN(m)) {
        return h * 60 + m;
      }
    }
    return null;
  };

  const startMins = parseTime(commencedOn);
  const endMins = parseTime(finishedOn);
  if (startMins === null || endMins === null) return 0;

  let diff = endMins - startMins;
  if (diff < 0) {
    diff += 24 * 60;
  }
  return Math.round((diff / 60) * 100) / 100;
}

// Server-Sent Events (SSE)
const sseClients = new Set();
function broadcastChange(eventType, payload = {}) {
  const data = JSON.stringify({ type: eventType, timestamp: Date.now(), ...payload });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'connected', user: req.user.username })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/api/network-info', requireAuth, (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, address: iface.address, url: `http://${iface.address}:${PORT}` });
      }
    }
  }
  res.json({
    port: PORT,
    hostname: os.hostname(),
    localUrl: `http://localhost:${PORT}`,
    networkUrls: addresses
  });
});

// Helper: Filter records
function getFilteredRecords(query) {
  const { startDate, endDate, technician, site, search } = query;
  return store.overtime_records
    .filter((r) => {
      if (startDate && r.date < startDate) return false;
      if (endDate && r.date > endDate) return false;
      if (technician && r.technician_name !== technician) return false;
      if (site && r.site !== site) return false;
      if (search) {
        const q = String(search).toLowerCase();
        const hay = `${r.technician_name} ${r.site} ${r.remarks || ''} ${r.date} ${r.recorded_by || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.commenced_on !== b.commenced_on) return a.commenced_on.localeCompare(b.commenced_on);
      return a.id - b.id;
    });
}

// --- OVERTIME RECORDS API ---
app.get('/api/records', requireAuth, (req, res) => {
  res.json(getFilteredRecords(req.query));
});

app.post('/api/records', requireAuth, (req, res) => {
  try {
    const { date, technician_name, site, commenced_on, finished_on, hours, remarks } = req.body;
    if (!date || !technician_name || !site || !commenced_on || !finished_on) {
      return res.status(400).json({ error: 'Date, Technician name, Site, Commenced on, and Finished on are required.' });
    }

    const computedHours = (hours !== undefined && hours !== '' && !isNaN(Number(hours)))
      ? Number(hours)
      : calculateHours(commenced_on, finished_on);

    ensureTechAndSite(technician_name.trim(), site.trim());

    const created = {
      id: nextId(store.overtime_records),
      date: date.trim(),
      technician_name: technician_name.trim(),
      site: site.trim(),
      commenced_on: commenced_on.trim(),
      finished_on: finished_on.trim(),
      hours: computedHours,
      remarks: (remarks || '').trim(),
      recorded_by: req.user.full_name || req.user.username,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    store.overtime_records.push(created);
    saveAutoBackupToDisk();
    broadcastChange('record_created', { record: created });
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/records/:id', requireAuth, (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { date, technician_name, site, commenced_on, finished_on, hours, remarks } = req.body;
    if (!date || !technician_name || !site || !commenced_on || !finished_on) {
      return res.status(400).json({ error: 'All main fields are required.' });
    }

    const rec = store.overtime_records.find((r) => r.id === targetId);
    if (!rec) return res.status(404).json({ error: 'Record not found.' });

    const computedHours = (hours !== undefined && hours !== '' && !isNaN(Number(hours)))
      ? Number(hours)
      : calculateHours(commenced_on, finished_on);

    ensureTechAndSite(technician_name.trim(), site.trim());

    rec.date = date.trim();
    rec.technician_name = technician_name.trim();
    rec.site = site.trim();
    rec.commenced_on = commenced_on.trim();
    rec.finished_on = finished_on.trim();
    rec.hours = computedHours;
    rec.remarks = (remarks || '').trim();
    rec.recorded_by = req.user.full_name || req.user.username;
    rec.updated_at = new Date().toISOString();

    saveAutoBackupToDisk();
    broadcastChange('record_updated', { record: rec });
    res.json(rec);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/records/:id', requireAuth, (req, res) => {
  try {
    const targetId = Number(req.params.id);
    store.overtime_records = store.overtime_records.filter((r) => r.id !== targetId);
    saveAutoBackupToDisk();
    broadcastChange('record_deleted', { id: targetId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TECHNICIANS & SITES API ---
app.get('/api/technicians', requireAuth, (req, res) => {
  const sorted = [...store.technicians].sort((a, b) => a.name.localeCompare(b.name));
  res.json(sorted);
});

app.post('/api/technicians', requireAuth, (req, res) => {
  try {
    const { name, employee_id, phone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Technician name is required' });
    const cleanName = name.trim();
    if (!store.technicians.some((t) => t.name.toLowerCase() === cleanName.toLowerCase())) {
      store.technicians.push({
        id: nextId(store.technicians),
        name: cleanName,
        employee_id: (employee_id || '').trim(),
        phone: (phone || '').trim(),
        created_at: new Date().toISOString()
      });
      saveAutoBackupToDisk();
      broadcastChange('technicians_updated');
    }
    res.json([...store.technicians].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/technicians/:id', requireAuth, (req, res) => {
  const targetId = Number(req.params.id);
  store.technicians = store.technicians.filter((t) => t.id !== targetId);
  saveAutoBackupToDisk();
  broadcastChange('technicians_updated');
  res.json({ success: true });
});

app.get('/api/sites', requireAuth, (req, res) => {
  const sorted = [...store.sites].sort((a, b) => a.name.localeCompare(b.name));
  res.json(sorted);
});

app.post('/api/sites', requireAuth, (req, res) => {
  try {
    const { name, location } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Site name is required' });
    const cleanName = name.trim();
    if (!store.sites.some((s) => s.name.toLowerCase() === cleanName.toLowerCase())) {
      store.sites.push({
        id: nextId(store.sites),
        name: cleanName,
        location: (location || '').trim(),
        created_at: new Date().toISOString()
      });
      saveAutoBackupToDisk();
      broadcastChange('sites_updated');
    }
    res.json([...store.sites].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sites/:id', requireAuth, (req, res) => {
  const targetId = Number(req.params.id);
  store.sites = store.sites.filter((s) => s.id !== targetId);
  saveAutoBackupToDisk();
  broadcastChange('sites_updated');
  res.json({ success: true });
});

// --- EXCEL EXPORT ---
app.get('/api/export-excel', requireAuth, async (req, res) => {
  try {
    const records = getFilteredRecords(req.query);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = req.user.full_name || 'Overtime Report Manager';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Sheet1', {
      views: [{ showGridLines: true }]
    });

    sheet.columns = [
      { key: 'sl_no', width: 8 },
      { key: 'date', width: 16 },
      { key: 'technician_name', width: 28 },
      { key: 'site', width: 26 },
      { key: 'commenced_on', width: 16 },
      { key: 'finished_on', width: 16 },
      { key: 'hours', width: 12 }
    ];

    sheet.mergeCells('A1:G4');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'OVERTIME REPORT';
    titleCell.font = { name: 'Calibri', size: 22, bold: true, color: { argb: 'FF111111' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

    const thinBorder = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } }
    };

    for (let r = 1; r <= 4; r++) {
      for (let c = 1; c <= 7; c++) {
        sheet.getCell(r, c).border = thinBorder;
      }
    }

    const headers = ['Sl.no', 'Date', 'Technician name', 'Site', 'Commenced on', 'Finished on', 'Hours'];
    const headerRow = sheet.getRow(5);
    headerRow.height = 26;
    headers.forEach((h, idx) => {
      const cell = headerRow.getCell(idx + 1);
      cell.value = h;
      cell.font = { name: 'Calibri', size: 11, bold: false, color: { argb: 'FF111111' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = thinBorder;
    });

    const formatDateDisplay = (isoDate) => {
      if (!isoDate) return '';
      const parts = isoDate.split('-');
      if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
      return isoDate;
    };

    const minRows = Math.max(records.length, 18);
    for (let i = 0; i < minRows; i++) {
      const rowNum = 6 + i;
      const row = sheet.getRow(rowNum);
      row.height = 20;
      const rec = records[i];

      if (rec) {
        row.getCell(1).value = i + 1;
        row.getCell(2).value = formatDateDisplay(rec.date);
        row.getCell(3).value = rec.technician_name;
        row.getCell(4).value = rec.site;
        row.getCell(5).value = rec.commenced_on;
        row.getCell(6).value = rec.finished_on;
        row.getCell(7).value = Number(rec.hours);
      }

      for (let c = 1; c <= 7; c++) {
        const cell = row.getCell(c);
        cell.border = thinBorder;
        cell.font = { name: 'Calibri', size: 11 };
        if (c === 1 || c === 2 || c === 5 || c === 6) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if (c === 7) {
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '0.00';
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }
      }
    }

    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'Technician Name', key: 'tech', width: 30 },
      { header: 'Total Shifts', key: 'shifts', width: 15 },
      { header: 'Total Overtime Hours', key: 'hours', width: 22 }
    ];
    summarySheet.getRow(1).font = { bold: true };

    const techTotals = {};
    records.forEach((r) => {
      if (!techTotals[r.technician_name]) techTotals[r.technician_name] = { shifts: 0, hours: 0 };
      techTotals[r.technician_name].shifts += 1;
      techTotals[r.technician_name].hours += Number(r.hours || 0);
    });

    Object.entries(techTotals).forEach(([tech, stats]) => {
      summarySheet.addRow({
        tech,
        shifts: stats.shifts,
        hours: Math.round(stats.hours * 100) / 100
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Overtime_Report_${new Date().toISOString().slice(0, 10)}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- EXCEL IMPORT ---
app.post('/api/import-excel', requireAuth, async (req, res) => {
  try {
    const { base64Data } = req.body;
    if (!base64Data) return res.status(400).json({ error: 'No Excel file data provided' });

    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ error: 'Excel file has no worksheets' });

    let importedCount = 0;

    const normalizeDate = (val) => {
      if (!val) return new Date().toISOString().slice(0, 10);
      if (val instanceof Date) return val.toISOString().slice(0, 10);
      const str = String(val).trim();
      const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
      const ymd = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
      return str;
    };

    const normalizeTime = (val) => {
      if (!val) return '00:00';
      if (val instanceof Date) {
        const h = String(val.getUTCHours()).padStart(2, '0');
        const m = String(val.getUTCMinutes()).padStart(2, '0');
        return `${h}:${m}`;
      }
      if (typeof val === 'object' && val.result !== undefined) return String(val.result).trim();
      return String(val).trim();
    };

    sheet.eachRow((row) => {
      const c2 = row.getCell(2).value;
      const c3 = row.getCell(3).value;
      const c4 = row.getCell(4).value;
      const c5 = row.getCell(5).value;
      const c6 = row.getCell(6).value;
      const c7 = row.getCell(7).value;

      if (String(c3 || '').toLowerCase().includes('technician') || String(c2 || '').toLowerCase() === 'date') {
        return;
      }

      if (c3 && (c2 || c4)) {
        const dateStr = normalizeDate(c2);
        const techName = String(c3).trim();
        const siteName = String(c4 || 'General Site').trim();
        const commStr = normalizeTime(c5 || '17:00');
        const finStr = normalizeTime(c6 || '20:00');
        let hrs = (c7 && typeof c7 === 'object' && c7.result !== undefined) ? Number(c7.result) : Number(c7);
        if (isNaN(hrs) || hrs <= 0) {
          hrs = calculateHours(commStr, finStr);
        }

        ensureTechAndSite(techName, siteName);
        store.overtime_records.push({
          id: nextId(store.overtime_records),
          date: dateStr,
          technician_name: techName,
          site: siteName,
          commenced_on: commStr,
          finished_on: finStr,
          hours: hrs,
          remarks: '',
          recorded_by: req.user.full_name || req.user.username,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        importedCount++;
      }
    });

    saveAutoBackupToDisk();
    broadcastChange('records_imported', { count: importedCount });
    res.json({ success: true, importedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AUTOMATIC GITHUB & RENDER.COM SYNC WATCHER (Runs automatically on local PC) ---
if (!process.env.RENDER && fs.existsSync(path.join(__dirname, '.git'))) {
  let syncTimer = null;
  let isSyncing = false;

  const triggerAutoGitPush = () => {
    if (isSyncing) return;
    isSyncing = true;
    const { exec } = require('child_process');
    const cmd = 'git add . && git -c user.name="ahammedkabeer" -c user.email="ahammedkabeer200@gmail.com" commit -m "Auto-sync application update to Render.com" && git push origin main';
    exec(cmd, { cwd: __dirname }, (err) => {
      isSyncing = false;
      if (!err) {
        console.log('[Auto-Sync] Changes pushed to GitHub -> Render.com is updating automatically!');
      }
    });
  };

  const watchedFiles = [
    path.join(__dirname, 'server.js'),
    path.join(__dirname, 'render.yaml'),
    path.join(__dirname, 'package.json'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'public', 'styles.css'),
    path.join(__dirname, 'public', 'app.js')
  ];

  watchedFiles.forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      fs.watchFile(filePath, { interval: 4000 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) {
          clearTimeout(syncTimer);
          syncTimer = setTimeout(triggerAutoGitPush, 5000);
        }
      });
    }
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Secure Overtime Report Server running on http://localhost:${PORT}`);
});
