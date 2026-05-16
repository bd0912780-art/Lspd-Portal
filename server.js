const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'lspd-portal-secret-key-change-in-production';
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PERMISSIONS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const PERM = {
  certificates: { OWNER:'full','FULL ACCESS':'full','FTO CHIEF':'full','FTO MEMBER':'full','IA CHIEF':'full','IA MEMBER':'full','WING COMMANDER':'full','WINGS':'full','APPLICANT VIEWER':'full','VISITOR':'full' },
  reports:      { OWNER:'full','FULL ACCESS':'full','FTO CHIEF':'full','FTO MEMBER':'create','IA CHIEF':'full','IA MEMBER':'full','WING COMMANDER':'full','WINGS':'full','APPLICANT VIEWER':'none','VISITOR':'none' },
  applications: { OWNER:'full','FULL ACCESS':'full','FTO CHIEF':'full','FTO MEMBER':'view','IA CHIEF':'full','IA MEMBER':'none','WING COMMANDER':'full','WINGS':'none','APPLICANT VIEWER':'view','VISITOR':'none' },
  logs:         { OWNER:'full','FULL ACCESS':'full','FTO CHIEF':'none','FTO MEMBER':'none','IA CHIEF':'none','IA MEMBER':'none','WING COMMANDER':'none','WINGS':'none','APPLICANT VIEWER':'none','VISITOR':'none' },
  accounts:     { OWNER:'full','FULL ACCESS':'full','FTO CHIEF':'none','FTO MEMBER':'none','IA CHIEF':'none','IA MEMBER':'none','WING COMMANDER':'none','WINGS':'none','APPLICANT VIEWER':'none','VISITOR':'none' },
  settings:     { OWNER:'full','FULL ACCESS':'full','FTO CHIEF':'full','FTO MEMBER':'none','IA CHIEF':'none','IA MEMBER':'none','WING COMMANDER':'none','WINGS':'none','APPLICANT VIEWER':'none','VISITOR':'none' },
  division_members:{ OWNER:'full','FULL ACCESS':'full','FTO CHIEF':'full','FTO MEMBER':'none','IA CHIEF':'full','IA MEMBER':'none','WING COMMANDER':'full','WINGS':'none','APPLICANT VIEWER':'none','VISITOR':'none' }
};

function hasPerm(user, feature, level = 'view') {
  if (user.is_owner) return true;
  const p = PERM[feature]?.[user.role] || 'none';
  if (level === 'view') return p === 'full' || p === 'view' || p === 'create';
  if (level === 'create') return p === 'full' || p === 'create';
  if (level === 'full') return p === 'full';
  return false;
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ DATABASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
let db;

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDB();
  const r = db.exec('SELECT last_insert_rowid() as id, changes() as changes');
  const row = r[0]?.values[0];
  return { lastInsertRowid: row ? row[0] : null, changes: row ? row[1] : 0 };
}

