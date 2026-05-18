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
const DB_PATH = path.join(__dirname, 'data.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
const SECRET = process.env.JWT_SECRET || 'admin-secret-key-2026';

app.use(express.json());
app.use(express.static(__dirname));

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

let db;
let botClient = null;
let botGuildId = null;

function saveDB() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch {}
}

function dbRun(q, p = []) { db.run(q, p); saveDB(); }

function dbGet(q, p = []) {
  const r = db.exec(q, p);
  if (!r.length || !r[0].values.length) return null;
  const o = {};
  r[0].columns.forEach((c, i) => o[c] = r[0].values[0][i]);
  return o;
}

function dbQuery(q, p = []) {
  const r = db.exec(q, p);
  if (!r.length || !r[0].values.length) return [];
  return r[0].values.map(v => {
    const o = {};
    r[0].columns.forEach((c, i) => o[c] = v[i]);
    return o;
  });
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
  let msg = `ًں“ٹ **طھظ‚ط±ظٹط± ظٹظˆظ…ظٹ - ${today}**\n`;
  msg += `â”œ ط§ظ„ظ†ط´ط§ط·ط§طھ: ${l.length}\n`;
  msg += `â”œ ط§ظ„طھظ‚ط¯ظٹظ…ط§طھ: ${a.length}\n`;
  msg += `â”œ ط§ظ„طھط­ط°ظٹط±ط§طھ: ${w.length}\n`;
  if (m.length) msg += `\nًںڈ† **ط§ظ„ظ…طھطµط¯ط±ظˆظ†:**\n` + m.map((x, i) => `${['ًں¥‡','ًں¥ˆ','ًں¥‰'][i]} ${x.name}: ${x.points} ظ†ظ‚ط·ط©`).join('\n');
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
  let msg = `ًں“ˆ **طھظ‚ط±ظٹط± ط£ط³ط¨ظˆط¹ظٹ**\n`;
  msg += `â”œ ط§ظ„ظ†ط´ط§ط·ط§طھ: ${l[0]?.c || 0}\n`;
  msg += `â”œ ط§ظ„طھظ‚ط¯ظٹظ…ط§طھ: ${a[0]?.c || 0} (âœ…${ac[0]?.c||0} â‌Œ${rc[0]?.c||0})\n`;
  msg += `â”œ ط§ظ„طھط­ط°ظٹط±ط§طھ: ${w[0]?.c || 0}\n`;
  if (topW.length) msg += `\nâڑ ï¸ڈ **ط§ظ„ط£ظƒط«ط± طھط­ط°ظٹط±ط§طھ:**\n` + topW.map((x, i) => `${i+1}. ${x.name}: ${x.cnt}`).join('\n');
  await sendToChannel('report_channel', msg);
}

