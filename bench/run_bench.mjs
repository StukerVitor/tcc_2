#!/usr/bin/env node
/**
 * LASCAS backend performance benchmark
 * -----------------------------------
 * Self-contained (no npm deps). Requires Node >= 16 and the LASCAS backend
 * running (./lascas.sh start). Sends the study documents to the local API,
 * records end-to-end latency + the backend's own `meta` telemetry, samples
 * GPU/RAM usage while runs execute, collects machine specs, and writes a
 * JSON report with raw runs + aggregated statistics.
 *
 * Usage:
 *   node bench/run_bench.mjs --docs /path/to/docs
 *
 * Options (defaults in parentheses):
 *   --docs <dir>         folder with the test documents: .pdf, .html or .txt (bench/docs)
 *   --api <url>          backend base URL (http://127.0.0.1:5179)
 *   --model <name>       model tag, only used for `ollama show` (legal-simplifier:latest)
 *   --reps-medium <n>    repetitions at level medium (10)
 *   --reps-light <n>     repetitions at level light  (0 = skip)
 *   --reps-strong <n>    repetitions at level strong (0 = skip)
 *   --sample-ms <n>      resource sampling interval in ms (1000)
 *   --out <dir>          output folder (bench/results)
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------- args ----------------
function argVal(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const CFG = {
  docsDir: path.resolve(argVal('docs', path.join(__dirname, 'docs'))),
  api: argVal('api', 'http://127.0.0.1:5179').replace(/\/$/, ''),
  model: argVal('model', process.env.LASCAS_MODEL || 'legal-simplifier:latest'),
  reps: {
    medium: parseInt(argVal('reps-medium', '10'), 10),
    light: parseInt(argVal('reps-light', '0'), 10),
    strong: parseInt(argVal('reps-strong', '0'), 10),
  },
  sampleMs: parseInt(argVal('sample-ms', '1000'), 10),
  outDir: path.resolve(argVal('out', path.join(__dirname, 'results'))),
};

// ---------------- small utils ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function execP(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

function stats(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const n = a.length;
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const median = n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  const sd = n > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    mean: +mean.toFixed(2),
    sd: +sd.toFixed(2),
    median: +median.toFixed(2),
    min: +a[0].toFixed(2),
    max: +a[n - 1].toFixed(2),
  };
}

// ---------------- HTTP client (no timeout: long LLM runs) ----------------
function postRaw(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getJson(urlStr) {
  return new Promise((resolve, reject) => {
    http
      .get(urlStr, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

// ---------------- resource sampler ----------------
const samples = [];
let samplerTimer = null;
let sampling = false;

async function takeSample() {
  if (sampling) return;
  sampling = true;
  const s = { t: Date.now() };
  try {
    const out = await execP('nvidia-smi', [
      '--query-gpu=memory.used,memory.total,utilization.gpu,power.draw',
      '--format=csv,noheader,nounits',
    ], 5000);
    if (out) {
      const [used, total, util, power] = out.split(',').map((x) => parseFloat(x));
      if (Number.isFinite(used)) s.vramUsedMB = used;
      if (Number.isFinite(total)) s.vramTotalMB = total;
      if (Number.isFinite(util)) s.gpuUtilPct = util;
      if (Number.isFinite(power)) s.powerW = power;
    }
  } catch { /* no GPU info */ }
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = parseInt(/MemTotal:\s+(\d+)/.exec(mi)?.[1] || '0', 10);
    const avail = parseInt(/MemAvailable:\s+(\d+)/.exec(mi)?.[1] || '0', 10);
    if (total && avail) s.ramUsedMB = Math.round((total - avail) / 1024);
  } catch { /* not linux */ }
  try {
    let rss = 0;
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        if (comm.startsWith('ollama')) {
          const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
          rss += parseInt(/VmRSS:\s+(\d+)/.exec(st)?.[1] || '0', 10);
        }
      } catch { /* proc vanished */ }
    }
    if (rss) s.ollamaRssMB = Math.round(rss / 1024);
  } catch { /* ignore */ }
  samples.push(s);
  sampling = false;
}

function startSampler() {
  samplerTimer = setInterval(takeSample, CFG.sampleMs);
}
function stopSampler() {
  if (samplerTimer) clearInterval(samplerTimer);
}

