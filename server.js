const express = require('express');
const Database = require('sql.js');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Client, GatewayIntentBits } = require('discord.js');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data.db');

const SECRET = process.env.JWT_SECRET || 'admin-secret-key-2026';

app.use(express.json());
app.use(express.static(__dirname));

/* ─── DB ─── */
let db;
function initDB() {
  if (fs.existsSync(DB_PATH)) {
    db = new Database(fs.readFileSync(DB_PATH));
  } else {
    db = new Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, display_name TEXT, role TEXT DEFAULT 'ADMIN', discord_tag TEXT);
    CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT DEFAULT 'MEMBER', points INTEGER DEFAULT 0, notes TEXT DEFAULT '', discord_tag TEXT, created_at DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, discord_tag TEXT, message TEXT, status TEXT DEFAULT 'pending', date DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, reason TEXT, type TEXT, date DATETIME DEFAULT (datetime('now')), FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, by TEXT, detail TEXT, date DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  saveDB();
}

function saveDB() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch {}
}

function dbGet(q, p=[]) { const r = db.exec(q, p); return r.length ? r[0] : null; }
function dbRun(q, p=[]) { db.run(q, p); saveDB(); }
function dbQuery(q, p=[]) { const r = db.exec(q, p); if (!r.length) return []; return r[0].values.map(v => { const o={}; r[0].columns.forEach((c,i) => o[c]=v[i]); return o; }); }

function logAction(action, by, detail) {
  dbRun("INSERT INTO logs (action, by, detail) VALUES (?,?,?)", [action, by, detail]);
}

/* ─── AUTH ─── */
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const p = jwt.verify(h.slice(7), SECRET);
    req.user = p;
    next();
  } catch { res.status(401).json({ error: 'توكن غير صالح' }); }
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'أدخل بيانات الدخول' });
  const user = dbGet("SELECT * FROM users WHERE username=?", [username]);
  if (!user) return res.status(401).json({ error: 'بيانات خاطئة' });
  const ok = await bcrypt.compare(password, user[2] || user.password);
  if (!ok) return res.status(401).json({ error: 'بيانات خاطئة' });
  const token = jwt.sign({ id: user[0], username: user[1], display_name: user[3], role: user[4] }, SECRET, { expiresIn: '7d' });
  logAction('تسجيل دخول', username, 'من لوحة الإدارة');
  res.json({ token });
});

app.post('/api/users', auth, async (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: 'حقول ناقصة' });
  const exists = dbGet("SELECT id FROM users WHERE username=?", [username]);
  if (exists) return res.status(400).json({ error: 'اسم المستخدم موجود' });
  const hash = await bcrypt.hash(password, 10);
  dbRun("INSERT INTO users (username, password, display_name, role) VALUES (?,?,?,?)", [username, hash, display_name, role || 'ADMIN']);
  logAction('إضافة مستخدم', req.user.username, display_name);
  res.json({ success: true });
});

app.get('/api/users', auth, (req, res) => {
  const users = dbQuery("SELECT id, username, display_name, role FROM users");
  res.json(users);
});