async function initBot() {
  const token = getSetting('bot_token');
  if (!token) return;
  botGuildId = getSetting('guild_id');
  try {
    const { Client, GatewayIntentBits } = require('discord.js');
    botClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    botClient.on('clientReady', () => console.log('Admin Bot online:', botClient.user.tag));

    botClient.on('guildMemberAdd', async member => {
      if (member.guild.id !== botGuildId) return;
      if (getSetting('welcome_enabled') === 'false') return;
      const welcomeMsg = getSetting('welcome_message') || `ظ…ط±ط­ط¨ط§ظ‹ ${member.user.displayName} ظپظٹ ط§ظ„ط³ظٹط±ظپط±! ًںژ‰\n\nًں“Œ **ط§ظ„ط±طھط¨ ط§ظ„ظ…طھط§ط­ط©:**\nًں‘‘ OWNER - ًں‘‘ ط§ظ„ظ…ط§ظ„ظƒ\nًں›،ï¸ڈ ADMIN - ط¥ط¯ط§ط±ظٹ\nâڑ، MODERATOR - ظ…ط´ط±ظپ\nâ­گ VIP - ظ…ظ…ظٹط²\nًں‘¤ MEMBER - ط¹ط¶ظˆ\n\nطھط¹ط±ظ‘ظپ ط¹ظ„ظ‰ ط§ظ„ظ‚ظˆط§ظ†ظٹظ† ظˆط§ط³طھظ…طھط¹!`;
      try { await member.send(welcomeMsg); } catch {}
    });

    const ticketChannels = {};

    const ratingLabels = { 1: 'ط¶ط¹ظٹظپ', 2: 'ظ…ظ‚ط¨ظˆظ„', 3: 'ط¬ظٹط¯', 4: 'ط¬ظٹط¯ ط¬ط¯ط§ظ‹', 5: 'ظ…ظ…طھط§ط²' };
    const ratingWords = ['ط¶ط¹ظٹظپ', 'ظ…ظ‚ط¨ظˆظ„', 'ط¬ظٹط¯', 'ظ…ظ…طھط§ط²', 'ط±ط§ط¦ط¹'];
    const rateRegex = /(?:ظ‚ظٹظ‘ظ…|ظ‚ظٹظ…|rate)\s*(?:<@!?(\d+)>)?\s*(ط¶ط¹ظٹظپ|ظ…ظ‚ط¨ظˆظ„|ط¬ظٹط¯ ط¬ط¯ط§ظ‹|ظ…ظ…طھط§ط²|ط±ط§ط¦ط¹|1|2|3|4|5)/i;
    const mentionRegex = /<@!?(\d+)>/;

    function parseRatingWord(word) {
      const map = { 'ط¶ط¹ظٹظپ': 1, 'ظ…ظ‚ط¨ظˆظ„': 2, 'ط¬ظٹط¯': 3, 'ط¬ظٹط¯ ط¬ط¯ط§ظ‹': 4, 'ظ…ظ…طھط§ط²': 5, 'ط±ط§ط¦ط¹': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
      return map[word] || null;
    }

    botClient.on('messageCreate', async msg => {
      if (msg.author.bot) return;
      const content = msg.content || '';
      if (!content) return;

      const rateMatch = content.match(rateRegex);
      if (rateMatch) {
        const ratedId = rateMatch[1];
        const ratingValue = parseRatingWord(rateMatch[2]);
        
        if (ratingValue) {
          let targetDiscordId = ratedId;
          if (!targetDiscordId) {
            const m = content.match(mentionRegex);
            if (m) targetDiscordId = m[1];
          }
          
          let memberName = 'ط؛ظٹط± ظ…ط¹ط±ظˆظپ';
          let memberId = 0;
          
          if (targetDiscordId) {
            const member = dbQuery("SELECT id, name FROM members WHERE discord_tag=? OR discord_id=?", [msg.author.tag, targetDiscordId]);
            if (member.length) {
              memberId = member[0].id;
              memberName = member[0].name;
            }
          }
          
          const admin = dbQuery("SELECT id, username, display_name FROM users WHERE discord_tag=? OR discord_id=?", [msg.author.tag, msg.author.id]);
          const raterId = admin.length ? admin[0].id : 0;
          const raterName = admin.length ? admin[0].display_name : msg.author.displayName;
          
          dbRun("INSERT INTO ratings (member_id, rated_by_id, rated_by_discord, rated_by_name, rating, reason, date) VALUES (?,?,?,?,?,?,?)",
            [memberId, raterId, msg.author.tag, raterName, ratingValue, ratingLabels[ratingValue], new Date().toISOString()]);
          logAction('طھظ‚ظٹظٹظ… ط¹ط¶ظˆ', raterName, memberName + ' - ' + ratingLabels[ratingValue]);
          msg.reply('âœ… طھظ… طھط³ط¬ظٹظ„ ط§ظ„طھظ‚ظٹظٹظ…: **' + ratingLabels[ratingValue] + '**');
          return;
        }
      }

      if (content.startsWith('!ط§ط¬ط§ط²ط©')) {
        const parts = content.slice('!ط§ط¬ط§ط²ط©'.length).trim().split('\n').map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) {
          msg.reply('âڑ ï¸ڈ ط§ظ„ط§ط³طھط®ط¯ط§ظ…:\n`!ط§ط¬ط§ط²ط©`\n`ط§ظ„ط³ط¨ط¨`\n`طھط§ط±ظٹط® ط§ظ„ط¨ط¯ط§ظٹط© YYYY-MM-DD`\n`طھط§ط±ظٹط® ط§ظ„ظ†ظ‡ط§ظٹط© YYYY-MM-DD`');
          return;
        }
        const [reason, start, end] = parts;
        if (!start || !end || start > end) { msg.reply('âڑ ï¸ڈ طھظˆط§ط±ظٹط® ط؛ظٹط± طµط§ظ„ط­ط©'); return; }
        const member = dbGet("SELECT id FROM members WHERE discord_tag=?", [msg.author.tag]);
        if (!member) { msg.reply('âڑ ï¸ڈ ط¹ط¶ظˆ ط؛ظٹط± ظ…ط³ط¬ظ„ ظپظٹ ط§ظ„ظ†ط¸ط§ظ…'); return; }
        dbRun("INSERT INTO leaves (member_id, reason, start_date, end_date) VALUES (?,?,?,?)", [member.id, reason, start, end]);
        msg.reply('âœ… طھظ… ط§ط³طھظ„ط§ظ… ط·ظ„ط¨ ط§ظ„ط¥ط¬ط§ط²ط© ظˆط³ظٹطھظ… ظ…ط±ط§ط¬ط¹طھظ‡.');
        const wh = getSetting('webhook_applications');
        if (wh) sendWebhook(wh, { content: `ًںڈ–ï¸ڈ **ط·ظ„ط¨ ط¥ط¬ط§ط²ط©**\nط§ظ„ط¹ط¶ظˆ: ${msg.author.displayName}\nط§ظ„ط³ط¨ط¨: ${reason}\nظ…ظ†: ${start} ط¥ظ„ظ‰: ${end}` });
        return;
      }

      if (content === '!طھظ‚ط¯ظٹظ…' || content === '!apply') {
        if (getSetting('applications_open') === 'false') { msg.reply('âڑ ï¸ڈ ط¨ط§ط¨ ط§ظ„طھظ‚ط¯ظٹظ… ظ…ط؛ظ„ظ‚ ط­ط§ظ„ظٹط§ظ‹'); return; }
        const existing = dbQuery("SELECT id FROM applications WHERE discord_tag=? AND status='pending' LIMIT 1", [msg.author.tag]);
        if (existing.length) { msg.reply('âڑ ï¸ڈ ظ„ط¯ظٹظƒ طھظ‚ط¯ظٹظ… ظ‚ظٹط¯ ط§ظ„ظ…ط±ط§ط¬ط¹ط©'); return; }
        dbRun("INSERT INTO applications (name, discord_tag, message, status) VALUES (?,?,?,?)", [msg.author.displayName, msg.author.tag, 'طھظ‚ط¯ظٹظ… ط¹ط¨ط± ط§ظ„ط¨ظˆطھ', 'pending']);
        msg.reply('âœ… طھظ… ط§ط³طھظ„ط§ظ… طھظ‚ط¯ظٹظ…ظƒ!');
        const wh = getSetting('webhook_applications');
        if (wh) sendWebhook(wh, { content: `ًں“© **طھظ‚ط¯ظٹظ… ط¬ط¯ظٹط¯ ط¹ط¨ط± ط§ظ„ط¨ظˆطھ**\n${msg.author.displayName} (${msg.author.tag})` });
        return;
      }

      if (content === '!leaderboard' || content === '!ط§ظ„ظ…طھطµط¯ط±ظٹظ†') {
        const top = dbQuery("SELECT name, points, role FROM members ORDER BY points DESC LIMIT 10");
        if (!top.length) { msg.reply('ظ„ط§ ظٹظˆط¬ط¯ ط£ط¹ط¶ط§ط،'); return; }
        let msgText = `ًںڈ† **ظ‚ط§ط¦ظ…ط© ط§ظ„ظ…طھطµط¯ط±ظٹظ†**\n\n`;
        top.forEach((m, i) => {
          const medal = i === 0 ? 'ًں¥‡' : i === 1 ? 'ًں¥ˆ' : i === 2 ? 'ًں¥‰' : `${i+1}.`;
          msgText += `${medal} **${m.name}** - ${m.points} ظ†ظ‚ط·ط©\n`;
        });
        msg.reply(msgText);
        await sendToChannel('leaderboard_channel', msgText);
        return;
      }

      if (content === '!طھط°ظƒط±ط©' || content === '!ticket') {
        const existing = dbQuery("SELECT id FROM tickets WHERE discord_id=? AND status='open' LIMIT 1", [msg.author.id]);
        if (existing.length) { msg.reply('âڑ ï¸ڈ ظ„ط¯ظٹظƒ طھط°ظƒط±ط© ظ…ظپطھظˆط­ط© ط¨ط§ظ„ظپط¹ظ„'); return; }
        dbRun("INSERT INTO tickets (member_name, discord_id, discord_tag, subject, status) VALUES (?,?,?,?,?)", [msg.author.displayName, msg.author.id, msg.author.tag, 'طھط°ظƒط±ط© ط¯ط¹ظ…', 'open']);
        msg.reply('âœ… طھظ… ظپطھط­ طھط°ظƒط±ط© ط¯ط¹ظ…طŒ ط³ظٹطھظ… ط§ظ„ط±ط¯ ط¹ظ„ظٹظƒ ظ‚ط±ظٹط¨ط§ظ‹.');
        return;
      }

      if (content.startsWith('!طھط°ظƒط±ط© ') || content.startsWith('!ticket ')) {
        const subject = content.slice(content.indexOf(' ') + 1).trim();
        if (!subject) { msg.reply('âڑ ï¸ڈ ط£ط¯ط®ظ„ ظ…ظˆط¶ظˆط¹ ط§ظ„طھط°ظƒط±ط©'); return; }
        const existing = dbQuery("SELECT id FROM tickets WHERE discord_id=? AND status='open' LIMIT 1", [msg.author.id]);
        if (existing.length) { msg.reply('âڑ ï¸ڈ ظ„ط¯ظٹظƒ طھط°ظƒط±ط© ظ…ظپطھظˆط­ط© ط¨ط§ظ„ظپط¹ظ„'); return; }
        dbRun("INSERT INTO tickets (member_name, discord_id, discord_tag, subject, status) VALUES (?,?,?,?,?)", [msg.author.displayName, msg.author.id, msg.author.tag, subject, 'open']);
        msg.reply('âœ… طھظ… ظپطھط­ طھط°ظƒط±ط©: ' + subject);
        return;
      }

      if (msg.channel.type === 1 && ticketChannels[msg.channelId]) {
        logAction('ط±ط¯ ط¹ظ„ظ‰ طھط°ظƒط±ط©', 'bot', msg.author.tag + ': ' + content.slice(0, 50));
      }
    });

    await botClient.login(token);

    cron.schedule('0 21 * * *', sendDailyReport);
    cron.schedule('0 21 * * 5', sendWeeklyReport);
    cron.schedule('0 */6 * * *', autoBackup);
  } catch (e) { console.error('Bot login fail:', e.message); botClient = null; }
}

