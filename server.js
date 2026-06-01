const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── 5 Gemini keys — fallback chain (tries next if quota hit) ─────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3,
  process.env.GEMINI_KEY_4,
  process.env.GEMINI_KEY_5,
].filter(Boolean); // removes any undefined keys

const GEMINI_MODEL = 'gemini-1.5-flash';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';

if (GEMINI_KEYS.length === 0) {
  console.error('❌ No Gemini API keys found. Set GEMINI_KEY_1 through GEMINI_KEY_5 in Railway variables.');
  process.exit(1);
}

console.log(`✅ Loaded ${GEMINI_KEYS.length} Gemini API key(s).`);

// ── Call Gemini with one specific key ────────────────────────────────────────
async function callGemini(apiKey, systemPrompt, messages) {
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Convert message history to Gemini format
  const contents = messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: Array.isArray(msg.parts) ? msg.parts[0].text : msg.parts }],
  }));

  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents,
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 300,
      topP: 0.95,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  // Quota / rate limit errors — signal caller to try next key
  if (res.status === 429 || res.status === 503 || data?.error?.code === 429) {
    const err = new Error('QUOTA_EXCEEDED');
    err.quota = true;
    throw err;
  }

  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text.trim();
}

// ── Fallback chain — tries each key in order until one works ─────────────────
async function callGeminiWithFallback(systemPrompt, messages) {
  let lastError = null;

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try {
      console.log(`🔑 Trying Gemini key ${i + 1}...`);
      const reply = await callGemini(GEMINI_KEYS[i], systemPrompt, messages);
      console.log(`✅ Key ${i + 1} succeeded.`);
      return reply;
    } catch (err) {
      lastError = err;
      if (err.quota) {
        console.warn(`⚠️  Key ${i + 1} quota exceeded, trying next...`);
        continue; // try next key
      }
      // Non-quota error — don't bother trying other keys, just throw
      throw err;
    }
  }

  // All keys exhausted
  throw new Error(`All ${GEMINI_KEYS.length} Gemini keys hit quota. Try again later.`);
}

// ── POST /chat ────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { messages, systemPrompt, relationship } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: true, reply: 'No messages provided.' });
    }

    if (!systemPrompt) {
      return res.status(400).json({ error: true, reply: 'No systemPrompt provided.' });
    }

    console.log(`📨 /chat called | mode: ${relationship || 'unknown'} | messages: ${messages.length}`);

    const reply = await callGeminiWithFallback(systemPrompt, messages);
    return res.json({ reply });

  } catch (err) {
    console.error('❌ /chat error:', err.message);
    return res.status(500).json({
      error: true,
      reply: err.message.includes('quota')
        ? 'All API keys are busy right now. Try again in a minute.'
        : 'Something went wrong. Try again.',
    });
  }
});

// ── GET / — health check ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    keys_loaded: GEMINI_KEYS.length,
    model: GEMINI_MODEL,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Ping self every 14 minutes to prevent Render free tier from sleeping
  setInterval(async () => {
    try {
      await fetch(`${SERVER_URL}/`);
      console.log('🏓 Self-ping OK — server staying awake');
    } catch (err) {
      console.warn('⚠️ Self-ping failed:', err.message);
    }
  }, 14 * 60 * 1000); // 14 minutes
});
