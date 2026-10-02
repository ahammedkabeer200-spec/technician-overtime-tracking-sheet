const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
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

const dbPath = path.join(dataDir, 'overtime.db');
const db = new DatabaseSync(dbPath);

// --- ZERO-ERROR DATABASE INITIALIZATION & SAFE SCHEMA MIGRATION ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Engineer',
    password_hash TEXT NOT NULL,
    recovery_pin_hash TEXT DEFAULT '',
    security_hint TEXT DEFAULT '4-digit recovery PIN',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS technicians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    employee_id TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    location TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS overtime_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    technician_name TEXT NOT NULL,
    site TEXT NOT NULL,
    commenced_on TEXT NOT NULL,
    finished_on TEXT NOT NULL,
    hours REAL NOT NULL,
    remarks TEXT DEFAULT '',
    recorded_by TEXT DEFAULT 'Supervisor',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Safe migration helper: adds new columns to existing databases without errors on app updates
function ensureColumn(tableName, columnName, columnDef) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  }
}

ensureColumn('overtime_records', 'recorded_by', "TEXT DEFAULT 'Supervisor'");
ensureColumn('overtime_records', 'remarks', "TEXT DEFAULT ''");
ensureColumn('users', 'recovery_pin_hash', "TEXT DEFAULT ''");
ensureColumn('users', 'security_hint', "TEXT DEFAULT 'Default PIN: 1234'");

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

// --- AUTOMATIC BACKUP SNAPSHOT ENGINE ---
const latestBackupPath = path.join(backupDir, 'latest-auto-backup.json');

