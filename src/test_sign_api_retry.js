import { createHmac } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import handler from '../api/sign.js';

function responseRecorder() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}

function makeRequest(body) {
  return { method: 'POST', headers: { origin: 'https://albmarmar6.github.io', host: 'presuvoz.vercel.app' }, query: {}, body };
}

export async function runSignApiRetryTests() {
  const previousEnv = {
    PRESUVOZ_SIGNING_SECRET: process.env.PRESUVOZ_SIGNING_SECRET,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL
  };
  const originalFetch = globalThis.fetch;
  const results = [];
  const assert = (value, message) => { results.push({ passed: Boolean(value), message }); };
  const redis = new Map();
  let failEmailOnce = true;
  let providerSendCount = 0;

  try {
    process.env.PRESUVOZ_SIGNING_SECRET = 'test-only-secret-with-more-than-32-characters';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM_EMAIL = 'PresuVoz <test@example.com>';

    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'redis.test') {
        const [command, ...encodedParts] = url.pathname.split('/').filter(Boolean);
        const key = decodeURIComponent(encodedParts[0] || '');
        if (command === 'get') {
          return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
        }
        if (command === 'set') {
          if (url.searchParams.has('NX') && redis.has(key)) {
            return new Response(JSON.stringify({ result: null }), { status: 200 });
          }
          redis.set(key, String(init.body || ''));
          return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
        }
        if (command === 'del') {
          redis.delete(key);
          return new Response(JSON.stringify({ result: 1 }), { status: 200 });
        }
      }
      if (url.hostname === 'api.resend.com') {
        providerSendCount++;
        if (failEmailOnce) {
          failEmailOnce = false;
          return new Response(JSON.stringify({ message: 'temporary delivery failure' }), { status: 503 });
        }
        return new Response(JSON.stringify({ id: 'email-retry-test-1' }), { status: 200 });
      }
      throw new Error(`Unexpected test fetch: ${url.hostname}`);
    };

    const compact = {
      i: 'PRE-RETRY-TEST-01',
      c: { n: 'Empresa de Pruebas', e: 'empresa@example.com' },
      k: { n: 'Cliente de Pruebas' },
      t: [{ d: 'Reparación de prueba', q: 1, u: 'pa', p: 100, t: 100 }],
      f: { b: 100, r: 21, a: 21, t: 121, da: 0, dp: 0, ap: 30, aa: 36.3 },
      terms: { validityDays: 15, conditions: 'Pago según presupuesto.' },
      s: 'PENDIENTE_FIRMA'
    };
    const signedPayload = deflateRawSync(Buffer.from(JSON.stringify(compact))).toString('base64url');
    const proof = createHmac('sha256', process.env.PRESUVOZ_SIGNING_SECRET).update(signedPayload).digest('base64url');
    const testSignature = `data:image/png;base64,${readFileSync(new URL('../node_modules/qrcode-terminal/example/basic.png', import.meta.url)).toString('base64')}`;
    const requestBody = {
      signedPayload, proof, signaturePro: null,
      signatureClient: testSignature,
      clientEmail: 'cliente@example.com'
    };

    const firstResponse = responseRecorder();
    await handler(makeRequest(requestBody), firstResponse);
    assert(firstResponse.statusCode === 200 && firstResponse.body?.ok && firstResponse.body?.signed && firstResponse.body?.emailSent === false,
      'Un fallo temporal de correo conserva la aceptación y la marca como pendiente');
    const firstSignedRecord = JSON.parse(redis.get('presuvoz:signed:PRE-RETRY-TEST-01') || '{}');
    assert(firstSignedRecord.signed && firstSignedRecord.emailSent === false && firstSignedRecord.signedAt,
      'El registro idempotente conserva estado pendiente y fecha original de aceptación');

    const retryResponse = responseRecorder();
    await handler(makeRequest(requestBody), retryResponse);
    assert(retryResponse.statusCode === 200 && retryResponse.body?.emailSent === true,
      'La misma petición reintenta la copia sin crear otra aceptación');
    const sentRecord = JSON.parse(redis.get('presuvoz:signed:PRE-RETRY-TEST-01') || '{}');
    assert(sentRecord.signedAt === firstSignedRecord.signedAt && sentRecord.emailSent && sentRecord.emailId === 'email-retry-test-1',
      'El reintento mantiene el instante de aceptación original y registra el ID del correo');
    assert(providerSendCount === 2, 'Se realizaron exactamente dos intentos de entrega ante un fallo transitorio');

    const duplicateResponse = responseRecorder();
    await handler(makeRequest(requestBody), duplicateResponse);
    assert(duplicateResponse.statusCode === 409 && duplicateResponse.body?.alreadySigned && duplicateResponse.body?.emailSent,
      'Una aceptación con correo enviado no puede firmarse ni enviarse de nuevo');

    const alteredResponse = responseRecorder();
    await handler(makeRequest({ ...requestBody, clientEmail: 'otro@example.com' }), alteredResponse);
    assert(alteredResponse.statusCode === 409 && alteredResponse.body?.alreadySigned,
      'Una petición con datos distintos no puede reemplazar una aceptación previa');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  for (const result of results) {
    console.log(`  [${result.passed ? 'PASS' : 'FAIL'}] ${result.message}`);
  }
  if (results.some(result => !result.passed)) throw new Error('Fallo en pruebas de reintento de firma/correo.');
  return { passed: results.length, total: results.length };
}

if (process.argv[1] && new URL(import.meta.url).pathname.toLowerCase().endsWith(process.argv[1].replaceAll('\\', '/').toLowerCase())) {
  const result = await runSignApiRetryTests();
  console.log(`TEST SIGN RETRY RESULT: ${result.passed}/${result.total}`);
}
