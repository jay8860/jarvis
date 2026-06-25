require('dotenv').config();
const express  = require('express');
const { google } = require('googleapis');
const axios    = require('axios');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '4mb' }));

// ─── MEMORY FILE ─────────────────────────────────────────────────────────────
const MEMORY_FILE = path.join('/tmp', 'jarvis_memory.json');
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return { facts: [], lastSeen: null }; }
}
function saveMemory(data) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ─── SSE CLIENTS (for reminders push) ────────────────────────────────────────
const sseClients = new Map();
let reminders    = [];

function pushEvent(data) {
  sseClients.forEach(res => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  const id = Date.now();
  sseClients.set(id, res);
  req.on('close', () => sseClients.delete(id));
});

// ─── GOOGLE OAUTH2 ────────────────────────────────────────────────────────────
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
}

app.get('/auth/google', (_req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    res.send(`<!DOCTYPE html><html><head><title>JARVIS Auth</title>
      <style>body{background:#000d1a;color:#00d4ff;font-family:monospace;display:flex;
        align-items:center;justify-content:center;height:100vh;flex-direction:column}
        pre{background:#001a33;padding:20px;border:1px solid #00d4ff;border-radius:8px;
        margin-top:20px;color:#00ff88;white-space:pre-wrap;word-break:break-all}</style>
      </head><body>
      <h1>⚡ JARVIS — Gmail Connected</h1>
      <pre>GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || '(use existing)'}</pre>
      <p style="color:#ff6600;margin-top:20px">Add this to Railway Variables, then redeploy.</p>
    </body></html>`);
  } catch (err) { res.status(500).send(`Auth error: ${err.message}`); }
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'online',
    gmail:   !!process.env.GOOGLE_REFRESH_TOKEN,
    weather: !!process.env.OPENWEATHER_API_KEY,
    gemini:  !!process.env.GEMINI_API_KEY,
    calendar:!!process.env.APPLE_CALENDAR_URL,
    dashboard:!!process.env.REVIEW_DASHBOARD_API,
    timestamp: new Date().toISOString(),
  });
});