function aggregateWindow(t0, t1) {
  const w = samples.filter((s) => s.t >= t0 && s.t <= t1);
  if (!w.length) return null;
  const pick = (k) => w.map((s) => s[k]).filter(Number.isFinite);
  const agg = {};
  for (const [key, label] of [
    ['vramUsedMB', 'vramUsedMB'],
    ['gpuUtilPct', 'gpuUtilPct'],
    ['powerW', 'powerW'],
    ['ramUsedMB', 'ramUsedMB'],
    ['ollamaRssMB', 'ollamaRssMB'],
  ]) {
    const v = pick(key);
    if (v.length) {
      agg[`peak_${label}`] = Math.max(...v);
      agg[`mean_${label}`] = +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1);
    }
  }
  agg.samples = w.length;
  return agg;
}

// ---------------- machine specs ----------------
async function collectSpecs() {
  const specs = { collectedAt: new Date().toISOString() };

  const lscpu = await execP('lscpu', []);
  if (lscpu) {
    specs.cpuModel = /Model name:\s*(.+)/.exec(lscpu)?.[1]?.trim();
    specs.cpuLogical = parseInt(/^CPU\(s\):\s*(\d+)/m.exec(lscpu)?.[1] || '0', 10) || undefined;
  }
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    specs.wslRamTotalGB = +(parseInt(/MemTotal:\s+(\d+)/.exec(mi)[1], 10) / 1024 / 1024).toFixed(1);
  } catch { /* ignore */ }

  const gpu = await execP('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader']);
  if (gpu) {
    const [name, mem, drv] = gpu.split(',').map((x) => x.trim());
    specs.gpuName = name;
    specs.gpuVramTotal = mem;
    specs.gpuDriver = drv;
  }

  try {
    specs.osRelease = /PRETTY_NAME="?([^"\n]+)/.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1];
  } catch { /* ignore */ }
  specs.kernel = await execP('uname', ['-sr']);
  specs.nodeVersion = process.version;
  specs.ollamaVersion = await execP('ollama', ['-v']);
  specs.ollamaShowModel = await execP('ollama', ['show', CFG.model], 30000);

  // Windows host info via WSL interop (best effort)
  const ps = async (cmd) =>
    execP('powershell.exe', ['-NoProfile', '-Command', cmd], 25000);
  specs.hostCpu = (await ps('(Get-CimInstance Win32_Processor).Name')) || undefined;
  const hostRam = await ps('[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1)');
  specs.hostRamTotalGB = hostRam ? parseFloat(hostRam) : undefined;
  specs.hostOs = (await ps('(Get-CimInstance Win32_OperatingSystem).Caption')) || undefined;
  specs.hostModel = (await ps('(Get-CimInstance Win32_ComputerSystem).Model')) || undefined;

  return specs;
}

// ---------------- request helpers ----------------
async function simplifyPdf(filePath, level) {
  const buf = fs.readFileSync(filePath);
  const name = encodeURIComponent(path.basename(filePath));
  const t0 = Date.now();
  const res = await postRaw(
    `${CFG.api}/simplify-pdf?level=${level}&fileName=${name}`,
    buf,
    { 'Content-Type': 'application/pdf' }
  );
  const wallMs = Date.now() - t0;
  return { res, wallMs };
}

async function simplifyText(text, level) {
  const body = JSON.stringify({ hasHtml: true, html: text, level });
  const t0 = Date.now();
  const res = await postRaw(`${CFG.api}/simplify`, body, { 'Content-Type': 'application/json' });
  const wallMs = Date.now() - t0;
  return { res, wallMs };
}

function buildRunRecord(doc, level, rep, wallMs, res, windowAgg) {
  const rec = { doc: doc.name, level, rep, wallMs, httpStatus: res.status };
  try {
    const json = JSON.parse(res.body);
    if (json.error) rec.error = json.error;
    const m = json.meta || {};
    rec.meta = m;
    rec.blocksCount = Array.isArray(json.blocks) ? json.blocks.length : undefined;
    const coreMs = Number(m.ms) || null;
    rec.coreMs = coreMs;
    rec.extractAndOverheadMs = coreMs != null ? wallMs - coreMs : null;
    if (m.origWords) {
      rec.inputWordsPerSec = +(m.origWords / (wallMs / 1000)).toFixed(2);
      rec.secPer1000Words = +((wallMs / 1000) / (m.origWords / 1000)).toFixed(2);
      if (m.outWords) rec.compressionRatio = +(m.outWords / m.origWords).toFixed(3);
    }
    if (m.llmCalls) {
      rec.llmAcceptanceRate = +((m.llmAccepted || 0) / m.llmCalls).toFixed(3);
    }
    if (m.paragraphs) {
      rec.heuristicFallbackShare = +((m.llmHeuristicFallback || 0) / m.paragraphs).toFixed(3);
    }
  } catch (e) {
    rec.error = `response parse failed: ${e.message}; body head: ${String(res.body).slice(0, 200)}`;
  }
  if (windowAgg) rec.resources = windowAgg;
  return rec;
}

