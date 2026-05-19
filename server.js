const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const https = require('https');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(process.env.DB_PATH || __dirname, 'data.db');
const BACKUP_DIR = path.join(process.env.DB_PATH || __dirname, 'backups');
const SECRET = process.env.JWT_SECRET || 'admin-secret-key-2026';

app.use(express.json());
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set('Content-Type', 'text/html; charset=utf-8');
        }
    }
}));

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

let db;
let botClient = null;
let botGuildId = null;

function saveDB() {
  try { 
    fs.writeFileSync(DB_PATH, Buffer.from(db.export())); 
  } catch (e) { console.error('DB Save Failed:', e.message); }
}

function dbRun(q, p = []) { db.run(q, p); saveDB(); }

function dbGet(q, p = []) {
  try {
    if (p.length > 0) {
      const stmt = db.prepare(q);
      stmt.bind(p);
      if (stmt.step()) {
        const res = stmt.getAsObject();
        stmt.free();
        return res;
      }
      stmt.free();
      return null;
    }
    const r = db.exec(q);
    if (!r.length || !r[0].values.length) return null;
    const o = {};
    r[0].columns.forEach((c, i) => o[c] = r[0].values[0][i]);
    return o;
  } catch (e) { console.error('dbGet error:', e.message, q, p); return null; }
}

function dbQuery(q, p = []) {
  try {
    if (p.length > 0) {
      const stmt = db.prepare(q);
      stmt.bind(p);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    }
    const r = db.exec(q);
    if (!r.length || !r[0].values.length) return [];
    return r[0].values.map(v => {
      const o = {};
      r[0].columns.forEach((c, i) => o[c] = v[i]);
      return o;
    });
  } catch (e) { console.error('dbQuery error:', e.message, q, p); return []; }
}

function logAction(action, by, detail) {
  dbRun("INSERT INTO logs (action, by, detail) VALUES (?,?,?)", [action, by, detail || '']);
}

function getSetting(key) {
  const r = dbGet("SELECT value FROM settings WHERE key=?", [key]);
  return r ? r.value : null;
}

function sendWebhook(url, body) {
  try {
    const data = JSON.stringify(typeof body === 'string' ? { content: body } : body);
    const u = new URL(url);
    const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      if (res.statusCode < 300) console.log('Webhook sent');
    });
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch {}
}

async function sendDiscordDM(tag, content) {
  if (!botClient || !botGuildId) return;
  const guild = botClient.guilds.cache.get(botGuildId);
  if (!guild) return;
  try { await guild.members.fetch(); } catch {}
  const member = guild.members.cache.find(m =>
    m.user.tag === tag ||
    m.user.username === tag ||
    m.user.displayName === tag ||
    m.id === tag
  );
  if (!member) return;
  try { await member.send(content); } catch {}
}

async function sendToChannel(settingKey, content) {
  const channelId = getSetting(settingKey);
  if (!channelId || !botClient) return;
  try {
    const guild = botClient.guilds.cache.get(botGuildId);
    if (!guild) return;
    const ch = guild.channels.cache.get(channelId);
    if (ch) await ch.send(content);
  } catch {}
}

function autoBackup() {
  try {
    const data = db.export();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(BACKUP_DIR, `backup-${stamp}.db`), Buffer.from(data));
    const files = fs.readdirSync(BACKUP_DIR).sort();
    while (files.length > 10) { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); }
    console.log('Backup created');
  } catch (e) { console.error('Backup fail:', e.message); }
}

async function sendDailyReport() {
  if (!botClient) return;
  const today = new Date().toISOString().slice(0, 10);
  const l = dbQuery("SELECT * FROM logs WHERE date LIKE ?", [today + '%']);
  const a = dbQuery("SELECT * FROM applications WHERE date LIKE ?", [today + '%']);
  const w = dbQuery("SELECT * FROM warnings WHERE date LIKE ?", [today + '%']);
  const m = dbQuery("SELECT * FROM members ORDER BY points DESC LIMIT 3");
  let msg = `📊 **تقرير يومي - ${today}**\n`;
  msg += `├ النشاطات: ${l.length}\n`;
  msg += `├ التقديمات: ${a.length}\n`;
  msg += `├ التحذيرات: ${w.length}\n`;
  if (m.length) msg += `\n🏆 **المتصدرون:**\n` + m.map((x, i) => `${['🥇','🥈','🥉'][i]} ${x.name}: ${x.points} نقطة`).join('\n');
  await sendToChannel('report_channel', msg);
}