async function seedAdmin() {
  const exists = dbGet("SELECT id FROM users WHERE username='admin'");
  if (!exists) {
    const hash = await bcrypt.hash('admin123', 10);
    dbRun("INSERT INTO users (username, password, display_name, role) VALUES (?,?,?,?)", ['admin', hash, 'ط§ظ„ظ…ط¯ظٹط±', 'OWNER']);
    console.log('Default admin created: admin / admin123');
  }
}

/* â”€â”€â”€ AUTH â”€â”€â”€ */
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'ط؛ظٹط± ظ…طµط±ط­' });
  try {
    req.user = jwt.verify(h.slice(7), SECRET);
    const user = dbGet("SELECT * FROM users WHERE id=?", [req.user.id]);
    if (!user) return res.status(401).json({ error: 'ظ…ط³طھط®ط¯ظ… ط؛ظٹط± ظ…ظˆط¬ظˆط¯' });
    req.user.role = user.role;
    req.user.dbUser = user;
    next();
  } catch { res.status(401).json({ error: 'طھظˆظƒظ† ط؛ظٹط± طµط§ظ„ط­' }); }
}

function requireRole(minRole) {
  const hierarchy = { 'OWNER': 0, 'ADMIN': 1, 'MODERATOR': 2, 'VIP': 3, 'MEMBER': 4, 'GUEST': 5 };
  return (req, res, next) => {
    const userLevel = hierarchy[req.user.role] ?? 99;
    const requiredLevel = hierarchy[minRole] ?? 99;
    if (userLevel > requiredLevel) return res.status(403).json({ error: 'ط؛ظٹط± ظ…طµط±ط­ - طھط­طھط§ط¬ ط±طھط¨ط© ' + minRole });
    next();
  };
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ط£ط¯ط®ظ„ ط¨ظٹط§ظ†ط§طھ ط§ظ„ط¯ط®ظˆظ„' });
  const user = dbGet("SELECT * FROM users WHERE username=?", [username]);
  if (!user) return res.status(401).json({ error: 'ط¨ظٹط§ظ†ط§طھ ط®ط§ط·ط¦ط©' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'ط¨ظٹط§ظ†ط§طھ ط®ط§ط·ط¦ط©' });
  const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, SECRET, { expiresIn: '7d' });
  logAction('طھط³ط¬ظٹظ„ ط¯ط®ظˆظ„', username, 'ظ…ظ† ظ„ظˆط­ط© ط§ظ„ط¥ط¯ط§ط±ط©');
  res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
});