// ─── WEATHER ─────────────────────────────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENWEATHER_API_KEY not set' });
  try {
    const lat = process.env.WEATHER_LAT || '18.8990';
    const lon = process.env.WEATHER_LON || '81.3478';
    const { data } = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`
    );
    res.json({
      city: data.name || 'Dantewada',
      temp: Math.round(data.main.temp),
      feels_like: Math.round(data.main.feels_like),
      temp_min: Math.round(data.main.temp_min),
      temp_max: Math.round(data.main.temp_max),
      condition: data.weather[0].main,
      description: data.weather[0].description,
      humidity: data.main.humidity,
      wind_speed: Math.round(data.wind.speed * 3.6),
      visibility: Math.round((data.visibility || 10000) / 1000),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── EMAILS LIST ──────────────────────────────────────────────────────────────
app.get('/api/emails', async (req, res) => {
  if (!process.env.GOOGLE_REFRESH_TOKEN)
    return res.status(503).json({ error: 'Gmail not connected. Visit /auth/google', emails: [], count: 0 });
  try {
    const gmail   = google.gmail({ version: 'v1', auth: oauth2Client });
    const listRes = await gmail.users.messages.list({ userId: 'me', q: 'is:unread', maxResults: 15 });
    const messages = listRes.data.messages || [];
    const emails   = await Promise.all(
      messages.slice(0, 8).map(async msg => {
        const d = await gmail.users.messages.get({ userId:'me', id:msg.id, format:'metadata',
          metadataHeaders:['Subject','From','Date'] });
        const h = d.data.payload.headers;
        const g = n => h.find(x => x.name===n)?.value || '';
        return { id:msg.id, subject:g('Subject')||'(no subject)', from:g('From'), date:g('Date'),
          snippet:d.data.snippet||'', threadId:d.data.threadId };
      })
    );
    res.json({ count: listRes.data.resultSizeEstimate || messages.length, emails });
  } catch (err) { res.status(500).json({ error:err.message, emails:[], count:0 }); }
});

// ─── EMAIL FULL BODY ──────────────────────────────────────────────────────────
app.get('/api/emails/:id/body', async (req, res) => {
  try {
    const gmail  = google.gmail({ version:'v1', auth:oauth2Client });
    const detail = await gmail.users.messages.get({ userId:'me', id:req.params.id, format:'full' });
    let body = '';
    const payload = detail.data.payload;
    const extractText = parts => {
      for (const p of (parts || [])) {
        if (p.mimeType === 'text/plain' && p.body?.data)
          return Buffer.from(p.body.data, 'base64').toString('utf-8');
        if (p.parts) { const r = extractText(p.parts); if (r) return r; }
      }
      return '';
    };
    if (payload.body?.data) body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    else body = extractText(payload.parts);
    const h = payload.headers;
    const g = n => h.find(x => x.name===n)?.value || '';
    res.json({ id:req.params.id, subject:g('Subject'), from:g('From'), date:g('Date'),
      body: body.replace(/\r\n/g,'\n').trim().slice(0,3000),
      snippet: detail.data.snippet, threadId: detail.data.threadId });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── EMAIL DRAFT REPLY ────────────────────────────────────────────────────────
app.post('/api/emails/draft-reply', async (req, res) => {
  const { emailSubject, emailFrom, emailBody, emailSnippet, intent } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini not configured' });

  const prompt = `Draft a professional email reply on behalf of Jayant Nahata, IAS Officer, District Collector, Dantewada, Chhattisgarh.

ORIGINAL EMAIL:
From: ${emailFrom}
Subject: ${emailSubject}
Content: ${emailBody || emailSnippet}

INTENT FROM JAYANT: ${intent || 'Write an appropriate, professional reply based on the email content'}

Rules:
- Write ONLY the email body, no subject line
- Professional, concise, in English
- Sign off: "Jayant Nahata\\nDistrict Collector, Dantewada"
- No hollow phrases, be direct and substantive`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const { data } = await axios.post(url, {
      contents: [{ role:'user', parts:[{ text:prompt }] }],
      generationConfig: { temperature:0.7, maxOutputTokens:512 }
    }, { timeout:15000 });
    const draft = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    res.json({ draft, subject:`Re: ${emailSubject}`, to:emailFrom });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── EMAIL SEND REPLY ─────────────────────────────────────────────────────────
app.post('/api/emails/send-reply', async (req, res) => {
  const { emailId, to, subject, body, threadId } = req.body;
  if (!process.env.GOOGLE_REFRESH_TOKEN)
    return res.status(503).json({ error:'Gmail not connected' });
  try {
    const gmail = google.gmail({ version:'v1', auth:oauth2Client });
    const orig  = await gmail.users.messages.get({ userId:'me', id:emailId, format:'metadata',
      metadataHeaders:['Message-ID','References','In-Reply-To'] });
    const h    = orig.data.payload.headers;
    const msgId = h.find(x => x.name==='Message-ID')?.value || '';
    const refs  = h.find(x => x.name==='References')?.value || '';

    const raw = [
      `To: ${to}`, `Subject: ${subject}`,
      `In-Reply-To: ${msgId}`,
      `References: ${refs ? refs+' '+msgId : msgId}`,
      `Content-Type: text/plain; charset=utf-8`, `MIME-Version: 1.0`, ``,
      body
    ].join('\r\n');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(raw).toString('base64url'), threadId: threadId||orig.data.threadId }
    });
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ─── APPLE CALENDAR ───────────────────────────────────────────────────────────
app.get('/api/calendar', async (req, res) => {
  const calUrl = process.env.APPLE_CALENDAR_URL;
  if (!calUrl) return res.json({ events:[], note:'Set APPLE_CALENDAR_URL in Railway Variables' });
  try {
    const ical = require('node-ical');
    const httpUrl = calUrl.replace(/^webcal:\/\//i, 'https://');
    const data   = await ical.async.fromURL(httpUrl);
    const now    = new Date();
    const todayY = now.getFullYear(), todayM = now.getMonth(), todayD = now.getDate();
    const isTodayDate = d => {
      const dt = new Date(d);
      return dt.getFullYear()===todayY && dt.getMonth()===todayM && dt.getDate()===todayD;
    };
    const events = Object.values(data)
      .filter(e => e.type==='VEVENT' && e.start && isTodayDate(e.start))
      .map(e => ({
        title: e.summary || 'Meeting',
        start: new Date(e.start).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}),
        end:   e.end ? new Date(e.end).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}) : '',
        location: e.location || '',
        allDay: !e.start?.getHours && !e.start?.getMinutes,
      }))
      .sort((a,b) => a.start.localeCompare(b.start));
    res.json({ events });
  } catch (err) {
    console.error('[Calendar]', err.message);
    res.json({ events:[], error:err.message });
  }
});

// ─── NEWS RSS ─────────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    const feeds = [
      'https://news.google.com/rss/search?q=India+government+administration&hl=en-IN&gl=IN&ceid=IN:en',
      'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en',
    ];
    let headlines = [];
    for (const feed of feeds) {
      try {
        const { data } = await axios.get(feed, { timeout:8000 });
        const matches = [...data.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)].slice(1);
        if (!matches.length) {
          const m2 = [...data.matchAll(/<title>([^<]+)<\/title>/g)].slice(1);
          headlines = m2.slice(0,10).map(m => m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
        } else {
          headlines = matches.slice(0,10).map(m => m[1]);
        }
        if (headlines.length) break;
      } catch {}
    }
    res.json({ headlines });
  } catch (err) { res.json({ headlines:[], error:err.message }); }
});

// ─── REMINDERS ────────────────────────────────────────────────────────────────
app.get('/api/reminders', (_req, res) => {
  res.json(reminders.map(r => ({ id:r.id, message:r.message, fireAt:r.fireAt })));
});

app.post('/api/reminders', (req, res) => {
  const { message, delayMs } = req.body;
  if (!message || !delayMs || delayMs < 0)
    return res.status(400).json({ error:'Provide message and delayMs' });
  const id = Date.now().toString();
  const fireAt = new Date(Date.now() + delayMs).toISOString();
  const timeout = setTimeout(() => {
    pushEvent({ type:'reminder', id, message });
    reminders = reminders.filter(r => r.id !== id);
  }, delayMs);
  reminders.push({ id, message, fireAt, timeout });
  res.json({ id, message, fireAt });
});

app.delete('/api/reminders/:id', (req, res) => {
  const r = reminders.find(r => r.id===req.params.id);
  if (r) { clearTimeout(r.timeout); reminders = reminders.filter(x => x.id!==req.params.id); }
  res.json({ success:true });
});

// ─── REVIEW DASHBOARD ────────────────────────────────────────────────────────
const DASH_BASE = (process.env.REVIEW_DASHBOARD_API || 'https://reviewdashboard-production.up.railway.app').replace(/\/$/, '');
const DASH_HEADERS = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
};

// Debug endpoint — visit /api/debug-dashboard to see raw API responses
app.get('/api/debug-dashboard', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const endpoints = [
    '/stats', '/tasks/', '/tasks/?status=Pending,In_Progress',
    '/tasks/?status=Pending%2CIn_Progress', '/meetings', `/meetings?date=${today}`,
    '/departments/', '/sessions', '/planner/', '/drafts',
  ];
  const results = {};
  for (const ep of endpoints) {
    try {
      const r = await axios.get(DASH_BASE + ep, { timeout:5000, headers:DASH_HEADERS });
      results[ep] = { status:r.status, type:typeof r.data, isArray:Array.isArray(r.data),
        length:Array.isArray(r.data)?r.data.length:null,
        keys:typeof r.data==='object'?Object.keys(r.data||{}).slice(0,10):null,
        sample: JSON.stringify(r.data).slice(0,300) };
    } catch(e) { results[ep] = { error: e.message, status: e.response?.status }; }
  }
  res.json(results);
});

app.get('/api/dashboard-data', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const [statsRes, tasksRes, meetingsRes] = await Promise.allSettled([
      axios.get(`${DASH_BASE}/stats`,                              { timeout:7000, headers:DASH_HEADERS }),
      axios.get(`${DASH_BASE}/tasks/?status=Pending,In_Progress`, { timeout:7000, headers:DASH_HEADERS }),
      axios.get(`${DASH_BASE}/meetings`,                          { timeout:7000, headers:DASH_HEADERS }),
    ]);

    const stats    = statsRes.status    === 'fulfilled' ? statsRes.value.data    : null;
    const tasks    = tasksRes.status    === 'fulfilled' ? tasksRes.value.data    : null;
    const meetings = meetingsRes.status === 'fulfilled' ? meetingsRes.value.data : null;

    // Normalise various response shapes
    const toList = d => Array.isArray(d)?d:(d?.results||d?.data||d?.tasks||d?.items||[]);
    const taskList    = toList(tasks);
    const meetingList = toList(meetings);

    // Derive stats — prefer explicit stats API, fall back to task list count
    const pending = stats?.pending ?? stats?.pending_tasks ?? stats?.total_pending ?? taskList.length;
    const overdue = stats?.overdue ?? stats?.overdue_tasks ?? stats?.total_overdue ??
      taskList.filter(t=>{ const d=t.due_date||t.dueDate||t.deadline||t.due; return d&&new Date(d)<new Date(); }).length;
    const done    = stats?.completed ?? stats?.done ?? stats?.total_completed ?? stats?.total_done ?? '--';
    const mtgs    = stats?.meetings_today ?? meetingList.length;

    res.json({
      connected: true,
      data: { pending, overdue, done, meetings:mtgs,
        raw: { statsKeys:Object.keys(stats||{}), taskCount:taskList.length, meetingCount:meetingList.length,
          statsSample: JSON.stringify(stats).slice(0,200) }
      }
    });
  } catch (err) {
    console.error('[Dashboard]', err.message);
    res.json({ connected:false, note:`Dashboard error: ${err.message}` });
  }
});

// ─── MEMORY ───────────────────────────────────────────────────────────────────
app.get('/api/memory', (_req, res) => res.json(loadMemory()));

app.post('/api/memory', (req, res) => {
  const mem = loadMemory();
  if (req.body.facts) mem.facts = [...new Set([...mem.facts, ...req.body.facts])].slice(-100);
  mem.lastSeen = new Date().toISOString();
  saveMemory(mem);
  res.json({ success:true });
});

// ─── ASK GEMINI (REST, no SDK) ───────────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({
    response:"The Gemini AI module is offline, Sir. Please set your GEMINI_API_KEY in Railway's environment variables."
  });

  const { query, weatherCtx, emailCtx, history=[], memory=[], calendarCtx, dashCtx } = req.body;
  if (!query?.trim()) return res.status(400).json({ response:"I didn't catch that, Sir." });

  try {
    const ist = new Date().toLocaleString('en-IN', {
      timeZone:'Asia/Kolkata', weekday:'long', year:'numeric',
      month:'long', day:'numeric', hour:'2-digit', minute:'2-digit',
    });

    const memFacts = memory.length ? `\nKNOWN CONTEXT:\n${memory.slice(-20).join('\n')}` : '';

    const systemText = `You are J.A.R.V.I.S. — Just A Rather Very Intelligent System — personal AI to Jayant Nahata, IAS Officer and District Collector of Dantewada, Chhattisgarh, India.

PERSONALITY:
- Calm, precise, British-accented: "Indeed, Sir", "Certainly, Sir", "Quite right, Sir"
- Always address user as "Sir"
- MAXIMUM 2-3 short sentences per response — be sharp and concise
- Only expand when user explicitly says "explain in detail" or "give me more"
- Confident, witty, direct — like Tony Stark's AI

CURRENT STATE:
- Date/Time (IST): ${ist}
${weatherCtx ? `- Weather: ${weatherCtx}` : ''}
${emailCtx   ? `- Inbox: ${emailCtx}`     : ''}
${calendarCtx? `- Today's calendar: ${calendarCtx}` : ''}
${dashCtx    ? `- Review Dashboard: ${dashCtx}`     : ''}
${memFacts}

CAPABILITIES:
- Answer ANY question on ANY topic — movies, Netflix, sports, cooking, news, science, jokes — everything
- Use Google Search grounding for real-time information
- Set reminders when asked ("remind me in X minutes to...")
- Read and reply to emails intelligently
- Never refuse — always help

FORMATTING: Plain prose only, no markdown, no asterisks, no bullet points. Words are read aloud.`;

    const contents = [
      ...history.slice(-6).flatMap(h => ([
        { role:'user',  parts:[{ text:h.query    }] },
        { role:'model', parts:[{ text:h.response }] },
      ])),
      { role:'user', parts:[{ text:query }] },
    ];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const { data } = await axios.post(url, {
      system_instruction: { parts:[{ text:systemText }] },
      tools: [{ googleSearch:{} }],
      contents,
      generationConfig: { temperature:0.85, maxOutputTokens:512 },
    }, { timeout:20000 });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || "I'm afraid I received an empty response, Sir.";
    res.json({ response: text });
  } catch (err) {
    console.error('[Gemini]', err.response?.data||err.message);
    const d = err.response?.data?.error?.message || err.message;
    res.status(500).json({ response:`Processing error, Sir: ${d.slice(0,100)}` });
  }
});

// ─── CATCH-ALL ────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`\n⚡ J.A.R.V.I.S. ONLINE — http://localhost:${PORT}`);
  console.log(`   Gemini:    ${process.env.GEMINI_API_KEY?'✅':'❌ Set GEMINI_API_KEY'}`);
  console.log(`   Gmail:     ${process.env.GOOGLE_REFRESH_TOKEN?'✅':'❌ Visit /auth/google'}`);
  console.log(`   Weather:   ${process.env.OPENWEATHER_API_KEY?'✅':'❌ Set OPENWEATHER_API_KEY'}`);
  console.log(`   Calendar:  ${process.env.APPLE_CALENDAR_URL?'✅':'❌ Set APPLE_CALENDAR_URL'}`);
  console.log(`   Dashboard: ${process.env.REVIEW_DASHBOARD_API?'✅':'❌ Set REVIEW_DASHBOARD_API'}\n`);
});
