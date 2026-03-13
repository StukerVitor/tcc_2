export function normalizeForCompare(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, '"')
    .trim();
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const k = String(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function mustKeepTerms(original, simplified) {
  const o = String(original ?? "");
  const s = String(simplified ?? "");

  const MUST_KEEP = [
    /\boutorgantes?\b/gi,
    /\boutorgados?\b/gi,
    /\bintervenientes?\b/gi,
    /\bassistentes?\b/gi,
    /\bde\s+cujus\b/gi,
    /\bdou\s+fé\b/gi,
    /\blocador(?:a)?\b/gi,
    /\blocat[aá]ri[oa]s?\b/gi,
    /\bfiador(?:a|es)?\b/gi,
    /\bcontratante\b/gi,
    /\bcontratada\b/gi,
    /\bdoravante\b/gi,
    /\breclamante\b/gi,
    /\breclamada\b/gi,
    /\bautor(?:a)?\b/gi,
    /\br[eé]u\b/gi,
    /\brequerente\b/gi,
    /\brequerid[oa]\b/gi,
    /\bvalor\s+da\s+causa\b/gi,
  ];

  for (const re of MUST_KEEP) {
    if (re.test(o) && !re.test(s)) return false;
  }
  return true;
}

function validateIntegrityStrict(original, simplified) {
  const o = String(original ?? "");
  const s = String(simplified ?? "");

  const nums = o.match(/\b\d[\d\.\,\/-]*\b/g) || [];
  for (const n of nums) if (!s.includes(n)) return false;

  const dates = o.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [];
  for (const d of dates) if (!s.includes(d)) return false;

  const perc = o.match(/\b\d{1,3}[.,]?\d*%/g) || [];
  for (const p of perc) if (!s.includes(p)) return false;

  const laws = o.match(/\b(Lei\s*n[ºo]?\s*\d+|art\.?\s*\d+|§\s*\d+)\b/gi) || [];
  for (const l of laws) {
    const re = new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (!re.test(s)) return false;
  }

  const normIds = o.match(/\b[A-Z]{2,}(?:-[A-Z]{2,})+\/\d{4}\b/g) || [];
  for (const id of normIds) if (!s.includes(id)) return false;

  const regRefs = o.match(/\bR\/\d+\b/gi) || [];
  for (const r of regRefs) {
    const re = new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (!re.test(s)) return false;
  }

  if (!mustKeepTerms(o, s)) return false;
  return true;
}

function validateIntegrityRelaxed(original, simplified) {
  const o = String(original ?? "");
  const s = String(simplified ?? "");
  const important = [];

  important.push(...(o.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g) || []));
  important.push(...(o.match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g) || []));
  important.push(...(o.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || []));
  important.push(...(o.match(/\b\d{1,2}\s+de\s+[A-Za-zçáéíóúâêôãõÇÁÉÍÓÚÂÊÔÃÕ]+\s+de\s+\d{4}\b/giu) || []));
  important.push(...(o.match(/\b\d{1,3}(?:[.,]\d+)?\s*%\b/g) || []));
  important.push(...(o.match(/\bR\$\s*\d[\d\.\,]*\b/g) || []));
  important.push(...(o.match(/\b\d{3,}(?:[.\-\/]\d+){2,}\b/g) || []));
  important.push(...(o.match(/\bR\/\d+\b/gi) || []));
  important.push(...(o.match(/\bLivro\s+[A-Z]-\d+\b/giu) || []));
  important.push(...(o.match(/\b[A-Z]{2,}(?:-[A-Z]{2,})+\/\d{4}\b/g) || []));

  for (const tok of uniq(important)) {
    if (!s.includes(tok)) return false;
  }

  const laws = uniq(o.match(/\b(Lei\s*n[ºo]?\s*\d+|art\.?\s*\d+|§\s*\d+)\b/gi) || []);
  for (const l of laws) {
    const re = new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (!re.test(s)) return false;
  }

  if (!mustKeepTerms(o, s)) return false;
  return true;
}

function validateIntegritySummary(original, simplified) {
  const o = String(original ?? "");
  const s = String(simplified ?? "");
  const important = [];

  important.push(...(o.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || []));
  important.push(...(o.match(/\b\d{1,2}\s+de\s+[A-Za-zçáéíóúâêôãõÇÁÉÍÓÚÂÊÔÃÕ]+\s+de\s+\d{4}\b/giu) || []));
  important.push(...(o.match(/\b\d{1,3}(?:[.,]\d+)?\s*%\b/g) || []));
  important.push(...(o.match(/\bR\$\s*\d[\d\.\,]*\b/g) || []));
  important.push(...(o.match(/\b\d{3,}(?:[.\-\/]\d+){2,}\b/g) || []));
  important.push(...(o.match(/\bR\/\d+\b/gi) || []));
  important.push(...(o.match(/\bLivro\s+[A-Z]-\d+\b/giu) || []));
  important.push(...(o.match(/\b[A-Z]{2,}(?:-[A-Z]{2,})+\/\d{4}\b/g) || []));

  for (const tok of uniq(important)) {
    if (!s.includes(tok)) return false;
  }

  const laws = uniq(o.match(/\b(Lei\s*n[ºo]?\s*\d+|art\.?\s*\d+|§\s*\d+)\b/gi) || []);
  for (const l of laws) {
    const re = new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (!re.test(s)) return false;
  }

  if (!mustKeepTerms(o, s)) return false;
  return true;
}

export function validateIntegrity(original, simplified, opts = {}) {
  const mode = String(opts?.mode || "strict");
  if (mode === "summary") return validateIntegritySummary(original, simplified);
  if (mode === "relaxed") return validateIntegrityRelaxed(original, simplified);
  return validateIntegrityStrict(original, simplified);
}