app.delete('/api/users/:id', auth, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'لا تحذف نفسك' });
  dbRun("DELETE FROM users WHERE id=?", [req.params.id]);
  logAction('حذف مستخدم', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── MEMBERS ─── */
app.post('/api/members', auth, (req, res) => {
  const { name, role, discord_tag } = req.body;
  if (!name) return res.status(400).json({ error: 'أدخل الاسم' });
  dbRun("INSERT INTO members (name, role, discord_tag) VALUES (?,?,?)", [name, role || 'MEMBER', discord_tag || '']);
  logAction('إضافة عضو', req.user.username, name);
  res.json({ success: true });
});

app.get('/api/members', auth, (req, res) => {
  res.json(dbQuery("SELECT * FROM members ORDER BY points DESC, name"));
});

app.put('/api/members/:id/points', auth, (req, res) => {
  const { points } = req.body;
  dbRun("UPDATE members SET points = points + ? WHERE id=?", [points, req.params.id]);
  logAction('تحديث نقاط', req.user.username, `ID:${req.params.id} ${points > 0 ? '+' : ''}${points}`);
  res.json({ success: true });
});

app.put('/api/members/:id/notes', auth, (req, res) => {
  const { notes } = req.body;
  dbRun("UPDATE members SET notes=? WHERE id=?", [notes || '', req.params.id]);
  res.json({ success: true });
});

app.put('/api/members/:id/role', auth, (req, res) => {
  const { role } = req.body;
  dbRun("UPDATE members SET role=? WHERE id=?", [role, req.params.id]);
  logAction('تغيير رتبة', req.user.username, `ID:${req.params.id} → ${role}`);
  res.json({ success: true });
});

app.delete('/api/members/:id', auth, (req, res) => {
  const m = dbGet("SELECT name FROM members WHERE id=?", [req.params.id]);
  dbRun("DELETE FROM members WHERE id=?", [req.params.id]);
  if (m) logAction('حذف عضو', req.user.username, m[0]);
  res.json({ success: true });
});

/* ─── APPLICATIONS ─── */
app.post('/api/applications', auth, (req, res) => {
  const { name, discord_tag, message } = req.body;
  if (!name) return res.status(400).json({ error: 'أدخل الاسم' });
  dbRun("INSERT INTO applications (name, discord_tag, message) VALUES (?,?,?)", [name, discord_tag || '', message || '']);
  logAction('تقديم جديد', req.user.username, name);
  res.json({ success: true });
});

app.get('/api/applications', auth, (req, res) => {
  res.json(dbQuery("SELECT * FROM applications ORDER BY date DESC"));
});

app.put('/api/applications/:id', auth, (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  const a = dbGet("SELECT name FROM applications WHERE id=?", [req.params.id]);
  dbRun("UPDATE applications SET status=?, reviewed_at=datetime('now') WHERE id=?", [status, req.params.id]);
  if (a) logAction(status === 'accepted' ? 'قبول تقديم' : 'رفض تقديم', req.user.username, a[0]);

  // Discord DM on decision
  if (status !== 'pending' && a) {
    const ap = dbGet("SELECT discord_tag FROM applications WHERE id=?", [req.params.id]);
    if (ap && ap[0]) sendDiscordDM(ap[0], status === 'accepted' ? '✅ تم قبول تقديمك!' : '❌ تم رفض تقديمك.');
  }

  // Webhook
  if (status !== 'pending' && a) {
    const wh = getSetting('webhook_applications');
    if (wh) sendWebhook(wh, {
      content: status === 'accepted'
        ? `✅ **تقديم مقبول**\nالاسم: ${a[0]}\nالتاريخ: ${new Date().toLocaleDateString('ar-SA')}`
        : `❌ **تقديم مرفوض**\nالاسم: ${a[0]}\nالتاريخ: ${new Date().toLocaleDateString('ar-SA')}`
    });
  }

  res.json({ success: true });
});

app.delete('/api/applications/:id', auth, (req, res) => {
  dbRun("DELETE FROM applications WHERE id=?", [req.params.id]);
  logAction('حذف تقديم', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── WARNINGS ─── */
app.post('/api/warnings', auth, (req, res) => {
  const { member_id, reason, type } = req.body;
  if (!member_id || !reason) return res.status(400).json({ error: 'بيانات ناقصة' });
  const m = dbGet("SELECT name FROM members WHERE id=?", [member_id]);
  dbRun("INSERT INTO warnings (member_id, reason, type) VALUES (?,?,?)", [member_id, reason, type || 'written']);
  if (m) logAction('تحذير عضو', req.user.username, `${m[0]}: ${reason}`);
  res.json({ success: true });
});

app.get('/api/warnings', auth, (req, res) => {
  res.json(dbQuery("SELECT w.*, m.name as member_name FROM warnings w LEFT JOIN members m ON w.member_id=m.id ORDER BY w.date DESC"));
});

app.delete('/api/warnings/:id', auth, (req, res) => {
  dbRun("DELETE FROM warnings WHERE id=?", [req.params.id]);
  logAction('حذف تحذير', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── LOGS ─── */
app.get('/api/logs', auth, (req, res) => {
  res.json(dbQuery("SELECT * FROM logs ORDER BY date DESC LIMIT 200"));
});

/* ─── SETTINGS ─── */
app.get('/api/settings', auth, (req, res) => {
  const rows = dbQuery("SELECT * FROM settings");
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json({ settings });
});

app.put('/api/settings', auth, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'مفتاح مطلوب' });
  dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", [key, value]);
  logAction('تغيير إعداد', req.user.username, key);
  res.json({ success: true });
});

/* ─── HELPERS ─── */
function getSetting(key) {
  const r = dbGet("SELECT value FROM settings WHERE key=?", [key]);
  return r ? r[0] : null;
}

function sendWebhook(url, body) {
  try {
    const data = JSON.stringify(typeof body === 'string' ? { content: body } : body);
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      if (res.statusCode < 300) console.log('Webhook sent');
    });
    req.on('error', e => console.error('Webhook error:', e.message));
    req.write(data);
    req.end();
  } catch {}
}

let botClient = null;
let botGuildId = null;

async function initBot() {
  const token = getSetting('bot_token');
  if (!token) return;
  botGuildId = getSetting('guild_id');

  botClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  botClient.on('clientReady', () => console.log('Admin Bot online:', botClient.user.tag));

  botClient.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    const content = msg.content || '';
    if (!content) { msg.reply('⚠️ البوت مايقدر يقرأ الرسائل. فعّل Message Content Intent').catch(()=>{}); return; }

    if (content.startsWith('!اجازة')) {
      const parts = content.slice('!اجازة'.length).trim().split('\n').map(s => s.trim()).filter(Boolean);
      const name = parts[0] || msg.author.displayName;
      const days = parseInt(parts[1]);
      if (!days || days < 1) { msg.reply('⚠️ استخدم:\n`!اجازة`\n`الاسم`\n`عدد الأيام`'); return; }
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(); end.setDate(end.getDate() + days);
      dbRun("INSERT INTO applications (name, discord_tag, message, status) VALUES (?,?,?,?)", [name, msg.author.tag, `إجازة ${days} يوم`, 'pending']);
      msg.reply(`✅ تم استلام طلب الإجازة لـ ${name} (${days} يوم)`);
      const wh = getSetting('webhook_applications');
      if (wh) sendWebhook(wh, { content: `📩 **طلب إجازة**\nالاسم: ${name}\nالمدة: ${days} يوم\nDiscord: ${msg.author.tag}` });
    }

    if (content.startsWith('!تحذير')) {
      const parts = content.slice('!تحذير'.length).trim().split(' ');
      const reason = parts.slice(1).join(' ') || parts[0];
      if (!parts[0]) { msg.reply('⚠️ استخدم: `!تحذير @العضو السبب`'); return; }
      const member = msg.mentions.members?.first();
      if (!member) { msg.reply('⚠️ منشن العضو المطلوب تحذيره'); return; }
      const m = dbGet("SELECT id FROM members WHERE discord_tag=?", [member.user.tag]);
      if (!m) { msg.reply('⚠️ العضو غير موجود في القائمة. أضفه أولاً'); return; }
      dbRun("INSERT INTO warnings (member_id, reason, type) VALUES (?,'?','written')", [m[0], reason]);
      msg.reply(`✅ تم تحذير ${member.user.username}: ${reason}`);
      logAction('تحذير عبر البوت', member.user.tag, reason);
    }
  });

  try { await botClient.login(token); } catch (e) { console.error('Bot login fail:', e.message); botClient = null; }
}

async function sendDiscordDM(tag, content) {
  if (!botClient || !botGuildId) return;
  const guild = botClient.guilds.cache.get(botGuildId);
  if (!guild) return;
  try { await guild.members.fetch(); } catch {}
  const member = guild.members.cache.find(m => m.user.tag === tag || m.user.username === tag || m.user.displayName === tag);
  if (!member) return;
  try { await member.send(content); } catch {}
}

/* ─── SEED DEFAULT ADMIN ─── */
function seedAdmin() {
  const exists = dbGet("SELECT id FROM users WHERE username='admin'");
  if (!exists) {
    bcrypt.hash('admin123', 10).then(hash => {
      dbRun("INSERT INTO users (username, password, display_name, role) VALUES (?,?,?,?)", ['admin', hash, 'المدير', 'OWNER']);
      console.log('Default admin created: admin / admin123');
    });
  }
}

/* ─── SERVE ─── */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ─── INIT ─── */
initDB();
seedAdmin();
initBot();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Server Admin Panel: http://localhost:${PORT}`);
});