function dbGet(sql, params = []) {
  const rows = dbQuery(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    emoji TEXT DEFAULT 'ًں‘¤',
    role TEXT NOT NULL DEFAULT 'VISITOR',
    is_owner INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    date TEXT DEFAULT (date('now')),
    created_by INTEGER REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'application',
    name TEXT NOT NULL,
    discord TEXT NOT NULL,
    reason TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    date TEXT DEFAULT (date('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    date TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    user_id INTEGER,
    username TEXT,
    details TEXT DEFAULT '',
    date TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    officer_name TEXT NOT NULL,
    cert_type TEXT NOT NULL,
    rank_name TEXT NOT NULL,
    issue_date TEXT NOT NULL,
    issued_by INTEGER,
    issued_name TEXT,
    is_public INTEGER DEFAULT 1,
    date_created TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Migrate old DB: add columns that might be missing
  try { db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'VISITOR'"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE applications ADD COLUMN type TEXT NOT NULL DEFAULT 'application'"); } catch(e) {}
  try { db.run("ALTER TABLE applications ADD COLUMN answers TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE applications ADD COLUMN current_department TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE public_reports ADD COLUMN rank TEXT NOT NULL DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE public_reports ADD COLUMN link TEXT DEFAULT ''"); } catch(e) {}
  try { db.run("ALTER TABLE public_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS public_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rank TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    link TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    date TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS division_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    division TEXT NOT NULL,
    name TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Seed owner
  const owner = dbGet('SELECT id FROM users WHERE is_owner = 1');
  if (!owner) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO users (username,password,display_name,emoji,role,is_owner) VALUES (?,?,?,?,?,1)',
      ['admin', hash, 'Chief of Police', 'ًں‘‘', 'OWNER']);
  }

  // Seed default settings
  const settingsExist = dbGet("SELECT key FROM settings WHERE key='applications_open'");
  if (!settingsExist) {
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('applications_open', 'true')");
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('transfers_open', 'true')");
  }

  // Seed default announcements
  const annCount = dbGet('SELECT COUNT(*) as c FROM announcements');
  if (annCount.c === 0) {
    db.run('INSERT INTO announcements (title,body,date) VALUES (?,?,?)',
      ['ظپطھط­ ط¨ط§ط¨ ط§ظ„طھظ‚ط¯ظٹظ… ط§ظ„ط±ط³ظ…ظٹ', 'ظٹظڈط¹ظ„ظ† ظ‚ط³ظ… ط§ظ„ظ…ظˆط§ط±ط¯ ط§ظ„ط¨ط´ط±ظٹط© ظپظٹ ط´ط±ط·ط© ظ„ظˆط³ ط³ط§ظ†طھظˆط³ ط¹ظ† ظپطھط­ ط¨ط§ط¨ ط§ظ„طھظ‚ط¯ظٹظ… ط§ظ„ط±ط³ظ…ظٹ ظ„ظ„ظ…طھظ‚ط¯ظ…ظٹظ† ط§ظ„ط¬ط¯ط¯.', '2025-01-01']);
  }

  saveDB();
  console.log('âœ… Database initialized');
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MIDDLEWARE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function logAction(action, user, details = '') {
  dbRun('INSERT INTO logs (action, user_id, username, details) VALUES (?,?,?,?)',
    [action, user?.id || null, user?.display_name || 'system', details]);
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ AUTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = dbGet('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, display_name: user.display_name, role: user.role, is_owner: !!user.is_owner, emoji: user.emoji },
    JWT_SECRET, { expiresIn: '24h' }
  );

  logAction('login', user);
  res.json({
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, emoji: user.emoji, role: user.role, is_owner: !!user.is_owner }
  });
});

app.get('/api/me', auth, (req, res) => {
  const user = dbGet('SELECT id, username, display_name, emoji, role, is_owner FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...user, is_owner: !!user.is_owner });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ USERS / ACCOUNTS (owner only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/users', auth, (req, res) => {
  if (!hasPerm(req.user, 'accounts', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const users = dbQuery('SELECT id, username, display_name, emoji, role, is_owner, created_at FROM users ORDER BY is_owner DESC, id ASC');
  res.json(users.map(u => ({ ...u, is_owner: !!u.is_owner })));
});

app.post('/api/users', auth, (req, res) => {
  if (!hasPerm(req.user, 'accounts', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { username, password, display_name, emoji, role } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: 'Required fields missing' });

  const exists = dbGet('SELECT id FROM users WHERE LOWER(username)=LOWER(?)', [username]);
  if (exists) return res.status(409).json({ error: 'Username already exists' });

  const validRoles = Object.keys(PERM.certificates);
  const finalRole = validRoles.includes(role) ? role : 'VISITOR';

  const hash = bcrypt.hashSync(password, 10);
  dbRun('INSERT INTO users (username,password,display_name,emoji,role) VALUES (?,?,?,?,?)',
    [username, hash, display_name, emoji || 'ًں‘¤', finalRole]);

  logAction('create_user', req.user, `Created user: ${username} (${finalRole})`);
  res.json({ success: true });
});

app.put('/api/users/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'accounts', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const userId = parseInt(req.params.id);
  const target = dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.is_owner) return res.status(403).json({ error: 'Cannot modify owner' });

  const { display_name, emoji, role, password } = req.body;
  if (display_name) dbRun('UPDATE users SET display_name=? WHERE id=?', [display_name, userId]);
  if (emoji) dbRun('UPDATE users SET emoji=? WHERE id=?', [emoji, userId]);
  if (role) {
    const validRoles = Object.keys(PERM.certificates);
    if (validRoles.includes(role)) dbRun('UPDATE users SET role=? WHERE id=?', [role, userId]);
  }
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    dbRun('UPDATE users SET password=? WHERE id=?', [hash, userId]);
  }
  logAction('update_user', req.user, `Updated user: ${target.username}`);
  res.json({ success: true });
});

app.delete('/api/users/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'accounts', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const target = dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.is_owner) return res.status(403).json({ error: 'Cannot delete owner' });

  dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);
  logAction('delete_user', req.user, `Deleted user: ${target.username}`);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ ANNOUNCEMENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/announcements', (req, res) => {
  res.json(dbQuery('SELECT * FROM announcements ORDER BY id DESC'));
});