function createSystemSnapshotObject() {
  return {
    version: '2.0',
    exported_at: new Date().toISOString(),
    users: db.prepare('SELECT * FROM users ORDER BY id ASC').all(),
    technicians: db.prepare('SELECT * FROM technicians ORDER BY id ASC').all(),
    sites: db.prepare('SELECT * FROM sites ORDER BY id ASC').all(),
    overtime_records: db.prepare('SELECT * FROM overtime_records ORDER BY id ASC').all()
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

// Restore helper (supports "merge" or "replace" mode without throwing errors)
function restoreSystemFromSnapshot(snapshot, mode = 'merge') {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Invalid backup file format.');
  }

  let restoredRecords = 0;
  let restoredTechs = 0;
  let restoredSites = 0;
  let restoredUsers = 0;

  if (mode === 'replace') {
    db.exec('DELETE FROM overtime_records');
    db.exec('DELETE FROM technicians');
    db.exec('DELETE FROM sites');
  }

  // 1. Restore Users safely (never lock out existing users)
  if (Array.isArray(snapshot.users)) {
    const insertUser = db.prepare(`
      INSERT OR IGNORE INTO users (username, full_name, role, password_hash, recovery_pin_hash, security_hint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const u of snapshot.users) {
      if (u.username && u.password_hash) {
        const res = insertUser.run(
          u.username,
          u.full_name || u.username,
          u.role || 'Engineer',
          u.password_hash,
          u.recovery_pin_hash || hashSecret('1234'),
          u.security_hint || 'Recovery PIN',
          u.created_at || new Date().toISOString()
        );
        if (res.changes > 0) restoredUsers++;
      }
    }
  }

  // 2. Restore Technicians
  if (Array.isArray(snapshot.technicians)) {
    const insertTech = db.prepare(`
      INSERT OR IGNORE INTO technicians (name, employee_id, phone)
      VALUES (?, ?, ?)
    `);
    for (const t of snapshot.technicians) {
      if (t.name) {
        const res = insertTech.run(t.name, t.employee_id || '', t.phone || '');
        if (res.changes > 0) restoredTechs++;
      }
    }
  }

  // 3. Restore Sites
  if (Array.isArray(snapshot.sites)) {
    const insertSite = db.prepare(`
      INSERT OR IGNORE INTO sites (name, location)
      VALUES (?, ?)
    `);
    for (const s of snapshot.sites) {
      if (s.name) {
        const res = insertSite.run(s.name, s.location || '');
        if (res.changes > 0) restoredSites++;
      }
    }
  }

  // 4. Restore Overtime Records (Avoid duplicates when merging)
  if (Array.isArray(snapshot.overtime_records)) {
    const checkDup = db.prepare(`
      SELECT id FROM overtime_records
      WHERE date = ? AND technician_name = ? AND site = ? AND commenced_on = ? AND finished_on = ?
    `);
    const insertRec = db.prepare(`
      INSERT INTO overtime_records (date, technician_name, site, commenced_on, finished_on, hours, remarks, recorded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of snapshot.overtime_records) {
      if (r.date && r.technician_name && r.site) {
        if (mode === 'merge') {
          const exists = checkDup.get(r.date, r.technician_name, r.site, r.commenced_on || '', r.finished_on || '');
          if (exists) continue;
        }
        insertRec.run(
          r.date,
          r.technician_name,
          r.site,
          r.commenced_on || '17:00',
          r.finished_on || '20:00',
          Number(r.hours || 0),
          r.remarks || '',
          r.recorded_by || 'Supervisor',
          r.created_at || new Date().toISOString()
        );
        restoredRecords++;
      }
    }
  }

  saveAutoBackupToDisk();
  return { restoredRecords, restoredTechs, restoredSites, restoredUsers };
}

// If database is empty on startup but latest-auto-backup.json exists, auto-restore it!
const currentRecordCount = db.prepare('SELECT COUNT(*) as count FROM overtime_records').get().count;
if (currentRecordCount === 0 && fs.existsSync(latestBackupPath)) {
  try {
    const savedSnapshot = JSON.parse(fs.readFileSync(latestBackupPath, 'utf8'));
    restoreSystemFromSnapshot(savedSnapshot, 'merge');
    console.log('Auto-restored existing data from backups/latest-auto-backup.json');
  } catch (e) {
    console.error('Could not auto-restore snapshot:', e.message);
  }
}

// Seed default Admin/Supervisor & Engineer accounts if users table is empty
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
if (userCount === 0) {
  const defaultAdminUser = process.env.ADMIN_USERNAME || 'admin';
  const defaultAdminPass = process.env.ADMIN_PASSWORD || 'Admin@123';
  const insertUser = db.prepare(`
    INSERT INTO users (username, full_name, role, password_hash, recovery_pin_hash, security_hint)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertUser.run(defaultAdminUser, 'System Administrator', 'Admin', hashSecret(defaultAdminPass), hashSecret('1234'), 'Default PIN: 1234');
  insertUser.run('supervisor', 'Main Supervisor', 'Supervisor', hashSecret('Supervisor@123'), hashSecret('1234'), 'Default PIN: 1234');
  insertUser.run('engineer1', 'Duty Site Engineer', 'Engineer', hashSecret('Engineer@123'), hashSecret('1234'), 'Default PIN: 1234');
} else {
  // Ensure existing users have a default recovery PIN (1234) if they upgraded from older version
  const usersWithoutPin = db.prepare("SELECT id FROM users WHERE recovery_pin_hash IS NULL OR recovery_pin_hash = ''").all();
  const setPin = db.prepare("UPDATE users SET recovery_pin_hash = ?, security_hint = 'Default PIN: 1234' WHERE id = ?");
  usersWithoutPin.forEach((u) => setPin.run(hashSecret('1234'), u.id));

  // Ensure an 'admin' account exists so user always has a dedicated Admin login
  const hasAdmin = db.prepare("SELECT id FROM users WHERE LOWER(username) = 'admin'").get();
  if (!hasAdmin) {
    db.prepare(`
      INSERT INTO users (username, full_name, role, password_hash, recovery_pin_hash, security_hint)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('admin', 'System Administrator', 'Admin', hashSecret('Admin@123'), hashSecret('1234'), 'Default PIN: 1234');
  }
}

// Seed default technicians, sites, and initial records if empty
const techCount = db.prepare('SELECT COUNT(*) as count FROM technicians').get().count;
if (techCount === 0) {
  const insertTech = db.prepare('INSERT OR IGNORE INTO technicians (name, employee_id) VALUES (?, ?)');
  [
    ['Ahmed Al-Mansoor', 'TECH-101'],
    ['Rajesh Kumar', 'TECH-102'],
    ['Mohammed Tariq', 'TECH-103'],
    ['Suresh Nair', 'TECH-104'],
    ['John Bautista', 'TECH-105']
  ].forEach(([name, empId]) => insertTech.run(name, empId));
}

const siteCount = db.prepare('SELECT COUNT(*) as count FROM sites').get().count;
if (siteCount === 0) {
  const insertSite = db.prepare('INSERT OR IGNORE INTO sites (name, location) VALUES (?, ?)');
  [
    ['Main Plant - Block A', 'Industrial Zone 1'],
    ['Substation 4', 'North Sector'],
    ['HVAC Central Chiller', 'Building B'],
    ['Warehouse Logistics Hub', 'South Gate'],
    ['Water Treatment Facility', 'Sector 7']
  ].forEach(([name, loc]) => insertSite.run(name, loc));
}

const recCount = db.prepare('SELECT COUNT(*) as count FROM overtime_records').get().count;
if (recCount === 0) {
  const today = new Date().toISOString().slice(0, 10);
  const insertRec = db.prepare(`
    INSERT INTO overtime_records (date, technician_name, site, commenced_on, finished_on, hours, remarks, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  [
    [today, 'Ahmed Al-Mansoor', 'Main Plant - Block A', '17:00', '20:30', 3.5, 'Chiller pump maintenance', 'Main Supervisor'],
    [today, 'Rajesh Kumar', 'Substation 4', '18:00', '22:00', 4.0, 'Switchgear inspection', 'Duty Site Engineer'],
    [today, 'Mohammed Tariq', 'HVAC Central Chiller', '22:00', '02:00', 4.0, 'Overnight emergency repair', 'Main Supervisor']
  ].forEach((row) => insertRec.run(...row));
}

saveAutoBackupToDisk();

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

  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
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

// Get security hint for Forgot Password screen
app.get('/api/auth/recovery-hint', (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const user = db.prepare('SELECT username, full_name, role, security_hint FROM users WHERE LOWER(username) = LOWER(?)').get(String(username).trim());
  if (!user) return res.status(404).json({ error: 'Username not found.' });
  res.json({
    username: user.username,
    full_name: user.full_name,
    hint: user.security_hint || 'Enter your Recovery PIN or Master Recovery Key'
  });
});

// Forgot Password Reset (using User's Recovery PIN OR Master Admin Recovery Key)
app.post('/api/auth/forgot-password', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });
  }

  const { username, recoveryPin, newPassword } = req.body;
  if (!username || !recoveryPin || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Username, Recovery PIN/Key, and New Password (min 6 chars) are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(String(username).trim());
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
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(newPassword), user.id);
  saveAutoBackupToDisk();
  res.json({ success: true, message: `Password for "${user.username}" has been reset! You can now sign in.` });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, full_name, role, security_hint, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'User account no longer exists.' });
  res.json({ user });
});

// Change Own Password & Optional Recovery PIN
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, newRecoveryPin, securityHint } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Current password and new password (min 6 chars) are required.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !verifySecret(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(newPassword), req.user.id);

  if (newRecoveryPin && String(newRecoveryPin).trim().length >= 4) {
    db.prepare('UPDATE users SET recovery_pin_hash = ?, security_hint = ? WHERE id = ?').run(
      hashSecret(String(newRecoveryPin).trim()),
      (securityHint || 'Personal Recovery PIN').trim(),
      req.user.id
    );
  }
  saveAutoBackupToDisk();
  res.json({ success: true });
});

// --- ADMIN USER MANAGEMENT API ---
app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, role, security_hint, created_at FROM users ORDER BY id ASC').all();
  res.json(users);
});

// Create new Admin, Supervisor, or Engineer account
app.post('/api/users', requireAuth, requireAdminOrSupervisor, (req, res) => {
  try {
    const { username, full_name, role, password, recovery_pin, security_hint } = req.body;
    if (!username || !full_name || !password || password.length < 6) {
      return res.status(400).json({ error: 'Username, full name, and password (min 6 chars) are required.' });
    }
    const validRoles = ['Admin', 'Supervisor', 'Engineer'];
    const cleanRole = validRoles.includes(role) ? role : 'Engineer';
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
    if (existing) {
      return res.status(400).json({ error: 'Username already exists.' });
    }
    const pinToUse = recovery_pin && String(recovery_pin).trim() ? String(recovery_pin).trim() : '1234';
    const hintToUse = security_hint && String(security_hint).trim() ? String(security_hint).trim() : `Recovery PIN set by ${req.user.username}`;

    db.prepare(`
      INSERT INTO users (username, full_name, role, password_hash, recovery_pin_hash, security_hint)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username.trim(), full_name.trim(), cleanRole, hashSecret(password), hashSecret(pinToUse), hintToUse);

    saveAutoBackupToDisk();
    const users = db.prepare('SELECT id, username, full_name, role, security_hint, created_at FROM users ORDER BY id ASC').all();
    res.status(201).json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Reset User Password / Edit Role / Edit Recovery PIN directly
app.put('/api/users/:id', requireAuth, requireAdminOrSupervisor, (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { full_name, role, newPassword, newRecoveryPin, security_hint } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const validRoles = ['Admin', 'Supervisor', 'Engineer'];
    const updatedName = full_name ? full_name.trim() : user.full_name;
    const updatedRole = validRoles.includes(role) ? role : user.role;

    db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?').run(updatedName, updatedRole, targetId);

    if (newPassword && String(newPassword).length >= 6) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(newPassword), targetId);
    }
    if (newRecoveryPin && String(newRecoveryPin).trim().length >= 4) {
      db.prepare('UPDATE users SET recovery_pin_hash = ?, security_hint = ? WHERE id = ?').run(
        hashSecret(String(newRecoveryPin).trim()),
        (security_hint || user.security_hint || 'Admin Reset PIN').trim(),
        targetId
      );
    }

    saveAutoBackupToDisk();
    const users = db.prepare('SELECT id, username, full_name, role, security_hint, created_at FROM users ORDER BY id ASC').all();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdminOrSupervisor, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own active account.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
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

// --- OVERTIME RECORDS API ---
app.get('/api/records', requireAuth, (req, res) => {
  const { startDate, endDate, technician, site, search } = req.query;
  let sql = 'SELECT * FROM overtime_records WHERE 1=1';
  const params = [];

  if (startDate) { sql += ' AND date >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND date <= ?'; params.push(endDate); }
  if (technician) { sql += ' AND technician_name = ?'; params.push(technician); }
  if (site) { sql += ' AND site = ?'; params.push(site); }
  if (search) {
    sql += ' AND (technician_name LIKE ? OR site LIKE ? OR remarks LIKE ? OR date LIKE ? OR recorded_by LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  sql += ' ORDER BY date ASC, commenced_on ASC, id ASC';
  const records = db.prepare(sql).all(...params);
  res.json(records);
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

    db.prepare('INSERT OR IGNORE INTO technicians (name) VALUES (?)').run(technician_name.trim());
    db.prepare('INSERT OR IGNORE INTO sites (name) VALUES (?)').run(site.trim());

    const stmt = db.prepare(`
      INSERT INTO overtime_records (date, technician_name, site, commenced_on, finished_on, hours, remarks, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      date.trim(),
      technician_name.trim(),
      site.trim(),
      commenced_on.trim(),
      finished_on.trim(),
      computedHours,
      (remarks || '').trim(),
      req.user.full_name || req.user.username
    );

    saveAutoBackupToDisk();
    const created = db.prepare('SELECT * FROM overtime_records WHERE id = ?').get(result.lastInsertRowid);
    broadcastChange('record_created', { record: created });
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/records/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { date, technician_name, site, commenced_on, finished_on, hours, remarks } = req.body;
    if (!date || !technician_name || !site || !commenced_on || !finished_on) {
      return res.status(400).json({ error: 'All main fields are required.' });
    }

    const computedHours = (hours !== undefined && hours !== '' && !isNaN(Number(hours)))
      ? Number(hours)
      : calculateHours(commenced_on, finished_on);

    db.prepare('INSERT OR IGNORE INTO technicians (name) VALUES (?)').run(technician_name.trim());
    db.prepare('INSERT OR IGNORE INTO sites (name) VALUES (?)').run(site.trim());

    db.prepare(`
      UPDATE overtime_records
      SET date = ?, technician_name = ?, site = ?, commenced_on = ?, finished_on = ?, hours = ?, remarks = ?, recorded_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      date.trim(),
      technician_name.trim(),
      site.trim(),
      commenced_on.trim(),
      finished_on.trim(),
      computedHours,
      (remarks || '').trim(),
      req.user.full_name || req.user.username,
      Number(id)
    );

    saveAutoBackupToDisk();
    const updated = db.prepare('SELECT * FROM overtime_records WHERE id = ?').get(Number(id));
    broadcastChange('record_updated', { record: updated });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/records/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM overtime_records WHERE id = ?').run(Number(id));
    saveAutoBackupToDisk();
    broadcastChange('record_deleted', { id: Number(id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TECHNICIANS & SITES API ---
app.get('/api/technicians', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM technicians ORDER BY name ASC').all();
  res.json(list);
});

app.post('/api/technicians', requireAuth, (req, res) => {
  try {
    const { name, employee_id, phone } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Technician name is required' });
    const stmt = db.prepare('INSERT OR IGNORE INTO technicians (name, employee_id, phone) VALUES (?, ?, ?)');
    stmt.run(name.trim(), (employee_id || '').trim(), (phone || '').trim());
    saveAutoBackupToDisk();
    const all = db.prepare('SELECT * FROM technicians ORDER BY name ASC').all();
    broadcastChange('technicians_updated');
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/technicians/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM technicians WHERE id = ?').run(Number(req.params.id));
  saveAutoBackupToDisk();
  broadcastChange('technicians_updated');
  res.json({ success: true });
});

app.get('/api/sites', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM sites ORDER BY name ASC').all();
  res.json(list);
});

app.post('/api/sites', requireAuth, (req, res) => {
  try {
    const { name, location } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Site name is required' });
    const stmt = db.prepare('INSERT OR IGNORE INTO sites (name, location) VALUES (?, ?)');
    stmt.run(name.trim(), (location || '').trim());
    saveAutoBackupToDisk();
    const all = db.prepare('SELECT * FROM sites ORDER BY name ASC').all();
    broadcastChange('sites_updated');
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sites/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sites WHERE id = ?').run(Number(req.params.id));
  saveAutoBackupToDisk();
  broadcastChange('sites_updated');
  res.json({ success: true });
});

// --- EXCEL EXPORT ---
app.get('/api/export-excel', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate, technician, site, search } = req.query;
    let sql = 'SELECT * FROM overtime_records WHERE 1=1';
    const params = [];

    if (startDate) { sql += ' AND date >= ?'; params.push(startDate); }
    if (endDate) { sql += ' AND date <= ?'; params.push(endDate); }
    if (technician) { sql += ' AND technician_name = ?'; params.push(technician); }
    if (site) { sql += ' AND site = ?'; params.push(site); }
    if (search) {
      sql += ' AND (technician_name LIKE ? OR site LIKE ? OR remarks LIKE ? OR date LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    sql += ' ORDER BY date ASC, commenced_on ASC, id ASC';
    const records = db.prepare(sql).all(...params);

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
    const insertRec = db.prepare(`
      INSERT INTO overtime_records (date, technician_name, site, commenced_on, finished_on, hours, remarks, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTech = db.prepare('INSERT OR IGNORE INTO technicians (name) VALUES (?)');
    const insertSite = db.prepare('INSERT OR IGNORE INTO sites (name) VALUES (?)');

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

        insertTech.run(techName);
        insertSite.run(siteName);
        insertRec.run(dateStr, techName, siteName, commStr, finStr, hrs, '', req.user.full_name || req.user.username);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Secure Overtime Report Server running on http://localhost:${PORT}`);
});