app.get('/api/me', auth, (req, res) => {
  const user = dbGet("SELECT id, username, display_name, role FROM users WHERE id=?", [req.user.id]);
  if (!user) return res.status(404).json({ error: 'ظ…ط³طھط®ط¯ظ… ط؛ظٹط± ظ…ظˆط¬ظˆط¯' });
  res.json(user);
});

app.post('/api/users', auth, requireRole('OWNER'), async (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: 'ط­ظ‚ظˆظ„ ظ†ط§ظ‚طµط©' });
  const exists = dbGet("SELECT id FROM users WHERE username=?", [username]);
  if (exists) return res.status(400).json({ error: 'ط§ط³ظ… ط§ظ„ظ…ط³طھط®ط¯ظ… ظ…ظˆط¬ظˆط¯' });
  const hash = await bcrypt.hash(password, 10);
  dbRun("INSERT INTO users (username, password, display_name, role) VALUES (?,?,?,?)", [username, hash, display_name, role || 'ADMIN']);
  logAction('ط¥ط¶ط§ظپط© ظ…ط³طھط®ط¯ظ…', req.user.username, display_name);
  res.json({ success: true });
});

app.get('/api/users', auth, (req, res) => { res.json(dbQuery("SELECT id, username, display_name, role FROM users")); });
app.delete('/api/users/:id', auth, requireRole('OWNER'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'ظ„ط§ طھط­ط°ظپ ظ†ظپط³ظƒ' });
  dbRun("DELETE FROM users WHERE id=?", [req.params.id]);
  res.json({ success: true });
});

