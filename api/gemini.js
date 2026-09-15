/**
 * PresuVoz — Backend Serverless (Vercel)
 * Proxy seguro entre el simulador web y Google Gemini API.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Metodo no permitido. Usa POST.' });
  }

  const { userPrompt, systemInstruction } = req.body || {};
  if (!userPrompt || typeof userPrompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'Falta el campo "userPrompt" en el body.' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Servidor no configurado: falta GEMINI_API_KEY en Vercel.' });
  }

  const modelsToTry = [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.1-flash-preview',
    'gemini-3.1-pro-preview'
  ];

  let lastError = 'Sin respuesta';

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          systemInstruction: { parts: [{ text: systemInstruction || '' }] },
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        })
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