app.post('/api/announcements', auth, (req, res) => {
  if (!hasPerm(req.user, 'reports', 'create')) return res.status(403).json({ error: 'Forbidden' });
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });

  dbRun("INSERT INTO announcements (title,body,date,created_by) VALUES (?,?,date('now'),?)", [title, body, req.user.id]);
  logAction('create_announcement', req.user, title);
  res.json({ success: true });
});

app.delete('/api/announcements/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'reports', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const ann = dbGet('SELECT * FROM announcements WHERE id=?', [req.params.id]);
  if (!ann) return res.status(404).json({ error: 'Not found' });
  dbRun('DELETE FROM announcements WHERE id=?', [req.params.id]);
  logAction('delete_announcement', req.user, ann.title);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ APPLICATIONS & TRANSFERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/settings', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  const s = dbQuery('SELECT * FROM settings');
  const map = {};
  s.forEach(r => map[r.key] = r.value);
  res.json(map);
});

app.put('/api/settings', auth, (req, res) => {
  if (!hasPerm(req.user, 'settings', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { key, value } = req.body;
  // FTO CHIEF can only toggle applications_open
  if (req.user.role === 'FTO CHIEF' && key !== 'applications_open') return res.status(403).json({ error: 'Forbidden' });
  dbRun('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, value]);
  logAction('update_settings', req.user, `${key}=${value}`);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ QUESTIONS (stored in settings) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/questions/:type', (req, res) => {
  const setting = dbGet('SELECT value FROM settings WHERE key=?', ['questions_' + req.params.type]);
  res.json(setting ? JSON.parse(setting.value) : []);
});

app.put('/api/questions/:type', auth, (req, res) => {
  if (!hasPerm(req.user, 'settings', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { questions } = req.body;
  dbRun('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', ['questions_' + req.params.type, JSON.stringify(questions || [])]);
  logAction('update_questions', req.user, req.params.type);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PUBLIC REPORTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/public-reports', auth, (req, res) => {
  if (req.user.role !== 'OWNER' && req.user.role !== 'FULL ACCESS' && !req.user.is_owner) return res.status(403).json({ error: 'Forbidden' });
  res.json(dbQuery('SELECT * FROM public_reports ORDER BY id DESC'));
});

app.post('/api/public-reports', (req, res) => {
  const { name, rank, body, link } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'Name and body required' });
  dbRun('INSERT INTO public_reports (name, rank, body, link) VALUES (?,?,?,?)', [name, rank || '', body, link || '']);
  res.json({ success: true });
});

app.delete('/api/public-reports/:id', auth, (req, res) => {
  if (req.user.role !== 'OWNER' && req.user.role !== 'FULL ACCESS' && !req.user.is_owner) return res.status(403).json({ error: 'Forbidden' });
  dbRun('DELETE FROM public_reports WHERE id=?', [req.params.id]);
  logAction('delete_public_report', req.user);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ STATS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/stats/members', auth, (req, res) => {
  if (!hasPerm(req.user, 'accounts', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const stats = dbQuery('SELECT role, COUNT(*) as count FROM users WHERE is_owner=0 GROUP BY role');
  const result = { total: 0 };
  stats.forEach(s => { result[s.role] = s.count; result.total += s.count; });
  res.json(result);
});

app.get('/api/applications', auth, (req, res) => {
  if (!hasPerm(req.user, 'applications', 'view')) return res.status(403).json({ error: 'Forbidden' });
  const type = req.query.type || '';
  let apps;
  if (type) {
    apps = dbQuery('SELECT * FROM applications WHERE type=? ORDER BY id DESC', [type]);
  } else {
    apps = dbQuery('SELECT * FROM applications ORDER BY id DESC');
  }
  res.json(apps);
});

app.post('/api/applications', (req, res) => {
  const { type, name, discord, reason } = req.body;
  if (!name || !discord) return res.status(400).json({ error: 'Name and Discord required' });
  const appType = type === 'transfer' ? 'transfer' : 'application';

  // Check if submissions are open
  const setting = dbGet('SELECT value FROM settings WHERE key=?', [appType + 's_open']);
  if (setting && setting.value === 'false') {
    return res.status(403).json({ error: (appType === 'transfer' ? 'ط§ظ„ظ†ظ‚ظ„' : 'ط§ظ„طھظ‚ط¯ظٹظ…') + ' ظ…ط؛ظ„ظ‚ ط­ط§ظ„ظٹط§ظ‹' });
  }

  dbRun('INSERT INTO applications (type,name,discord,reason) VALUES (?,?,?,?)', [appType, name, discord, reason || '']);
  res.json({ success: true, message: 'طھظ… ط§ظ„ط¥ط±ط³ط§ظ„ ط¨ظ†ط¬ط§ط­' });
});

app.put('/api/applications/:id/status', auth, (req, res) => {
  if (!hasPerm(req.user, 'applications', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { status } = req.body;
  if (!['pending','accepted','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const app = dbGet('SELECT * FROM applications WHERE id=?', [req.params.id]);
  if (!app) return res.status(404).json({ error: 'Not found' });
  dbRun('UPDATE applications SET status=? WHERE id=?', [status, req.params.id]);
  logAction('update_application', req.user, `${app.name} -> ${status}`);
  res.json({ success: true });
});

app.delete('/api/applications/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'applications', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const app = dbGet('SELECT * FROM applications WHERE id=?', [req.params.id]);
  if (!app) return res.status(404).json({ error: 'Not found' });
  dbRun('DELETE FROM applications WHERE id=?', [req.params.id]);
  logAction('delete_application', req.user, app.name);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ REPORTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/reports', auth, (req, res) => {
  if (!hasPerm(req.user, 'reports', 'view')) return res.status(403).json({ error: 'Forbidden' });
  res.json(dbQuery('SELECT r.*, u.display_name as author_name FROM reports r LEFT JOIN users u ON r.created_by=u.id ORDER BY r.id DESC'));
});

app.post('/api/reports', auth, (req, res) => {
  if (!hasPerm(req.user, 'reports', 'create')) return res.status(403).json({ error: 'Forbidden' });
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  dbRun('INSERT INTO reports (title,body,created_by) VALUES (?,?,?)', [title, body, req.user.id]);
  logAction('create_report', req.user, title);
  res.json({ success: true });
});

app.put('/api/reports/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'reports', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { title, body } = req.body;
  const r = dbGet('SELECT * FROM reports WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (title) dbRun('UPDATE reports SET title=? WHERE id=?', [title, req.params.id]);
  if (body) dbRun('UPDATE reports SET body=? WHERE id=?', [body, req.params.id]);
  logAction('update_report', req.user, r.title);
  res.json({ success: true });
});

app.delete('/api/reports/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'reports', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const r = dbGet('SELECT * FROM reports WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Not found' });
  dbRun('DELETE FROM reports WHERE id=?', [req.params.id]);
  logAction('delete_report', req.user, r.title);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ LOGS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/logs', auth, (req, res) => {
  if (!hasPerm(req.user, 'logs', 'full')) return res.status(403).json({ error: 'Forbidden' });
  res.json(dbQuery('SELECT * FROM logs ORDER BY id DESC LIMIT 200'));
});

app.delete('/api/logs', auth, (req, res) => {
  if (!hasPerm(req.user, 'logs', 'full')) return res.status(403).json({ error: 'Forbidden' });
  dbRun('DELETE FROM logs');
  logAction('clear_logs', req.user);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ CERTIFICATES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('/api/certificates', (req, res) => {
  const publicOnly = req.query.public === 'true';
  if (publicOnly) {
    res.json(dbQuery("SELECT * FROM certificates WHERE is_public=1 ORDER BY id DESC"));
  } else {
    res.json(dbQuery('SELECT * FROM certificates ORDER BY id DESC'));
  }
});

app.post('/api/certificates', auth, (req, res) => {
  if (!hasPerm(req.user, 'certificates', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { officer_name, cert_type, rank_name, issue_date } = req.body;
  if (!officer_name || !cert_type || !rank_name) return res.status(400).json({ error: 'Required fields missing' });
  dbRun('INSERT INTO certificates (officer_name,cert_type,rank_name,issue_date,issued_by,issued_name) VALUES (?,?,?,?,?,?)',
    [officer_name, cert_type, rank_name, issue_date || new Date().toISOString().slice(0,10), req.user.id, req.user.display_name]);
  logAction('create_certificate', req.user, `${officer_name} - ${cert_type}`);
  res.json({ success: true });
});

app.delete('/api/certificates/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'certificates', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const c = dbGet('SELECT * FROM certificates WHERE id=?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });
  dbRun('DELETE FROM certificates WHERE id=?', [req.params.id]);
  logAction('delete_certificate', req.user, c.officer_name);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ DIVISION MEMBERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function canManageDivision(user, division) {
  if (user.is_owner || user.role === 'FULL ACCESS') return true;
  if (user.role === 'FTO CHIEF' && division === 'FTO') return true;
  if (user.role === 'IA CHIEF' && division === 'IA') return true;
  if (user.role === 'WING COMMANDER' && division === 'WINGS') return true;
  return false;
}

app.get('/api/division-members', auth, (req, res) => {
  if (!hasPerm(req.user, 'division_members', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { division } = req.query;
  if (division && !canManageDivision(req.user, division)) return res.status(403).json({ error: 'Forbidden' });
  let members;
  if (division) {
    members = dbQuery('SELECT * FROM division_members WHERE division=? ORDER BY id DESC', [division]);
  } else {
    members = dbQuery('SELECT * FROM division_members ORDER BY division, id DESC');
  }
  res.json(members);
});

app.post('/api/division-members', auth, (req, res) => {
  if (!hasPerm(req.user, 'division_members', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const { division, name } = req.body;
  if (!division || !name) return res.status(400).json({ error: 'Division and name required' });
  if (!canManageDivision(req.user, division)) return res.status(403).json({ error: 'Forbidden' });
  dbRun('INSERT INTO division_members (division,name,created_by) VALUES (?,?,?)', [division, name, req.user.id]);
  logAction('add_division_member', req.user, `${name} -> ${division}`);
  res.json({ success: true });
});

app.put('/api/division-members/:id/points', auth, (req, res) => {
  if (!hasPerm(req.user, 'division_members', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const member = dbGet('SELECT * FROM division_members WHERE id=?', [req.params.id]);
  if (!member) return res.status(404).json({ error: 'Not found' });
  if (!canManageDivision(req.user, member.division)) return res.status(403).json({ error: 'Forbidden' });
  const { points } = req.body;
  if (typeof points !== 'number') return res.status(400).json({ error: 'Points must be a number' });
  dbRun('UPDATE division_members SET points=? WHERE id=?', [member.points + points, member.id]);
  logAction('update_points', req.user, `${member.name}: ${points>0?'+':''}${points}`);
  res.json({ success: true });
});

app.put('/api/division-members/:id/notes', auth, (req, res) => {
  if (!hasPerm(req.user, 'division_members', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const member = dbGet('SELECT * FROM division_members WHERE id=?', [req.params.id]);
  if (!member) return res.status(404).json({ error: 'Not found' });
  if (!canManageDivision(req.user, member.division)) return res.status(403).json({ error: 'Forbidden' });
  const { notes } = req.body;
  dbRun('UPDATE division_members SET notes=? WHERE id=?', [notes || '', member.id]);
  logAction('update_notes', req.user, member.name);
  res.json({ success: true });
});

app.delete('/api/division-members/:id', auth, (req, res) => {
  if (!hasPerm(req.user, 'division_members', 'full')) return res.status(403).json({ error: 'Forbidden' });
  const member = dbGet('SELECT * FROM division_members WHERE id=?', [req.params.id]);
  if (!member) return res.status(404).json({ error: 'Not found' });
  if (!canManageDivision(req.user, member.division)) return res.status(403).json({ error: 'Forbidden' });
  dbRun('DELETE FROM division_members WHERE id=?', [member.id]);
  logAction('delete_division_member', req.user, member.name);
  res.json({ success: true });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ RANKS (public) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const RANKS_DATA = {
  'OWNER':            { emoji:'ًں‘‘', level:0, permissions:['ظƒظ„ ط§ظ„طµظ„ط§ط­ظٹط§طھ'] },
  'FULL ACCESS':      { emoji:'ًں”µ', level:1, permissions:['ط´ظ‡ط§ط¯ط§طھ','طھظ‚ط§ط±ظٹط±','طھظ‚ط¯ظٹظ…ط§طھ','ط³ط¬ظ„ط§طھ'] },
  'FTO CHIEF':        { emoji:'ًںں،', level:2, permissions:['ط´ظ‡ط§ط¯ط§طھ','طھظ‚ط§ط±ظٹط±','طھظ‚ط¯ظٹظ…ط§طھ'] },
  'FTO MEMBER':       { emoji:'ًںں¢', level:3, permissions:['ط´ظ‡ط§ط¯ط§طھ','ط¥ظ†ط´ط§ط، طھظ‚ط§ط±ظٹط±'] },
  'IA CHIEF':         { emoji:'ًں”´', level:4, permissions:['ط´ظ‡ط§ط¯ط§طھ','طھظ‚ط§ط±ظٹط±','طھظ‚ط¯ظٹظ…ط§طھ'] },
  'IA MEMBER':        { emoji:'ًںں ', level:5, permissions:['ط´ظ‡ط§ط¯ط§طھ','طھظ‚ط§ط±ظٹط±'] },
  'WING COMMANDER':   { emoji:'ًںں£', level:6, permissions:['ط´ظ‡ط§ط¯ط§طھ','طھظ‚ط§ط±ظٹط±','طھظ‚ط¯ظٹظ…ط§طھ'] },
  'WINGS':            { emoji:'âڑھ', level:7, permissions:['ط´ظ‡ط§ط¯ط§طھ','طھظ‚ط§ط±ظٹط±'] },
  'APPLICANT VIEWER': { emoji:'ًں‘پï¸ڈ', level:8, permissions:['ط¹ط±ط¶ ط§ظ„طھظ‚ط¯ظٹظ…ط§طھ ظپظ‚ط·'] },
  'VISITOR':          { emoji:'ًں‘¤', level:9, permissions:['ظ„ط§ ظٹظˆط¬ط¯ طµظ„ط§ط­ظٹط§طھ'] }
};

app.get('/api/ranks', (req, res) => {
  res.json(RANKS_DATA);
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ SERVE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const ip = Object.values(ifaces).flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`âœ… LSPD Portal running on http://localhost:${PORT}`);
    console.log(`   Network:  http://${ip}:${PORT}`);
    console.log(`   Owner: admin / admin123`);
    console.log(`   Roles: ${Object.keys(RANKS_DATA).join(', ')}`);
  });
});