async function sendWeeklyReport() {
  if (!botClient) return;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const l = dbQuery("SELECT COUNT(*) as c FROM logs WHERE date >= ?", [weekAgo]);
  const a = dbQuery("SELECT COUNT(*) as c FROM applications WHERE date >= ?", [weekAgo]);
  const ac = dbQuery("SELECT COUNT(*) as c FROM applications WHERE date >= ? AND status='accepted'", [weekAgo]);
  const rc = dbQuery("SELECT COUNT(*) as c FROM applications WHERE date >= ? AND status='rejected'", [weekAgo]);
  const w = dbQuery("SELECT COUNT(*) as c FROM warnings WHERE date >= ?", [weekAgo]);
  const topW = dbQuery("SELECT m.name, COUNT(*) as cnt FROM warnings w JOIN members m ON w.member_id=m.id WHERE w.date >= ? GROUP BY w.member_id ORDER BY cnt DESC LIMIT 3", [weekAgo]);
  let msg = `📈 **تقرير أسبوعي**\n`;
  msg += `├ النشاطات: ${l[0]?.c || 0}\n`;
  msg += `├ التقديمات: ${a[0]?.c || 0} (✅${ac[0]?.c||0} ❌${rc[0]?.c||0})\n`;
  msg += `├ التحذيرات: ${w[0]?.c || 0}\n`;
  if (topW.length) msg += `\n⚠️ **الأكثر تحذيرات:**\n` + topW.map((x, i) => `${i+1}. ${x.name}: ${x.cnt}`).join('\n');
  await sendToChannel('report_channel', msg);
}

