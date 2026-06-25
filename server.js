require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '4mb' }));

// ─── GOOGLE OAUTH2 (Gmail) ────────────────────────────────────────────────────
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/callback`;

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
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
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
      <p>Add to your Railway environment variables:</p>
      <pre>GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || '(use existing token)'}</pre>
      <p style="color:#ff6600;margin-top:20px">Close this tab and redeploy Railway.</p>
    </body></html>`);
  } catch (err) {
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

// ─── API: STATUS ──────────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'online',
    gmail: !!process.env.GOOGLE_REFRESH_TOKEN,
    weather: !!process.env.OPENWEATHER_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ─── API: WEATHER ─────────────────────────────────────────────────────────────
app.get('/api/weather', async (req, res) => {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENWEATHER_API_KEY not set' });
  try {
    const lat  = process.env.WEATHER_LAT  || '18.8990';
    const lon  = process.env.WEATHER_LON  || '81.3478';
    const city = process.env.WEATHER_CITY || 'Dantewada';
    const { data } = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`
    );
    res.json({
      city: data.name || city,
      temp: Math.round(data.main.temp),
      feels_like: Math.round(data.main.feels_like),
      temp_min: Math.round(data.main.temp_min),
      temp_max: Math.round(data.main.temp_max),
      condition: data.weather[0].main,
      description: data.weather[0].description,
      humidity: data.main.humidity,
      wind_speed: Math.round(data.wind.speed * 3.6),
      icon: data.weather[0].icon,
      visibility: Math.round((data.visibility || 10000) / 1000),
    });
  } catch (err) {
    console.error('[Weather]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: EMAILS ──────────────────────────────────────────────────────────────
app.get('/api/emails', async (req, res) => {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(503).json({
      error: 'Gmail not connected. Visit /auth/google',
      emails: [], count: 0,
    });
  }
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const listRes = await gmail.users.messages.list({
      userId: 'me', q: 'is:unread', maxResults: 15,
    });
    const messages = listRes.data.messages || [];
    const count    = listRes.data.resultSizeEstimate || messages.length;
    const emails   = await Promise.all(
      messages.slice(0, 8).map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        });
        const h   = detail.data.payload.headers;
        const get = (name) => h.find((x) => x.name === name)?.value || '';
        return {
          id: msg.id,
          subject: get('Subject') || '(no subject)',
          from: get('From'),
          date: get('Date'),
          snippet: detail.data.snippet || '',
        };
      })
    );
    res.json({ count, emails });
  } catch (err) {
    console.error('[Gmail]', err.message);
    res.status(500).json({ error: err.message, emails: [], count: 0 });
  }
});

// ─── API: ASK GEMINI ──────────────────────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      response: "The Gemini AI module is offline, Sir. Please set your GEMINI_API_KEY in Railway's environment variables.",
    });
  }

  const { query, weatherCtx, emailCtx, history = [] } = req.body;
  if (!query || !query.trim()) {
    return res.status(400).json({ response: "I didn't catch that, Sir. Could you repeat?" });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);

    // Build IST timestamp
    const ist = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const systemInstruction = `You are J.A.R.V.I.S. — Just A Rather Very Intelligent System — the personal AI assistant to Jayant Nahata, IAS Officer and District Collector of Dantewada, Chhattisgarh, India.

PERSONALITY & TONE:
- Calm, precise, highly intelligent — modelled on the AI from Iron Man
- British-accented phrasing: "Indeed, Sir", "Certainly, Sir", "I'm afraid I cannot confirm that, Sir"
- Always address the user as "Sir"
- Concise: answer in 1–3 sentences unless asked for detail
- Never sycophantic — no hollow praise, only substance
- Confident but never arrogant

CURRENT SYSTEM STATE:
- Date/Time (IST): ${ist}
${weatherCtx ? `- Dantewada weather: ${weatherCtx}` : '- Weather: sensor data unavailable'}
${emailCtx  ? `- Inbox status: ${emailCtx}`          : '- Gmail: not connected'}

RESPONSE RULES:
- For mathematical/factual questions: answer directly with precision
- For governance/policy/scheme questions: answer from your knowledge of Indian administration
- For questions about live news or real-time data: say you don't have live internet access, provide what you know from training
- For tasks outside scope (controlling devices, opening apps): say "That function isn't available in this configuration, Sir"
- Do NOT use markdown formatting — plain prose only, since your words will be read aloud
- Keep sentences short and speakable`;

    // Build Gemini chat history from prior turns
    const chatHistory = history.slice(-6).flatMap(h => ([
      { role: 'user',  parts: [{ text: h.query    }] },
      { role: 'model', parts: [{ text: h.response }] },
    ]));

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction,
    });

    const chat   = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(query);
    const text   = result.response.text().trim();

    res.json({ response: text });
  } catch (err) {
    console.error('[Gemini]', err.message);
    const safe = err.message.includes('API_KEY_INVALID')
      ? 'The Gemini API key appears to be invalid, Sir. Please check your Railway environment variables.'
      : `I encountered a processing error, Sir. ${err.message.slice(0, 120)}`;
    res.status(500).json({ response: safe });
  }
});

// ─── CATCH-ALL ────────────────────────────────────────────────────────────────
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => {
  console.log(`\n⚡ J.A.R.V.I.S. ONLINE — http://localhost:${PORT}`);
  console.log(`   Gmail:  ${process.env.GOOGLE_REFRESH_TOKEN  ? '✅ Connected'   : '❌ Visit /auth/google'}`);
  console.log(`   Weather:${process.env.OPENWEATHER_API_KEY    ? '✅ Configured'  : '❌ Set OPENWEATHER_API_KEY'}`);
  console.log(`   Gemini: ${process.env.GEMINI_API_KEY         ? '✅ Configured'  : '❌ Set GEMINI_API_KEY'}\n`);
});