/* â”€â”€â”€ MEMBERS â”€â”€â”€ */
app.post('/api/members', auth, async (req, res) => {
  const { name, role, discord_tag } = req.body;
  if (!name) return res.status(400).json({ error: 'ط£ط¯ط®ظ„ ط§ظ„ط§ط³ظ…' });
  dbRun("INSERT INTO members (name, role, discord_tag) VALUES (?,?,?)", [name, role || 'MEMBER', discord_tag || '']);
  logAction('ط¥ط¶ط§ظپط© ط¹ط¶ظˆ', req.user.username, name);
  if (botClient && discord_tag && getSetting('welcome_enabled') !== 'false') {
    sendDiscordDM(discord_tag, `ًںژ‰ ظ…ط±ط­ط¨ط§ظ‹ ${name}! طھظ… ط¥ط¶ط§ظپطھظƒ ظپظٹ ظ„ظˆط­ط© ط§ظ„ط¥ط¯ط§ط±ط©.`);
  }
  res.json({ success: true });
});

app.get('/api/members', auth, (req, res) => { res.json(dbQuery("SELECT * FROM members ORDER BY points DESC, name")); });

app.put('/api/members/:id/points', auth, async (req, res) => {
  const { reason } = req.body;
  const m = dbGet("SELECT name, discord_tag, points FROM members WHERE id=?", [req.params.id]);
  const pts = parseInt(req.body.points) || 0;
  dbRun("UPDATE members SET points = points + ? WHERE id=?", [pts, req.params.id]);
  dbRun("INSERT INTO points_log (member_id, points_change, reason, by_user) VALUES (?,?,?,?)", [req.params.id, pts, reason || (pts > 0 ? 'ط¥ط¶ط§ظپط© ظ†ظ‚ط§ط·' : 'ط®طµظ… ظ†ظ‚ط§ط·'), req.user.username]);
  logAction('طھط­ط¯ظٹط« ظ†ظ‚ط§ط·', req.user.username, 'ID:' + req.params.id + ' ' + (pts > 0 ? '+' : '') + pts);
  if (m && m.discord_tag) {
    const newPoints = (m.points || 0) + pts;
    if (pts < 0) {
      sendDiscordDM(m.discord_tag, 'ًں”» **طھظ… ط®طµظ… ظ†ظ‚ط§ط·**\nط§ظ„ط¹ط¶ظˆ: ' + m.name + '\nط§ظ„ط®طµظ…: ' + Math.abs(pts) + ' ظ†ظ‚ط·ط©\nط§ظ„ط³ط¨ط¨: ' + (reason || 'â€”') + '\nط±طµظٹط¯ظƒ ط§ظ„ط­ط§ظ„ظٹ: ' + newPoints + ' ظ†ظ‚ط·ط©');
    } else {
      sendDiscordDM(m.discord_tag, 'ًں”؛ **طھظ…طھ ط¥ط¶ط§ظپط© ظ†ظ‚ط§ط·**\nط§ظ„ط¹ط¶ظˆ: ' + m.name + '\nط§ظ„ظ†ظ‚ط§ط·: +' + pts + '\nط§ظ„ط³ط¨ط¨: ' + (reason || 'â€”') + '\nط±طµظٹط¯ظƒ ط§ظ„ط­ط§ظ„ظٹ: ' + newPoints + ' ظ†ظ‚ط·ط©');
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
  logAction('طھط؛ظٹظٹط± ط±طھط¨ط©', req.user.username, 'ID:' + req.params.id + ' â†’ ' + req.body.role);
  if (m && m.discord_tag) sendDiscordDM(m.discord_tag, 'ًںژ–ï¸ڈ **طھظ… طھط؛ظٹظٹط± ط±طھط¨طھظƒ**\nط§ظ„ط±طھط¨ط© ط§ظ„ط¬ط¯ظٹط¯ط©: ' + req.body.role);
  res.json({ success: true });
});

app.delete('/api/members/:id', auth, (req, res) => {
  const m = dbGet("SELECT name FROM members WHERE id=?", [req.params.id]);
  dbRun("DELETE FROM members WHERE id=?", [req.params.id]);
  if (m) logAction('ط­ط°ظپ ط¹ط¶ظˆ', req.user.username, m.name);
  res.json({ success: true });
});

/* â”€â”€â”€ APPLICATIONS â”€â”€â”€ */
app.post('/api/applications', auth, (req, res) => {
  const { name, discord_tag, message } = req.body;
  if (!name) return res.status(400).json({ error: 'ط£ط¯ط®ظ„ ط§ظ„ط§ط³ظ…' });
  dbRun("INSERT INTO applications (name, discord_tag, message) VALUES (?,?,?)", [name, discord_tag || '', message || '']);
  logAction('طھظ‚ط¯ظٹظ… ط¬ط¯ظٹط¯', req.user.username, name);
  res.json({ success: true });
});

app.get('/api/applications', auth, (req, res) => { res.json(dbQuery("SELECT * FROM applications ORDER BY date DESC")); });

app.put('/api/applications/:id', auth, (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'ط­ط§ظ„ط© ط؛ظٹط± طµط§ظ„ط­ط©' });
  const a = dbGet("SELECT name FROM applications WHERE id=?", [req.params.id]);
  dbRun("UPDATE applications SET status=?, reviewed_at=datetime('now') WHERE id=?", [status, req.params.id]);
  if (a) logAction(status === 'accepted' ? 'ظ‚ط¨ظˆظ„ طھظ‚ط¯ظٹظ…' : 'ط±ظپط¶ طھظ‚ط¯ظٹظ…', req.user.username, a.name);
  if (status !== 'pending' && a) {
    const ap = dbGet("SELECT discord_tag FROM applications WHERE id=?", [req.params.id]);
    if (ap && ap.discord_tag) sendDiscordDM(ap.discord_tag, status === 'accepted' ? 'âœ… طھظ… ظ‚ط¨ظˆظ„ طھظ‚ط¯ظٹظ…ظƒ!' : 'â‌Œ طھظ… ط±ظپط¶ طھظ‚ط¯ظٹظ…ظƒ.');
    const wh = getSetting('webhook_applications');
    if (wh) sendWebhook(wh, { content: (status === 'accepted' ? 'âœ… **طھظ‚ط¯ظٹظ… ظ…ظ‚ط¨ظˆظ„**' : 'â‌Œ **طھظ‚ط¯ظٹظ… ظ…ط±ظپظˆط¶**') + '\nط§ظ„ط§ط³ظ…: ' + a.name });
  }
  res.json({ success: true });
});