async function initBot() {
  const token = process.env.BOT_TOKEN || getSetting('bot_token');
  console.log('Bot token:', token ? 'FOUND (length: ' + token.length + ')' : 'NOT FOUND');
  if (!token) {
    console.log('⚠️ Bot not starting: No bot_token. Add BOT_TOKEN to Railway env vars or set in admin panel.');
    return;
  }
  botGuildId = process.env.GUILD_ID || getSetting('guild_id');
  console.log('Guild ID:', botGuildId ? 'FOUND' : 'NOT FOUND');
  if (!botGuildId) {
    console.log('⚠️ Warning: No guild_id. Add GUILD_ID to Railway env vars.');
  }
  try {
    console.log('Attempting to login bot...');
    const { Client, GatewayIntentBits } = require('discord.js');
    botClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    botClient.on('clientReady', () => console.log('Admin Bot online:', botClient.user.tag));

    botClient.on('guildMemberAdd', async member => {
      if (member.guild.id !== botGuildId) return;
      if (getSetting('welcome_enabled') === 'false') return;
      const welcomeMsg = getSetting('welcome_message') || `مرحباً ${member.user.displayName} في السيرفر! 🎉\n\n📌 **الرتب المتاحة:**\n👑 OWNER - 👑 المالك\n🛡️ ADMIN - إداري\n⚡ MODERATOR - مشرف\n⭐ VIP - مميز\n👤 MEMBER - عضو\n\nتعرّف على القوانين واستمتع!`;
      try { await member.send(welcomeMsg); } catch {}
    });

    const ticketChannels = {};

    const rateRegex = /(?:<@!?(\d+)>)(.*)/i;

    botClient.on('messageCreate', async msg => {
      if (msg.author.bot) return;
      const content = msg.content || '';
      if (!content) return;

      const rateMatch = content.match(rateRegex);
      if (rateMatch) {
        const ratedId = rateMatch[1];
        const comment = rateMatch[2].trim();
        if (comment && ratedId) {
          let memberId = 0;
          let memberName = 'غير معروف';
          // Try to find the mentioned user's tag to match with members table
          const mentionedUser = msg.mentions.users.first();
          const searchTag = mentionedUser ? mentionedUser.tag : null;
          
          const member = dbQuery("SELECT id, name FROM members WHERE discord_tag=?", [searchTag]);
          if (member.length) {
            memberId = member[0].id;
            memberName = member[0].name;
          }
          const admin = dbQuery("SELECT id, display_name FROM users WHERE discord_tag=? OR discord_id=?", [msg.author.tag, msg.author.id]);
          const raterId = admin.length ? admin[0].id : 0;
          const raterName = admin.length ? admin[0].display_name : msg.author.displayName;
          dbRun("INSERT INTO ratings (member_id, rated_by_id, rated_by_discord, rated_by_name, rating, reason, date) VALUES (?,?,?,?,?,?,?)",
            [memberId, raterId, msg.author.tag, raterName, 0, comment, new Date().toISOString()]);
          logAction('تقييم عضو', raterName, memberName + ' - ' + comment);
          msg.reply('✅ تم تسجيل التقييم');
          return;
        }
      }

      if (content.startsWith('!اجازة')) {
        const parts = content.slice('!اجازة'.length).trim().split('\n').map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) {
          msg.reply('⚠️ الاستخدام:\n`!اجازة`\n`السبب`\n`تاريخ البداية YYYY-MM-DD`\n`تاريخ النهاية YYYY-MM-DD`');
          return;
        }
        const [reason, start, end] = parts;
        if (!start || !end || start > end) { msg.reply('⚠️ تواريخ غير صالحة'); return; }
        const member = dbGet("SELECT id FROM members WHERE discord_tag=?", [msg.author.tag]);
        if (!member) { msg.reply('⚠️ عضو غير مسجل في النظام'); return; }
        dbRun("INSERT INTO leaves (member_id, reason, start_date, end_date) VALUES (?,?,?,?)", [member.id, reason, start, end]);
        msg.reply('✅ تم استلام طلب الإجازة وسيتم مراجعته.');
        const wh = getSetting('webhook_applications');
        if (wh) sendWebhook(wh, { content: `🏖️ **طلب إجازة**\nالعضو: ${msg.author.displayName}\nالسبب: ${reason}\nمن: ${start} إلى: ${end}` });
        return;
      }

      if (content === '!تقديم' || content === '!apply') {
        if (getSetting('applications_open') === 'false') { msg.reply('⚠️ باب التقديم مغلق حالياً'); return; }
        const existing = dbQuery("SELECT id FROM applications WHERE discord_tag=? AND status='pending' LIMIT 1", [msg.author.tag]);
        if (existing.length) { msg.reply('⚠️ لديك تقديم قيد المراجعة'); return; }
        dbRun("INSERT INTO applications (name, discord_tag, message, status) VALUES (?,?,?,?)", [msg.author.displayName, msg.author.tag, 'تقديم عبر البوت', 'pending']);
        msg.reply('✅ تم استلام تقديمك!');
        const wh = getSetting('webhook_applications');
        if (wh) sendWebhook(wh, { content: `📩 **تقديم جديد عبر البوت**\n${msg.author.displayName} (${msg.author.tag})` });
        return;
      }

      if (content === '!leaderboard' || content === '!المتصدرين') {
        const top = dbQuery("SELECT name, points, role FROM members ORDER BY points DESC LIMIT 10");
        if (!top.length) { msg.reply('لا يوجد أعضاء'); return; }
        let msgText = `🏆 **قائمة المتصدرين**\n\n`;
        top.forEach((m, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
          msgText += `${medal} **${m.name}** - ${m.points} نقطة\n`;
        });
        msg.reply(msgText);
        await sendToChannel('leaderboard_channel', msgText);
        return;
      }

      if (content === '!تذكرة' || content === '!ticket') {
        const existing = dbQuery("SELECT id FROM tickets WHERE discord_id=? AND status='open' LIMIT 1", [msg.author.id]);
        if (existing.length) { msg.reply('⚠️ لديك تذكرة مفتوحة بالفعل'); return; }
        dbRun("INSERT INTO tickets (member_name, discord_id, discord_tag, subject, status) VALUES (?,?,?,?,?)", [msg.author.displayName, msg.author.id, msg.author.tag, 'تذكرة دعم', 'open']);
        msg.reply('✅ تم فتح تذكرة دعم، سيتم الرد عليك قريباً.');
        return;
      }

      if (content.startsWith('!تذكرة ') || content.startsWith('!ticket ')) {
        const subject = content.slice(content.indexOf(' ') + 1).trim();
        if (!subject) { msg.reply('⚠️ أدخل موضوع التذكرة'); return; }
        const existing = dbQuery("SELECT id FROM tickets WHERE discord_id=? AND status='open' LIMIT 1", [msg.author.id]);
        if (existing.length) { msg.reply('⚠️ لديك تذكرة مفتوحة بالفعل'); return; }
        dbRun("INSERT INTO tickets (member_name, discord_id, discord_tag, subject, status) VALUES (?,?,?,?,?)", [msg.author.displayName, msg.author.id, msg.author.tag, subject, 'open']);
        msg.reply('✅ تم فتح تذكرة: ' + subject);
        return;
      }

      if (msg.channel.type === 1 && ticketChannels[msg.channelId]) {
        logAction('رد على تذكرة', 'bot', msg.author.tag + ': ' + content.slice(0, 50));
      }
    });

    await botClient.login(token);

    cron.schedule('0 21 * * *', sendDailyReport);
    cron.schedule('0 21 * * 5', sendWeeklyReport);
    cron.schedule('0 */6 * * *', autoBackup);
  } catch (e) { console.error('Bot login fail:', e.message); botClient = null; }
}

