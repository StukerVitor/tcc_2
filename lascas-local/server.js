import http from 'node:http';
import https from 'node:https';
import express from 'express';
import axios from 'axios';
import cors from 'cors';

import { extractTextFromPdfBuffer } from './src/pdf.js';
import { simplifyBlocks } from './src/simplifier.js';
import { dumpExtractedPdfText } from './src/pdf_dump.js';

const PORT = process.env.PORT || 5179;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.LASCAS_MODEL || 'legal-simplifier:latest';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const api = axios.create({ baseURL: OLLAMA_URL, timeout: 50000, httpAgent, httpsAgent });

async function warmup() {
  console.log('[LASCAS][WARMUP] Warming up model…');
  try {
    await api.get('/api/tags');
  } catch (e) {
    console.warn('[LASCAS][WARMUP] tags failed:', e?.message || e);
    console.warn('[LASCAS][WARMUP] Continuing without warmup: daemon not ready');
    return;
  }
  try {
    await api.post('/api/chat', {
      model: MODEL, stream: false,
      options: { num_predict: 1 },
      messages: [{ role: 'user', content: 'ping' }]
    });
    console.log('[LASCAS][WARMUP] Model ready.');
  } catch (e) {
    console.warn('[LASCAS][WARMUP] Continuing without warmup:', e?.message || e);
  }
}

const app = express();
app.use(cors({ origin: true, credentials: false }));

// JSON endpoint (existing)
app.use(express.json({ limit: '50mb' }));

app.options('*', cors());
app.get('/health', (_req, res) => res.json({ ok: true }));

// -----------------------------
// NEW: Binary PDF upload endpoint
// -----------------------------
app.post(
  '/simplify-pdf',
  express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '80mb' }),
  async (req, res) => {
    const level = String(req.query?.level || 'light');
    const redactPII = String(req.query?.redactPII || '0') === '1' || String(req.query?.redactPII || '').toLowerCase() === 'true';
    const fileName = String(req.query?.fileName || 'upload.pdf');

    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    console.log('POST /simplify-pdf', JSON.stringify({
      bytes: buf.length,
      level,
      redactPII,
      fileName
    }, null, 2));

    if (!buf || buf.length < 16) {
      return res.status(400).json({ error: 'Empty PDF body (application/pdf)' });
    }

    try {
      let inputText = await extractTextFromPdfBuffer(buf);

      const saved = await dumpExtractedPdfText(inputText, { source: fileName });
      if (saved) console.log('[LASCAS][PDF_DUMP] Saved:', saved);

      console.log('[LASCAS][API] Extracted text length:', inputText.length);

      const start = Date.now();
      const out = await simplifyBlocks(inputText, level || 'light', { redactPII: Boolean(redactPII) });
      const ms = Date.now() - start;

      return res.json({
        blocks: out.blocks || [],
        meta: { ...(out.meta || {}), ms }
      });
    } catch (e) {
      console.error('[LASCAS][API] Error in /simplify-pdf:', e?.stack || e?.message || e);
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }
);

// -----------------------------
// Existing JSON endpoint (kept)
// -----------------------------
app.post('/simplify', async (req, res) => {
  const { hasHtml, html, hasPdf, pdfUrl, pdfBase64, fileName, level, redactPII } = req.body || {};
  const hasUrl = Boolean(pdfUrl);
  const hasBase64 = Boolean(pdfBase64);

  console.log('POST /simplify', JSON.stringify({
    hasHtml,
    hasPdf,
    level,
    redactPII: Boolean(redactPII),
    hasBase64,
    hasUrl,
    fileName: fileName || undefined
  }, null, 2));

  try {
    let inputText = '';

    if (hasPdf) {
      if (hasBase64 && typeof pdfBase64 === 'string' && pdfBase64.trim()) {
        const base64 = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
        const buf = Buffer.from(base64, 'base64');

        inputText = await extractTextFromPdfBuffer(buf);

        const saved = await dumpExtractedPdfText(inputText, {
          source: fileName || 'upload_base64.pdf'
        });
        if (saved) console.log('[LASCAS][PDF_DUMP] Saved:', saved);
      } else if (hasUrl && typeof pdfUrl === 'string') {
        const { data } = await axios.get(pdfUrl, {
          responseType: 'arraybuffer',
          timeout: 60000,
          httpAgent,
          httpsAgent
        });

        inputText = await extractTextFromPdfBuffer(Buffer.from(data));

        const saved = await dumpExtractedPdfText(inputText, { source: pdfUrl });
        if (saved) console.log('[LASCAS][PDF_DUMP] Saved:', saved);
      } else {
        return res.status(400).json({ error: 'hasPdf=true but neither pdfBase64 nor pdfUrl provided' });
      }
    } else if (hasHtml && typeof html === 'string') {
      inputText = String(html || '');
    } else {
      return res.status(400).json({ error: 'No input detected (use hasPdf/pdfUrl/pdfBase64 or hasHtml/html)' });
    }

    console.log('[LASCAS][API] Received text length:', inputText.length);

    const start = Date.now();
    const out = await simplifyBlocks(inputText, level || 'light', { redactPII: Boolean(redactPII) });
    const ms = Date.now() - start;

    return res.json({
      blocks: out.blocks || [],
      meta: { ...(out.meta || {}), ms }
    });
  } catch (e) {
    console.error('[LASCAS][API] Error:', e?.stack || e?.message || e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`LASCAS local API on http://localhost:${server.address().port}`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

setTimeout(() => warmup().catch(() => {}), 10);