app.delete('/api/applications/:id', auth, (req, res) => {
  dbRun("DELETE FROM applications WHERE id=?", [req.params.id]);
  logAction('ط­ط°ظپ طھظ‚ط¯ظٹظ…', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* â”€â”€â”€ WARNINGS â”€â”€â”€ */
app.post('/api/warnings', auth, async (req, res) => {
  const { member_id, reason, type } = req.body;
  if (!member_id || !reason) return res.status(400).json({ error: 'ط¨ظٹط§ظ†ط§طھ ظ†ط§ظ‚طµط©' });
  const m = dbGet("SELECT name, discord_tag FROM members WHERE id=?", [member_id]);
  const typeLabel = type === 'final' ? 'ظ†ظ‡ط§ط¦ظٹ' : type === 'written' ? 'ظƒطھط§ط¨ظٹ' : 'ط´ظپظ‡ظٹ';
  dbRun("INSERT INTO warnings (member_id, reason, type) VALUES (?,?,?)", [member_id, reason, type || 'written']);
  if (m) logAction('طھط­ط°ظٹط± ط¹ط¶ظˆ', req.user.username, m.name + ': ' + reason);
  if (m && m.discord_tag) sendDiscordDM(m.discord_tag, 'âڑ ï¸ڈ **طھط­ط°ظٹط± ط¬ط¯ظٹط¯**\nط§ظ„ظ†ظˆط¹: ' + typeLabel + '\nط§ظ„ط³ط¨ط¨: ' + reason);
  const warns = dbQuery("SELECT COUNT(*) as c FROM warnings WHERE member_id=?", [member_id]);
  if ((warns[0]?.c || 0) >= 3) {
    dbRun("UPDATE members SET role='GUEST' WHERE id=?", [member_id]);
    if (m) sendDiscordDM(m.discord_tag, 'ًں“‰ طھظ… طھط®ظپظٹط¶ ط±طھط¨طھظƒ ط¥ظ„ظ‰ GUEST ط¨ط³ط¨ط¨ ظƒط«ط±ط© ط§ظ„طھط­ط°ظٹط±ط§طھ (3+)');
    logAction('طھط®ظپظٹط¶ ط±طھط¨ط© طھظ„ظ‚ط§ط¦ظٹ', 'system', m.name + ' - 3+ طھط­ط°ظٹط±ط§طھ');
  }
  res.json({ success: true });
});

app.get('/api/warnings', auth, (req, res) => { res.json(dbQuery("SELECT w.*, m.name as member_name FROM warnings w LEFT JOIN members m ON w.member_id=m.id ORDER BY w.date DESC")); });
app.delete('/api/warnings/:id', auth, (req, res) => {
  dbRun("DELETE FROM warnings WHERE id=?", [req.params.id]);
  logAction('ط­ط°ظپ طھط­ط°ظٹط±', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* â”€â”€â”€ LEAVES â”€â”€â”€ */
app.post('/api/leaves', auth, (req, res) => {
  const { member_id, reason, start_date, end_date } = req.body;
  if (!member_id || !start_date || !end_date) return res.status(400).json({ error: 'ط¨ظٹط§ظ†ط§طھ ظ†ط§ظ‚طµط©' });
  dbRun("INSERT INTO leaves (member_id, reason, start_date, end_date) VALUES (?,?,?,?)", [member_id, reason || '', start_date, end_date]);
  const m = dbGet("SELECT name FROM members WHERE id=?", [member_id]);
  if (m) logAction('ط·ظ„ط¨ ط¥ط¬ط§ط²ط©', req.user.username, m.name + ' ' + start_date + ' â†’ ' + end_date);
  res.json({ success: true });
});

app.get('/api/leaves', auth, (req, res) => {
  res.json(dbQuery("SELECT l.*, m.name as member_name, m.discord_tag FROM leaves l JOIN members m ON l.member_id=m.id ORDER BY l.date DESC"));
});

app.put('/api/leaves/:id', auth, (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'ط­ط§ظ„ط© ط؛ظٹط± طµط§ظ„ط­ط©' });
  const l = dbGet("SELECT * FROM leaves WHERE id=?", [req.params.id]);
  dbRun("UPDATE leaves SET status=? WHERE id=?", [status, req.params.id]);
  if (l) {
    const m = dbGet("SELECT name, discord_tag FROM members WHERE id=?", [l.member_id]);
    const statusMsg = status === 'approved' ? 'âœ… طھظ… ظ‚ط¨ظˆظ„ ط¥ط¬ط§ط²طھظƒ' : 'â‌Œ طھظ… ط±ظپط¶ ط¥ط¬ط§ط²طھظƒ';
    if (m && m.discord_tag) sendDiscordDM(m.discord_tag, statusMsg + '\nظ…ظ†: ' + l.start_date + '\nط¥ظ„ظ‰: ' + l.end_date + (l.reason ? '\nط§ظ„ط³ط¨ط¨: ' + l.reason : ''));
    logAction(status === 'approved' ? 'ظ‚ط¨ظˆظ„ ط¥ط¬ط§ط²ط©' : 'ط±ظپط¶ ط¥ط¬ط§ط²ط©', req.user.username, (m ? m.name : '') + ' ' + l.start_date + ' â†’ ' + l.end_date);
  }
  res.json({ success: true });
});

app.delete('/api/leaves/:id', auth, (req, res) => {
  dbRun("DELETE FROM leaves WHERE id=?", [req.params.id]);
  logAction('ط­ط°ظپ ط¥ط¬ط§ط²ط©', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* â”€â”€â”€ TICKETS â”€â”€â”€ */
app.post('/api/tickets', auth, (req, res) => {
  const { member_name, discord_id, discord_tag, subject } = req.body;
  if (!subject) return res.status(400).json({ error: 'ط£ط¯ط®ظ„ ط§ظ„ظ…ظˆط¶ظˆط¹' });
  dbRun("INSERT INTO tickets (member_name, discord_id, discord_tag, subject, status) VALUES (?,?,?,?,?)", [member_name || 'ط؛ظٹط± ظ…ط¹ط±ظˆظپ', discord_id || '', discord_tag || '', subject, 'open']);
  logAction('طھط°ظƒط±ط© ط¬ط¯ظٹط¯ط©', req.user.username, subject);
  res.json({ success: true });
});

app.get('/api/tickets', auth, (req, res) => { res.json(dbQuery("SELECT * FROM tickets ORDER BY created_at DESC")); });

app.put('/api/tickets/:id', auth, (req, res) => {
  const { status, admin_reply } = req.body;
  if (status && !['open', 'closed', 'in_progress'].includes(status)) return res.status(400).json({ error: 'ط­ط§ظ„ط© ط؛ظٹط± طµط§ظ„ط­ط©' });
  const t = dbGet("SELECT * FROM tickets WHERE id=?", [req.params.id]);
  if (status) dbRun("UPDATE tickets SET status=?, admin_reply=?, closed_at=CASE WHEN ?='closed' THEN datetime('now') ELSE closed_at END WHERE id=?", [status, admin_reply || '', status, req.params.id]);
  else if (admin_reply) dbRun("UPDATE tickets SET admin_reply=? WHERE id=?", [admin_reply, req.params.id]);
  if (t && t.discord_tag) {
    if (status === 'closed') sendDiscordDM(t.discord_tag, 'ًں”’ طھظ… ط¥ط؛ظ„ط§ظ‚ طھط°ظƒط±طھظƒ: ' + t.subject + (admin_reply ? '\nط±ط¯ ط§ظ„ط¥ط¯ط§ط±ط©: ' + admin_reply : ''));
    else if (admin_reply) sendDiscordDM(t.discord_tag, 'ًں“© ط±ط¯ ظ…ظ† ط§ظ„ط¥ط¯ط§ط±ط© ط¹ظ„ظ‰ طھط°ظƒط±طھظƒ: ' + t.subject + '\n' + admin_reply);
    else if (status) sendDiscordDM(t.discord_tag, 'ًں“‹ ط­ط§ظ„ط© طھط°ظƒط±طھظƒ: ' + (status === 'in_progress' ? 'ظ‚ظٹط¯ ط§ظ„ظ…ط¹ط§ظ„ط¬ط©' : 'ظ…ظپطھظˆط­ط©'));
  }
  logAction('طھط­ط¯ظٹط« طھط°ظƒط±ط©', req.user.username, (t ? t.subject : '') + ' â†’ ' + (status || 'ط±ط¯'));
  res.json({ success: true });
});

app.delete('/api/tickets/:id', auth, (req, res) => {
  dbRun("DELETE FROM tickets WHERE id=?", [req.params.id]);
  logAction('ط­ط°ظپ طھط°ظƒط±ط©', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* â”€â”€â”€ RATINGS â”€â”€â”€ */
app.get('/api/ratings', auth, (req, res) => {
  res.json(dbQuery("SELECT r.*, m.name as member_name FROM ratings r LEFT JOIN members m ON r.member_id=m.id ORDER BY r.date DESC"));
});

app.get('/api/ratings/:memberId', auth, (req, res) => {
  res.json(dbQuery("SELECT r.*, m.name as member_name FROM ratings r LEFT JOIN members m ON r.member_id=m.id WHERE r.member_id=? ORDER BY r.date DESC", [req.params.memberId]));
});

app.get('/api/ratings/average/:memberId', auth, (req, res) => {
  const avg = dbGet("SELECT AVG(rating) as avg, COUNT(*) as count FROM ratings WHERE member_id=?", [req.params.memberId]);
  res.json({ average: Math.round((avg?.avg || 0) * 10) / 10, count: avg?.count || 0 });
});

app.delete('/api/ratings/:id', auth, (req, res) => {
  if (req.user.role !== 'OWNER') return res.status(403).json({ error: 'ظپظ‚ط· ط§ظ„ظ…ط§ظ„ظƒ ظٹط³طھط·ظٹط¹ ط­ط°ظپ ط§ظ„طھظ‚ظٹظٹظ…ط§طھ' });
  dbRun("DELETE FROM ratings WHERE id=?", [req.params.id]);
  logAction('ط­ط°ظپ طھظ‚ظٹظٹظ…', req.user.username, 'ID: ' + req.params.id);
  res.json({ success: true });
});

/* â”€â”€â”€ STATS ADVANCED â”€â”€â”€ */
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

/* â”€â”€â”€ LOGS â”€â”€â”€ */
app.get('/api/logs', auth, (req, res) => { res.json(dbQuery("SELECT * FROM logs ORDER BY date DESC LIMIT 200")); });

/* â”€â”€â”€ SETTINGS â”€â”€â”€ */
app.get('/api/settings', auth, (req, res) => {
  const rows = dbQuery("SELECT * FROM settings");
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json({ settings });
});
app.put('/api/settings', auth, (req, res) => {
  if (!req.body.key) return res.status(400).json({ error: 'ظ…ظپطھط§ط­ ظ…ط·ظ„ظˆط¨' });
  dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", [req.body.key, req.body.value]);
  logAction('طھط؛ظٹظٹط± ط¥ط¹ط¯ط§ط¯', req.user.username, req.body.key);
  res.json({ success: true });
});

/* â”€â”€â”€ BACKUP â”€â”€â”€ */
app.get('/api/backups', auth, (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
    res.json({ backups: files.map(f => ({ name: f, size: (fs.statSync(path.join(BACKUP_DIR, f)).size / 1024).toFixed(1) + ' KB', date: f.replace('backup-', '').replace('.db', '') })) });
  } catch { res.json({ backups: [] }); }
});

app.get('/api/backups/:file', auth, (req, res) => {
  const file = req.params.file;
  if (!file.endsWith('.db') || file.includes('..')) return res.status(400).json({ error: 'ظ…ظ„ظپ ط؛ظٹط± طµط§ظ„ط­' });
  const fp = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'ط؛ظٹط± ظ…ظˆط¬ظˆط¯' });
  res.download(fp);
});

/* â”€â”€â”€ SERVE â”€â”€â”€ */
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

/* â”€â”€â”€ INIT â”€â”€â”€ */
(async () => {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, display_name TEXT, role TEXT DEFAULT 'ADMIN', discord_tag TEXT);
    CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, role TEXT DEFAULT 'MEMBER', points INTEGER DEFAULT 0, notes TEXT DEFAULT '', discord_tag TEXT, created_at DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, discord_tag TEXT, message TEXT, status TEXT DEFAULT 'pending', date DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, reason TEXT, type TEXT, date DATETIME DEFAULT (datetime('now')), FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, by TEXT, detail TEXT, date DATETIME DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS points_log (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, points_change INTEGER, reason TEXT, by_user TEXT, date DATETIME DEFAULT (datetime('now')), FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS leaves (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, reason TEXT, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'pending', date DATETIME DEFAULT (datetime('now')), reviewed_at TEXT, FOREIGN KEY(member_id) REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, member_name TEXT, discord_id TEXT, discord_tag TEXT, subject TEXT, status TEXT DEFAULT 'open', admin_reply TEXT, created_at DATETIME DEFAULT (datetime('now')), closed_at TEXT);
    CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, rated_by_id INTEGER, rated_by_discord TEXT, rated_by_name TEXT, rating INTEGER, reason TEXT, date TEXT, FOREIGN KEY(member_id) REFERENCES members(id));
  `);
  saveDB();
  await seedAdmin();
  await initBot();
  app.listen(PORT, '0.0.0.0', () => { console.log('ًں›،ï¸ڈ Admin Panel: http://localhost:' + PORT); });
})();
