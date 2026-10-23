/**
 * PresuVoz — Backend Serverless (Vercel)
 * Proxy seguro entre el simulador web y Google Gemini API.
 */

const proxyRequestWindows = new Map();

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const host = String(req.headers.host || '').toLowerCase();
  const allowedOrigins = (process.env.PRESUVOZ_ALLOWED_ORIGINS || 'https://albmarmar6.github.io')
    .split(',').map(value => value.trim()).filter(Boolean);
  let originAllowed = allowedOrigins.includes(origin);
  try { originAllowed ||= Boolean(origin) && new URL(origin).host.toLowerCase() === host; } catch (_) {}
  if (originAllowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return originAllowed ? res.status(200).end() : res.status(403).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Metodo no permitido. Usa POST.' });
  }

  // No exponer una clave facturable a un endpoint público sin autenticación de usuario.
  if (process.env.GEMINI_PROXY_ENABLED !== 'true') {
    return res.status(503).json({ ok: false, error: 'El proxy público de IA está desactivado. Usa el bot de WhatsApp configurado.' });
  }

  const forwardedFor = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const previousWindow = proxyRequestWindows.get(forwardedFor);
  if (!previousWindow || now - previousWindow.startedAt >= 60_000) {
    proxyRequestWindows.set(forwardedFor, { startedAt: now, count: 1 });
  } else {
    previousWindow.count += 1;
    if (previousWindow.count > 12) return res.status(429).json({ ok: false, error: 'Has alcanzado el límite temporal de solicitudes.' });
  }

  const { userPrompt, systemInstruction } = req.body || {};
  if (!userPrompt || typeof userPrompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'Falta el campo "userPrompt" en el body.' });
  }
  if (userPrompt.length > 40000 || String(systemInstruction || '').length > 12000) {
    return res.status(413).json({ ok: false, error: 'La solicitud supera el tamaño permitido.' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Servidor no configurado: falta GEMINI_API_KEY en Vercel.' });
  }

  const modelsToTry = [...new Set([
    process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    'gemini-3.5-flash-lite'
  ])];

  let lastError = 'Sin respuesta';

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          systemInstruction: { parts: [{ text: systemInstruction || '' }] },
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        }),
        signal: AbortSignal.timeout(18000)
      });

      const data = await geminiRes.json().catch(() => ({}));

      if (!geminiRes.ok) {
        const errMsg = data.error?.message || `Error HTTP ${geminiRes.status}`;
        if (geminiRes.status === 401 || geminiRes.status === 403) {
          return res.status(503).json({ ok: false, error: 'Clave GEMINI_API_KEY invalida en Vercel: ' + errMsg });
        }
        lastError = errMsg;
        continue;
      }

      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) { lastError = 'Respuesta vacia de Gemini'; continue; }

      const result = JSON.parse(jsonText);
      return res.status(200).json({ ok: true, result, model });

    } catch (e) {
      lastError = e.message;
    }
  }

  return res.status(503).json({ ok: false, error: 'No se pudo conectar con Gemini: ' + lastError });
}