async function seedAdmin() {
  try {
    const exists = dbGet("SELECT id FROM users WHERE username='admin'");
    if (!exists) {
      const hash = await bcrypt.hash('admin123', 10);
      dbRun("INSERT INTO users (username, password, display_name, role) VALUES (?,?,?,?)", ['admin', hash, 'المدير', 'OWNER']);
      console.log('Default admin created: admin / admin123');
    }
  } catch (e) { console.error('Seed admin failed:', e.message); }
}

/* ─── AUTH ─── */
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'غير مصرح' });
  try {
    req.user = jwt.verify(h.slice(7), SECRET);
    const user = dbGet("SELECT * FROM users WHERE id=?", [req.user.id]);
    if (!user) return res.status(401).json({ error: 'مستخدم غير موجود' });
    req.user.role = user.role;
    req.user.dbUser = user;
    next();
  } catch { res.status(401).json({ error: 'توكن غير صالح' }); }
}

function requireRole(minRole) {
  const hierarchy = { 'OWNER': 0, 'ADMIN': 1, 'MODERATOR': 2, 'VIP': 3, 'MEMBER': 4, 'GUEST': 5 };
  return (req, res, next) => {
    const userLevel = hierarchy[req.user.role] ?? 99;
    const requiredLevel = hierarchy[minRole] ?? 99;
    if (userLevel > requiredLevel) return res.status(403).json({ error: 'غير مصرح - تحتاج رتبة ' + minRole });
    next();
  };
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log('[LOGIN] Attempt:', username);
  if (!username || !password) return res.status(400).json({ error: 'أدخل بيانات الدخول' });
  const user = dbGet("SELECT * FROM users WHERE username=?", [username]);
  console.log('[LOGIN] User found:', !!user, user ? `Hash starts with: ${user.password?.slice(0, 15)}...` : 'null');
  if (!user) return res.status(401).json({ error: 'بيانات خاطئة' });
  const ok = await bcrypt.compare(password, user.password);
  console.log('[LOGIN] Password match:', ok);
  if (!ok) return res.status(401).json({ error: 'بيانات خاطئة' });
  const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, SECRET, { expiresIn: '7d' });
  logAction('تسجيل دخول', username, 'من لوحة الإدارة');
  res.json({ token });
});

app.get('/api/me', auth, (req, res) => {
  const user = dbGet("SELECT id, username, display_name, role FROM users WHERE id=?", [req.user.id]);
  if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
  res.json(user);
});

