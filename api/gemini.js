/**
 * PresuVoz — Backend Serverless (Vercel)
 * Proxy seguro entre el simulador web y Google Gemini API.
 * La clave de Gemini vive en process.env.GEMINI_API_KEY y nunca se expone al cliente.
 *
 * Endpoint: POST /api/gemini
 * Body: { userPrompt: string, systemInstruction: string }
 * Response: { ok: true, result: object, model: string }
 */

export default async function handler(req, res) {
  // CORS — permite llamadas desde GitHub Pages y cualquier origen (demo pública)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido. Usa POST.' });
  }

  const { userPrompt, systemInstruction } = req.body || {};
  if (!userPrompt || typeof userPrompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'Falta el campo "userPrompt" en el body.' });
  }
  if (!systemInstruction || typeof systemInstruction !== 'string') {
    return res.status(400).json({ ok: false, error: 'Falta el campo "systemInstruction" en el body.' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.error('PresuVoz Backend: GEMINI_API_KEY no configurada en Vercel.');
    return res.status(503).json({ ok: false, error: 'Servidor no configurado. Contacta con el administrador.' });
  }

  const modelsToTry = [
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-preview',
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite'
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
          systemInstruction: { parts: [{ text: systemInstruction }] },
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
          return res.status(503).json({ ok: false, error: 'Error de autenticación con Gemini. Revisa la variable GEMINI_API_KEY en Vercel.' });
        }
        const suggestedMatch = errMsg.match(/use\s+models\/([\w.-]+)/);
        if (suggestedMatch && !modelsToTry.includes(suggestedMatch[1])) {
          modelsToTry.push(suggestedMatch[1]);
        }
        console.warn(`PresuVoz Backend: Modelo "${model}" no disponible: ${errMsg.substring(0, 100)}`);
        lastError = errMsg;
        continue;
      }

      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) { lastError = 'Respuesta vacía de Gemini'; continue; }

      const result = JSON.parse(jsonText);
      console.log(`PresuVoz Backend: Respuesta generada con modelo: ${model}`);
      return res.status(200).json({ ok: true, result, model });

    } catch (e) {
      console.warn(`PresuVoz Backend: Error con modelo "${model}": ${e.message}`);
      lastError = e.message;
    }
  }

  return res.status(503).json({ ok: false, error: 'No se pudo conectar con Gemini. Intenta de nuevo en unos segundos.' });
}