// ---------------- main ----------------
async function main() {
  console.log('LASCAS backend benchmark');
  console.log('  API   :', CFG.api);
  console.log('  Docs  :', CFG.docsDir);
  console.log('  Plan  :', JSON.stringify(CFG.reps));

  // docs
  if (!fs.existsSync(CFG.docsDir)) {
    console.error(`\n[fatal] Docs folder not found: ${CFG.docsDir}\nUse --docs /path/to/folder`);
    process.exit(1);
  }
  const docs = fs
    .readdirSync(CFG.docsDir)
    .filter((f) => /\.(pdf|html?|txt)$/i.test(f))
    .sort()
    .map((f) => {
      const p = path.join(CFG.docsDir, f);
      return { name: f, path: p, kind: /\.pdf$/i.test(f) ? 'pdf' : 'text', bytes: fs.statSync(p).size };
    });
  if (!docs.length) {
    console.error('[fatal] No .pdf/.html/.txt documents in docs folder.');
    process.exit(1);
  }
  console.log(`  Files : ${docs.map((d) => d.name).join(', ')}\n`);

  // health
  try {
    const h = await getJson(`${CFG.api}/health`);
    if (h.status !== 200) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error(`[fatal] Backend not reachable at ${CFG.api} (${e.message}). Run ./lascas.sh start first.`);
    process.exit(1);
  }

  fs.mkdirSync(CFG.outDir, { recursive: true });
  startSampler();

  // idle baseline (before model is necessarily loaded)
  console.log('[baseline] sampling idle state (5s)...');
  await sleep(5000);
  const baselineIdle = aggregateWindow(Date.now() - 5000, Date.now());

  // cold start probe: small text request loads the model
  console.log('[cold-start] priming request (loads model if not resident)...');
  const primeText =
    'CLÁUSULA PRIMEIRA. O LOCATÁRIO deverá pagar ao LOCADOR, até o dia 05 (cinco) de cada mês, ' +
    'o valor de R$ 1.500,00 (mil e quinhentos reais), sob pena de multa de 10% (dez por cento) ' +
    'sobre o montante devido, nos termos do art. 62 da Lei nº 8.245/1991.';
  const primeT0 = Date.now();
  const prime = await simplifyText(primeText, 'medium');
  const coldStart = buildRunRecord({ name: '(prime)' }, 'medium', 0, prime.wallMs, prime.res, null);
  console.log(`[cold-start] ${(prime.wallMs / 1000).toFixed(1)}s (reported separately from warm runs)\n`);

  // model-resident baseline
  await sleep(4000);
  const baselineModelLoaded = aggregateWindow(Date.now() - 4000, Date.now());

  // warm runs, interleaved across docs/levels to spread thermal drift
  const levels = ['medium', 'light', 'strong'];
  const maxReps = Math.max(...levels.map((l) => CFG.reps[l] || 0));
  const runs = [];
  let done = 0;
  const totalRuns = docs.length * levels.reduce((s, l) => s + (CFG.reps[l] || 0), 0);

  for (let rep = 1; rep <= maxReps; rep++) {
    for (const level of levels) {
      if (rep > (CFG.reps[level] || 0)) continue;
      for (const doc of docs) {
        done++;
        process.stdout.write(`[run ${done}/${totalRuns}] ${doc.name} | ${level} | rep ${rep} ... `);
        const t0 = Date.now();
        try {
          const { res, wallMs } =
            doc.kind === 'pdf'
              ? await simplifyPdf(doc.path, level)
              : await simplifyText(fs.readFileSync(doc.path, 'utf8'), level);
          await takeSample(); // ensure at least one sample inside window
          const rec = buildRunRecord(doc, level, rep, wallMs, res, aggregateWindow(t0, Date.now()));
          rec.startedAt = new Date(t0).toISOString();
          runs.push(rec);
          console.log(
            rec.error
              ? `ERROR (${rec.error})`
              : `${(wallMs / 1000).toFixed(1)}s | core ${(rec.coreMs / 1000).toFixed(1)}s | ` +
                `${rec.meta.origWords}w -> ${rec.meta.outWords}w | llm ${rec.meta.llmAccepted}/${rec.meta.llmCalls}`
          );
        } catch (e) {
          runs.push({ doc: doc.name, level, rep, error: String(e.message || e) });
          console.log(`FAILED (${e.message})`);
        }
        await sleep(1500); // brief pause between runs
      }
    }
  }

  stopSampler();

  // ---------------- aggregation ----------------
  const ok = runs.filter((r) => !r.error && r.httpStatus === 200);
  const groups = {};
  for (const r of ok) {
    const key = `${r.doc} | ${r.level}`;
    (groups[key] = groups[key] || []).push(r);
  }
  const summaryByDocLevel = {};
  for (const [key, rs] of Object.entries(groups)) {
    summaryByDocLevel[key] = {
      runs: rs.length,
      origWords: rs[0].meta?.origWords,
      profile: rs[0].meta?.profile,
      wallMs: stats(rs.map((r) => r.wallMs)),
      coreMs: stats(rs.map((r) => r.coreMs)),
      extractAndOverheadMs: stats(rs.map((r) => r.extractAndOverheadMs)),
      inputWordsPerSec: stats(rs.map((r) => r.inputWordsPerSec)),
      secPer1000Words: stats(rs.map((r) => r.secPer1000Words)),
      compressionRatio: stats(rs.map((r) => r.compressionRatio)),
      llmCalls: rs.reduce((s, r) => s + (r.meta?.llmCalls || 0), 0),
      llmAccepted: rs.reduce((s, r) => s + (r.meta?.llmAccepted || 0), 0),
      llmRejected: rs.reduce((s, r) => s + (r.meta?.llmRejected || 0), 0),
      llmHeuristicFallback: rs.reduce((s, r) => s + (r.meta?.llmHeuristicFallback || 0), 0),
      peakVramMB: Math.max(0, ...rs.map((r) => r.resources?.peak_vramUsedMB || 0)) || undefined,
      meanGpuUtilPct:
        stats(rs.map((r) => r.resources?.mean_gpuUtilPct).filter(Number.isFinite))?.mean,
    };
  }
  const summaryByLevel = {};
  for (const level of levels) {
    const rs = ok.filter((r) => r.level === level);
    if (!rs.length) continue;
    summaryByLevel[level] = {
      runs: rs.length,
      wallMs: stats(rs.map((r) => r.wallMs)),
      secPer1000Words: stats(rs.map((r) => r.secPer1000Words)),
      inputWordsPerSec: stats(rs.map((r) => r.inputWordsPerSec)),
      compressionRatio: stats(rs.map((r) => r.compressionRatio)),
      llmAcceptanceRate: +(
        rs.reduce((s, r) => s + (r.meta?.llmAccepted || 0), 0) /
        Math.max(1, rs.reduce((s, r) => s + (r.meta?.llmCalls || 0), 0))
      ).toFixed(3),
      heuristicFallbackShare: +(
        rs.reduce((s, r) => s + (r.meta?.llmHeuristicFallback || 0), 0) /
        Math.max(1, rs.reduce((s, r) => s + (r.meta?.paragraphs || 0), 0))
      ).toFixed(3),
      peakVramMB: Math.max(0, ...rs.map((r) => r.resources?.peak_vramUsedMB || 0)) || undefined,
    };
  }

  console.log('\n[specs] collecting machine specs...');
  const specs = await collectSpecs();

  const report = {
    generatedAt: new Date().toISOString(),
    config: CFG,
    documents: docs.map(({ name, kind, bytes }) => ({ name, kind, bytes })),
    specs,
    baselineIdle,
    baselineModelLoaded,
    coldStart,
    runs,
    summaryByDocLevel,
    summaryByLevel,
    notes: [
      'wallMs = end-to-end client wall time (includes PDF extraction, preprocessing, LLM calls, validation).',
      'coreMs = backend meta.ms (simplifyBlocks only, excludes PDF extraction).',
      'Cold start measured with a small priming request; all matrix runs are warm.',
      'RAM figures are read inside WSL2 and reflect memory available to WSL, not the Windows host total.',
      'VRAM/GPU figures via nvidia-smi (global GPU usage during the run window).',
    ],
  };

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outFile = path.join(CFG.outDir, `bench-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  // console summary
  console.log('\n================ SUMMARY (doc x level) ================');
  for (const [key, s] of Object.entries(summaryByDocLevel)) {
    console.log(
      `${key.padEnd(46)} n=${s.runs} | wall mean ${(s.wallMs.mean / 1000).toFixed(1)}s ` +
        `(sd ${(s.wallMs.sd / 1000).toFixed(1)}) | ${s.secPer1000Words?.mean ?? '?'} s/1000w | ` +
        `ratio ${s.compressionRatio?.mean ?? '-'} | llm ${s.llmAccepted}/${s.llmCalls} | fb ${s.llmHeuristicFallback}`
    );
  }
  console.log('\nReport saved to:', outFile);
  console.log('Send this JSON back to continue the article update.');
}

main().catch((e) => {
  stopSampler();
  console.error('[fatal]', e);
  process.exit(1);
});