app.post('/api/users', auth, requireRole('OWNER'), async (req, res) => {
  try {
    const { username, password, display_name, role, discord_tag, member_code } = req.body;
    if (!username || !password || !display_name) return res.status(400).json({ error: 'حقول ناقصة' });
    const exists = dbGet("SELECT id FROM users WHERE username=?", [username]);
    if (exists) return res.status(400).json({ error: 'اسم المستخدم موجود' });
    const hash = await bcrypt.hash(password, 10);
    dbRun("INSERT INTO users (username, password, display_name, role, discord_tag) VALUES (?,?,?,?,?)", [username, hash, display_name, role || 'ADMIN', discord_tag || '']);
    
    // Add to members table automatically
    const code = member_code || Math.random().toString(36).substring(2, 8).toUpperCase();
    dbRun("INSERT INTO members (name, role, discord_tag, member_code) VALUES (?,?,?,?)", [display_name, role || 'MEMBER', discord_tag || '', code]);
    
    logAction('إضافة مستخدم وعضو', req.user.username, display_name);
    
    // Send DM with credentials
    if (botClient && discord_tag) {
      const msg = `🎉 مرحباً ${display_name} في السيرفر!\n\n📌 رتبتك: ${role || 'MEMBER'}\n🆔 كودك: ${code}\n🔑 حسابك: ${username}\n🔑 كلمة المرور: ${password}`;
      sendDiscordDM(discord_tag, msg);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Add user error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users', auth, (req, res) => { res.json(dbQuery("SELECT id, username, display_name, role FROM users")); });
app.delete('/api/users/:id', auth, requireRole('OWNER'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'لا تحذف نفسك' });
  dbRun("DELETE FROM users WHERE id=?", [req.params.id]);
  res.json({ success: true });
});

/* ─── MEMBERS ─── */
app.post('/api/members', auth, async (req, res) => {
  try {
    const { name, role, discord_tag, member_code } = req.body;
    if (!name) return res.status(400).json({ error: 'أدخل الاسم' });
    dbRun("INSERT INTO members (name, role, discord_tag, member_code) VALUES (?,?,?,?)", [name, role || 'MEMBER', discord_tag || '', member_code || '']);
    logAction('إضافة عضو', req.user.username, name);
    if (botClient && discord_tag && getSetting('welcome_enabled') !== 'false') {
      const msg = getSetting('member_accept_msg') || `🎉 مرحباً ${name}!\n\n📌 رتبتك: ${role || 'MEMBER'}\n🆔 كودك: ${member_code || '—'}\n\nأهلاً بك!`;
      sendDiscordDM(discord_tag, msg);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Add member error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/members', auth, (req, res) => { res.json(dbQuery("SELECT * FROM members ORDER BY points DESC, name")); });

app.put('/api/members/:id/points', auth, async (req, res) => {
  const { reason } = req.body;
  const m = dbGet("SELECT name, discord_tag, points FROM members WHERE id=?", [req.params.id]);
  const pts = parseInt(req.body.points) || 0;
  dbRun("UPDATE members SET points = points + ? WHERE id=?", [pts, req.params.id]);
  dbRun("INSERT INTO points_log (member_id, points_change, reason, by_user) VALUES (?,?,?,?)", [req.params.id, pts, reason || (pts > 0 ? 'إضافة نقاط' : 'خصم نقاط'), req.user.username]);
  logAction('تحديث نقاط', req.user.username, 'ID:' + req.params.id + ' ' + (pts > 0 ? '+' : '') + pts);
  if (m && m.discord_tag) {
    const newPoints = (m.points || 0) + pts;
    if (pts < 0) {
      sendDiscordDM(m.discord_tag, '🔻 **تم خصم نقاط**\nالعضو: ' + m.name + '\nالخصم: ' + Math.abs(pts) + ' نقطة\nالسبب: ' + (reason || '—') + '\nرصيدك الحالي: ' + newPoints + ' نقطة');
    } else {
      sendDiscordDM(m.discord_tag, '🔺 **تمت إضافة نقاط**\nالعضو: ' + m.name + '\nالنقاط: +' + pts + '\nالسبب: ' + (reason || '—') + '\nرصيدك الحالي: ' + newPoints + ' نقطة');
    }
  }
  res.json({ success: true });
});

app.get('/api/members/:id/points-log', auth, (req, res) => {
  res.json(dbQuery("SELECT pl.*, m.name as member_name FROM points_log pl JOIN members m ON pl.member_id=m.id WHERE pl.member_id=? ORDER BY pl.date DESC", [req.params.id]));
});

app.get('/api/leaderboard', auth, (req, res) => { res.json(dbQuery("SELECT name, points, role, discord_tag FROM members ORDER BY points DESC LIMIT 50")); });

app.put('/api/members/:id/notes', auth, (req, res) => {
  dbRun("UPDATE members SET notes=? WHERE id=?", [req.body.notes || '', req.params.id]);
  res.json({ success: true });
});

app.put('/api/members/:id/role', auth, async (req, res) => {
  const m = dbGet("SELECT name, discord_tag FROM members WHERE id=?", [req.params.id]);
  dbRun("UPDATE members SET role=? WHERE id=?", [req.body.role, req.params.id]);
  logAction('تغيير رتبة', req.user.username, 'ID:' + req.params.id + ' → ' + req.body.role);
  if (m && m.discord_tag) sendDiscordDM(m.discord_tag, '🎖️ **تم تغيير رتبتك**\nالرتبة الجديدة: ' + req.body.role);
  res.json({ success: true });
});

app.delete('/api/members/:id', auth, (req, res) => {
  const m = dbGet("SELECT name FROM members WHERE id=?", [req.params.id]);
  dbRun("DELETE FROM members WHERE id=?", [req.params.id]);
  if (m) logAction('حذف عضو', req.user.username, m.name);
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

app.get('/api/applications', auth, (req, res) => { res.json(dbQuery("SELECT * FROM applications ORDER BY date DESC")); });

app.put('/api/applications/:id', auth, (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  const a = dbGet("SELECT name FROM applications WHERE id=?", [req.params.id]);
  dbRun("UPDATE applications SET status=?, reviewed_at=datetime('now') WHERE id=?", [status, req.params.id]);
  if (a) logAction(status === 'accepted' ? 'قبول تقديم' : 'رفض تقديم', req.user.username, a.name);
  if (status !== 'pending' && a) {
    const ap = dbGet("SELECT discord_tag FROM applications WHERE id=?", [req.params.id]);
    if (ap && ap.discord_tag) sendDiscordDM(ap.discord_tag, status === 'accepted' ? '✅ تم قبول تقديمك!' : '❌ تم رفض تقديمك.');
    const wh = getSetting('webhook_applications');
    if (wh) sendWebhook(wh, { content: (status === 'accepted' ? '✅ **تقديم مقبول**' : '❌ **تقديم مرفوض**') + '\nالاسم: ' + a.name });
  }
  res.json({ success: true });
});

app.delete('/api/applications/:id', auth, (req, res) => {
  dbRun("DELETE FROM applications WHERE id=?", [req.params.id]);
  logAction('حذف تقديم', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── WARNINGS ─── */
app.post('/api/warnings', auth, async (req, res) => {
  const { member_id, reason, type } = req.body;
  if (!member_id || !reason) return res.status(400).json({ error: 'بيانات ناقصة' });
  const m = dbGet("SELECT name, discord_tag FROM members WHERE id=?", [member_id]);
  const typeLabel = type === 'final' ? 'نهائي' : type === 'written' ? 'كتابي' : 'شفهي';
  dbRun("INSERT INTO warnings (member_id, reason, type) VALUES (?,?,?)", [member_id, reason, type || 'written']);
  if (m) logAction('تحذير عضو', req.user.username, m.name + ': ' + reason);
  if (m && m.discord_tag) sendDiscordDM(m.discord_tag, '⚠️ **تحذير جديد**\nالنوع: ' + typeLabel + '\nالسبب: ' + reason);
  const warns = dbQuery("SELECT COUNT(*) as c FROM warnings WHERE member_id=?", [member_id]);
  if ((warns[0]?.c || 0) >= 3) {
    dbRun("UPDATE members SET role='GUEST' WHERE id=?", [member_id]);
    if (m) sendDiscordDM(m.discord_tag, '📉 تم تخفيض رتبتك إلى GUEST بسبب كثرة التحذيرات (3+)');
    logAction('تخفيض رتبة تلقائي', 'system', m.name + ' - 3+ تحذيرات');
  }
  res.json({ success: true });
});

app.get('/api/warnings', auth, (req, res) => { res.json(dbQuery("SELECT w.*, m.name as member_name FROM warnings w LEFT JOIN members m ON w.member_id=m.id ORDER BY w.date DESC")); });
app.delete('/api/warnings/:id', auth, (req, res) => {
  dbRun("DELETE FROM warnings WHERE id=?", [req.params.id]);
  logAction('حذف تحذير', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── LEAVES ─── */
app.post('/api/leaves', auth, (req, res) => {
  const { member_id, reason, start_date, end_date } = req.body;
  if (!member_id || !start_date || !end_date) return res.status(400).json({ error: 'بيانات ناقصة' });
  dbRun("INSERT INTO leaves (member_id, reason, start_date, end_date) VALUES (?,?,?,?)", [member_id, reason || '', start_date, end_date]);
  const m = dbGet("SELECT name FROM members WHERE id=?", [member_id]);
  if (m) logAction('طلب إجازة', req.user.username, m.name + ' ' + start_date + ' → ' + end_date);
  res.json({ success: true });
});

app.get('/api/leaves', auth, (req, res) => {
  res.json(dbQuery("SELECT l.*, m.name as member_name, m.discord_tag FROM leaves l JOIN members m ON l.member_id=m.id ORDER BY l.date DESC"));
});

app.put('/api/leaves/:id', auth, (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  const l = dbGet("SELECT * FROM leaves WHERE id=?", [req.params.id]);
  dbRun("UPDATE leaves SET status=? WHERE id=?", [status, req.params.id]);
  if (l) {
    const m = dbGet("SELECT name, discord_tag FROM members WHERE id=?", [l.member_id]);
    const statusMsg = status === 'approved' ? '✅ تم قبول إجازتك' : '❌ تم رفض إجازتك';
    if (m && m.discord_tag) sendDiscordDM(m.discord_tag, statusMsg + '\nمن: ' + l.start_date + '\nإلى: ' + l.end_date + (l.reason ? '\nالسبب: ' + l.reason : ''));
    logAction(status === 'approved' ? 'قبول إجازة' : 'رفض إجازة', req.user.username, (m ? m.name : '') + ' ' + l.start_date + ' → ' + l.end_date);
  }
  res.json({ success: true });
});

app.delete('/api/leaves/:id', auth, (req, res) => {
  dbRun("DELETE FROM leaves WHERE id=?", [req.params.id]);
  logAction('حذف إجازة', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── TICKETS ─── */
app.post('/api/tickets', auth, (req, res) => {
  const { member_name, discord_id, discord_tag, subject } = req.body;
  if (!subject) return res.status(400).json({ error: 'أدخل الموضوع' });
  dbRun("INSERT INTO tickets (member_name, discord_id, discord_tag, subject, status) VALUES (?,?,?,?,?)", [member_name || 'غير معروف', discord_id || '', discord_tag || '', subject, 'open']);
  logAction('تذكرة جديدة', req.user.username, subject);
  res.json({ success: true });
});

app.get('/api/tickets', auth, (req, res) => { res.json(dbQuery("SELECT * FROM tickets ORDER BY created_at DESC")); });

app.put('/api/tickets/:id', auth, async (req, res) => {
  const { status, admin_reply } = req.body;
  if (status && !['open', 'closed', 'in_progress'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  const t = dbGet("SELECT * FROM tickets WHERE id=?", [req.params.id]);
  if (status) dbRun("UPDATE tickets SET status=?, admin_reply=?, closed_at=CASE WHEN ?='closed' THEN datetime('now') ELSE closed_at END WHERE id=?", [status, admin_reply || '', status, req.params.id]);
  else if (admin_reply) dbRun("UPDATE tickets SET admin_reply=? WHERE id=?", [admin_reply, req.params.id]);
  if (t && t.discord_tag) {
    if (status === 'closed') sendDiscordDM(t.discord_tag, '🔒 تم إغلاق تذكرتك: ' + t.subject + (admin_reply ? '\nرد الإدارة: ' + admin_reply : ''));
    else if (admin_reply) sendDiscordDM(t.discord_tag, '📩 رد من الإدارة على تذكرتك: ' + t.subject + '\n' + admin_reply);
    else if (status) sendDiscordDM(t.discord_tag, '📋 حالة تذكرتك: ' + (status === 'in_progress' ? 'قيد المعالجة' : 'مفتوحة'));
  }
  logAction('تحديث تذكرة', req.user.username, (t ? t.subject : '') + ' → ' + (status || 'رد'));
  res.json({ success: true });
});

app.delete('/api/tickets/:id', auth, (req, res) => {
  dbRun("DELETE FROM tickets WHERE id=?", [req.params.id]);
  logAction('حذف تذكرة', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── RATINGS ─── */
app.get('/api/ratings', auth, (req, res) => {
  res.json(dbQuery("SELECT r.*, m.name as member_name FROM ratings r LEFT JOIN members m ON r.member_id=m.id ORDER BY r.date DESC"));
});

app.get('/api/ratings/:memberId', auth, (req, res) => {
  res.json(dbQuery("SELECT r.*, m.name as member_name FROM ratings r LEFT JOIN members m ON r.member_id=m.id WHERE r.member_id=? ORDER BY r.date DESC", [req.params.memberId]));
});

app.delete('/api/ratings/:id', auth, (req, res) => {
  if (req.user.role !== 'OWNER') return res.status(403).json({ error: 'فقط المالك يستطيع حذف التقييمات' });
  dbRun("DELETE FROM ratings WHERE id=?", [req.params.id]);
  logAction('حذف تقييم', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── ANNOUNCEMENTS ─── */
app.post('/api/announcements', auth, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'أدخل العنوان والمحتوى' });
  dbRun("INSERT INTO announcements (title, content, by_user) VALUES (?,?,?)", [title, content, req.user.username]);
  logAction('إضافة إعلان', req.user.username, title);
  res.json({ success: true });
});

app.get('/api/announcements', auth, (req, res) => { res.json(dbQuery("SELECT * FROM announcements ORDER BY created_at DESC")); });

app.delete('/api/announcements/:id', auth, (req, res) => {
  dbRun("DELETE FROM announcements WHERE id=?", [req.params.id]);
  logAction('حذف إعلان', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* ─── STATS ADVANCED ─── */
app.get('/api/stats/advanced', auth, (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const active7 = dbQuery("SELECT m.name, COUNT(*) as cnt FROM logs l JOIN members m ON l.detail LIKE '%' || m.name || '%' WHERE l.date >= ? GROUP BY m.id ORDER BY cnt DESC LIMIT 5", [weekAgo]);
  const topWarned = dbQuery("SELECT m.name, COUNT(*) as cnt FROM warnings w JOIN members m ON w.member_id=m.id WHERE w.date >= ? GROUP BY w.member_id ORDER BY cnt DESC LIMIT 5", [weekAgo]);
  const appsByDay = dbQuery("SELECT date(date) as d, COUNT(*) as c FROM applications WHERE date >= ? GROUP BY d ORDER BY d", [weekAgo]);
  const warnsByDay = dbQuery("SELECT date(date) as d, COUNT(*) as c FROM warnings WHERE date >= ? GROUP BY d ORDER BY d", [weekAgo]);
  const totalPoints = dbGet("SELECT SUM(points) as total FROM members");
  const avgPoints = dbGet("SELECT AVG(points) as avg FROM members");
  const topMembers = dbQuery("SELECT name, points, role FROM members ORDER BY points DESC LIMIT 5");
  res.json({ active7, topWarned, appsByDay, warnsByDay, totalPoints: totalPoints?.total || 0, avgPoints: Math.round(avgPoints?.avg || 0), topMembers });
});

/* ─── LOGS ─── */
app.get('/api/logs', auth, (req, res) => { res.json(dbQuery("SELECT * FROM logs ORDER BY date DESC LIMIT 200")); });

/* ─── SETTINGS ─── */
app.get('/api/settings', auth, (req, res) => {
  const rows = dbQuery("SELECT * FROM settings");
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json({ settings });
});
app.put('/api/settings', auth, (req, res) => {
  if (!req.body.key) return res.status(400).json({ error: 'مفتاح مطلوب' });
  dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", [req.body.key, req.body.value]);
  logAction('تغيير إعداد', req.user.username, req.body.key);
  if (req.body.key === 'bot_token' && req.body.value && !botClient) {
    console.log('Bot token updated. Restart server to start the bot.');
  }
  res.json({ success: true });
});
app.get('/api/bot-status', auth, (req, res) => {
  const token = getSetting('bot_token');
  const guildId = getSetting('guild_id');
  res.json({
    online: !!botClient && botClient.isReady(),
    hasToken: !!token,
    tokenLength: token ? token.length : 0,
    hasGuild: !!guildId,
    botTag: botClient && botClient.isReady() ? botClient.user.tag : null,
    settingsChecked: { token, guildId }
  });
});

/* ─── BACKUP ─── */
app.get('/api/backups', auth, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
    res.json({ backups: files.map(f => ({ name: f, size: (fs.statSync(path.join(BACKUP_DIR, f)).size / 1024).toFixed(1) + ' KB', date: f.replace('backup-', '').replace('.db', '') })) });
  } catch { res.json({ backups: [] }); }
});

app.get('/api/backups/:file', auth, (req, res) => {
  const file = req.params.file;
  if (!file.endsWith('.db') || file.includes('..')) return res.status(400).json({ error: 'ملف غير صالح' });
  const fp = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'غير موجود' });
  res.download(fp);
});

/* ─── SERVE ─── */
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

/* ─── INIT ─── */
(async () => {
  const SQL = await initSqlJs();
  console.log('Database path:', DB_PATH);
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('Database loaded from file');
  } else {
    db = new SQL.Database();
    console.log('New database created');
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, display_name TEXT, role TEXT DEFAULT 'ADMIN', discord_tag TEXT);
    CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT DEFAULT 'MEMBER', points INTEGER DEFAULT 0, notes TEXT DEFAULT '', discord_tag TEXT, member_code TEXT DEFAULT '', created_at DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, discord_tag TEXT, message TEXT, status TEXT DEFAULT 'pending', date DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, reason TEXT, type TEXT, date DATETIME DEFAULT (datetime('now')), FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, by TEXT, detail TEXT, date DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS points_log (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, points_change INTEGER, reason TEXT, by_user TEXT, date DATETIME DEFAULT (datetime('now')), FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS leaves (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, reason TEXT, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'pending', date DATETIME DEFAULT (datetime('now')), reviewed_at TEXT, FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, member_name TEXT, discord_id TEXT, discord_tag TEXT, subject TEXT, status TEXT DEFAULT 'open', admin_reply TEXT, created_at DATETIME DEFAULT (datetime('now')), closed_at TEXT);
    CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, rated_by_id INTEGER, rated_by_discord TEXT, rated_by_name TEXT, rating INTEGER, reason TEXT, date TEXT, FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, by_user TEXT, created_at DATETIME DEFAULT (datetime('now')));
  `);
  // Migrate missing columns
  const cols = db.exec("PRAGMA table_info(members)")[0]?.values.map(v => v[1]) || [];
  if (!cols.includes('discord_tag')) db.run("ALTER TABLE members ADD COLUMN discord_tag TEXT");
  if (!cols.includes('member_code')) db.run("ALTER TABLE members ADD COLUMN member_code TEXT DEFAULT ''");
  if (!cols.includes('created_at')) db.run("ALTER TABLE members ADD COLUMN created_at DATETIME DEFAULT (datetime('now'))");
  saveDB();
  await seedAdmin();
  await initBot();
  app.listen(PORT, '0.0.0.0', () => { console.log('🛡️ Admin Panel: http://localhost:' + PORT); });
})();
