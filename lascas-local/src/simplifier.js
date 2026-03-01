import axios from "axios";
import {
  asString,
  protectPlaceholders,
  unprotectPlaceholders,
  normalizeArtifactsForLegal,
  splitSentencesProtected,
} from "./preprocess.js";
import { annotateFirstOccurrences } from "./glossary.js";
import { validateIntegrity, normalizeForCompare } from "./validators.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.LASCAS_MODEL || "legal-simplifier:latest";

const SEED = Number.isFinite(Number(process.env.LASCAS_SEED))
  ? Number(process.env.LASCAS_SEED)
  : 42;

/**
 * light: sentence rewrite (near original length)
 * medium/strong: real condensation + guaranteed-shrink fallback
 */
const LEVELS = {
  light: {
    mode: "rewrite",
    temperature: 0.12,
    reduceHint: "médio",
    minWordsToRewrite: 8,
    perCallMs: 24000,
    maxTokensCap: 520,
    minDelta: 0.07,
    minLenRatio: 0.72,
    maxLenRatio: 1.60,
  },

  medium: {
    mode: "condense",
    temperature: 0.16,
    reduceHint: "médio",
    perCallMs: 52000,
    maxTokensCap: 900, // lower cap helps force shorter outputs
    targetRatio: 0.55,
    acceptMaxRatio: 0.88, // candidate must shrink at least a bit
  },

  strong: {
    mode: "condense",
    temperature: 0.18,
    reduceHint: "forte",
    perCallMs: 65000,
    maxTokensCap: 750, // lower cap helps force shorter outputs
    targetRatio: 0.35,
    acceptMaxRatio: 0.78,
  },
};

let COLD_START = true;

function wordCount(s) {
  return String(s ?? "").replace(/\n+/g, " ").trim().split(/\s+/).filter(Boolean).length;
}

function extractPlaceholderList(s) {
  return String(s ?? "").match(/\[\[\[LASCAS_[A-Z]+_\d{4}\]\]\]/g) || [];
}

function extractPlaceholderSet(s) {
  return new Set(extractPlaceholderList(s));
}

function hasMetaPreamble(s) {
  const t = normalizeForCompare(s).slice(0, 140);
  return (
    t.startsWith("resumo:") ||
    t.startsWith("texto simplificado:") ||
    t.startsWith("versao simplificada:") ||
    t.startsWith("versão simplificada:") ||
    t.startsWith("nivel:") ||
    t.startsWith("nível:") ||
    t.startsWith("aqui esta") ||
    t.startsWith("aqui está") ||
    t.startsWith("aqui vai") ||
    t.startsWith("a seguir") ||
    t.startsWith("conforme as regras") ||
    t.startsWith("de acordo com as regras") ||
    t.startsWith("frase reescrita") ||
    t.startsWith("texto reescrito") ||
    t.startsWith("em linguagem simples")
  );
}

function stripMetaLead(t) {
  let s = String(t ?? "").trim();

  s = s.replace(
    /^\s*(?:aqui\s+est[aá]\s*(?:a\s+frase|o\s+texto)?\s*(?:reescrit[oa]|simplificad[oa])?(?:\s+em\s+linguagem\s+simples)?\s*:?\s*)/i,
    ""
  );
  s = s.replace(/^\s*(?:aqui\s+vai|segue|a\s+seguir)\s*:?\s*/i, "");
  s = s.replace(/^\s*(?:conforme\s+as\s+regras|de\s+acordo\s+com\s+as\s+regras)\s*:?\s*/i, "");
  s = s.replace(/^\s*(?:frase\s+reescrita|texto\s+reescrito)\s*:?\s*/i, "");

  if (hasMetaPreamble(s)) return "";
  return s.trim();
}

function sanitizeLLMSentence(s) {
  let t = String(s ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) return "";

  if (hasMetaPreamble(t)) {
    t = stripMetaLead(t);
    if (!t) return "";
  }

  const lines = t
    .split("\n")
    .map((ln) =>
      ln
        .replace(/^\s*(?:•|[\-–])\s+/g, "")
        .replace(/^\s*\(?\d+\)?[.)-]\s+/g, "")
        .replace(/^\s*\(?[a-z]\)?[.)-]\s+/gi, "")
        .trim()
    )
    .filter(Boolean);

  t = lines.join(" ").replace(/\s+/g, " ").trim();
  t = stripMetaLead(t);

  if (!t || t.includes("\n")) return "";
  return t;
}

function sanitizeLLMBlock(s) {
  let t = String(s ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) return "";

  if (hasMetaPreamble(t)) {
    t = stripMetaLead(t);
    if (!t) return "";
  }

  t = t.replace(
    /(^|\n)\s*(?:aqui\s+est[aá]|aqui\s+vai|a\s+seguir|conforme\s+as\s+regras|de\s+acordo\s+com\s+as\s+regras|frase\s+reescrita|texto\s+reescrito|em\s+linguagem\s+simples)\s*:[^\n]*\n?/gi,
    "$1"
  );

  // Remove accidental bullets/numbering at line starts (we format later)
  t = t
    .split("\n")
    .map((ln) =>
      ln
        .replace(/^\s*(?:•|[\-–])\s+/g, "")
        .replace(/^\s*\(?\d+\)?[.)-]\s+/g, "")
        .replace(/^\s*\(?[a-z]\)?[.)-]\s+/gi, "")
        .trim()
    )
    .filter(Boolean)
    .join("\n");

  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// Strict anti-hallucination for rewrite mode only
function violatesNoNewKeywordsRewrite(origProt, outProt) {
  const orig = String(origProt ?? "");
  const out = String(outProt ?? "");

  const rules = [
    { re: /\bmatr[ií]cula\b/i, name: "matrícula" },
    { re: /\bheran[cç]a\b/i, name: "herança" },
    { re: /\bherdeir[oa]s?\b/i, name: "herdeiro" },
    { re: /\btabeli[aã]o|tabeli[oõ]es\b/i, name: "tabelião" },
  ];

  for (const r of rules) {
    if (!r.re.test(orig) && r.re.test(out)) return `introduced:${r.name}`;
  }

  const origHasEu = /\b(eu|meu|minha|nós|nosso)\b/i.test(orig);
  const outHasEu = /\b(eu|meu|minha|nós|nosso)\b/i.test(out);
  if (!origHasEu && outHasEu) return "introduced:first-person";

  return null;
}

// Less strict for condense mode (only block 1st person + “fala do tabelião” invented)
function violatesNoNewKeywordsCondense(origProt, outProt) {
  const orig = String(origProt ?? "");
  const out = String(outProt ?? "");

  const origHasEu = /\b(eu|meu|minha|nós|nosso)\b/i.test(orig);
  const outHasEu = /\b(eu|meu|minha|nós|nosso)\b/i.test(out);
  if (!origHasEu && outHasEu) return "introduced:first-person";

  const reTbl = /\b(tabeli[aã]o|escrevente|cartor[aá]rio)\b/i;
  if (!reTbl.test(orig) && reTbl.test(out)) return "introduced:cartorio-voice";

  return null;
}

function deltaRatio(orig, cand) {
  const a = normalizeForCompare(orig);
  const b = normalizeForCompare(cand);
  if (!a || !b) return 0;
  if (a === b) return 0;

  const aw = a.split(" ").filter(Boolean);
  const bw = b.split(" ").filter(Boolean);

  const setA = new Set(aw);
  const setB = new Set(bw);

  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;

  const jacc = inter / Math.max(1, setA.size + setB.size - inter);
  return 1 - jacc;
}

// ------------------------
// Deterministic text improvements (existing)
// ------------------------

function applyBoilerplatePlainLanguage(text) {
  let out = String(text ?? "");

  out = out.replace(/\bSAIBAM\s+QUANTOS\b/gi, "Para conhecimento de todos");
  out = out.replace(/\bvirem\s*,\s*que\b/gi, "consta que");
  out = out.replace(/\bvirem\s+que\b/gi, "consta que");
  out = out.replace(/\bviviam\s+maritalmente\b/gi, "viviam como casal");
  out = out.replace(/\bSubs\.\s+do\s+Tabeli[aã]o\b/gi, "Substituta do Tabelião");

  out = out.replace(/"(\s*de\s+cujus\s*)"/gi, "$1");
  out = out.replace(/"(\s*de\s+cujus\s*)/gi, "$1");
  out = out.replace(/(\s*de\s+cujus\s*)"/gi, "$1");

  out = out.replace(
    /(^|\n)\s*(?:aqui\s+est[aá]|aqui\s+vai|a\s+seguir|conforme\s+as\s+regras|de\s+acordo\s+com\s+as\s+regras|frase\s+reescrita|texto\s+reescrito|em\s+linguagem\s+simples)\s*:[^\n]*\n?/gi,
    "$1"
  );

  return out;
}

function fixRegistryPhrasing(text) {
  let out = String(text ?? "");

  out = out.replace(
    /\bO\s+im[oó]vel\s+foi\s+encontrad[oa]\s+(?:conforme|com)\s+a\s+matr[ií]cula\b/gi,
    "O imóvel consta na matrícula"
  );
  out = out.replace(
    /\bO\s+im[oó]vel\s+foi\s+encontrad[oa]\s+com\s+a\s+matr[ií]cula\b/gi,
    "O imóvel consta na matrícula"
  );
  out = out.replace(
    /\bO\s+im[oó]vel\s+foi\s+encontrad[oa]\s+na\s+matr[ií]cula\b/gi,
    "O imóvel consta na matrícula"
  );

  return out;
}

function addStructuralBreaks(text) {
  let out = String(text ?? "");

  const HEAD_LABELS = [
    "NATUREZA DO ATO",
    "AUTORES DA HERANÇA",
    "QUALIFICAÇÃO",
    "DOS FALECIMENTOS",
    "DA EXISTÊNCIA DE TESTAMENTO",
    "CÔNJUGE",
    "HERDEIROS",
    "NOMEAÇÃO DE INVENTARIANTE",
    "ARROLAMENTO DOS BENS",
    "BENS",
    "CONFRONTANDO",
    "ASSINATURAS",
    "ASSINATURA",
  ];

  for (const h of HEAD_LABELS) {
    const re = new RegExp(
      `(\\b\\d+(?:\\.\\d+)?\\s*[-–.]\\s*)?\\b(${h}\\s*:)\\s*`,
      "giu"
    );
    out = out.replace(re, (_m, pfx, label) => `\n\n${(pfx || "").trim()}${pfx ? " " : ""}${label}\n`);
  }

  out = out.replace(/([^\n])\s+(?=\d+\.\d+\.\s*[A-ZÀ-Ý]{3,}[^.\n]*:)/g, "$1\n\n");
  out = out.replace(/([^\n])\s+(?=\d+\.\s*[A-ZÀ-Ý]{3,}[^.\n]*:)/g, "$1\n\n");
  out = out.replace(/([^\n])\s+(?=\d+\s*[-–]\s*[A-ZÀ-Ý]{3,}[^.\n]*:)/g, "$1\n\n");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function fixNumberedHeadings(text) {
  let out = String(text ?? "");
  out = out.replace(/(\n\n)(\d+\.)\s*\n+\s*([A-ZÀ-Ý][A-ZÀ-Ý0-9 .'"ºª-]{2,}:)/g, "$1$2 $3");
  out = out.replace(/(\n\n)(\d+\.\d+\.)\s*\n+\s*([A-ZÀ-Ý][A-ZÀ-Ý0-9 .'"ºª-]{2,}:)/g, "$1$2 $3");
  out = out.replace(/(\n\n)(\d+\s*[-–])\s*\n+\s*([A-ZÀ-Ý][A-ZÀ-Ý0-9 .'"ºª-]{2,}:)/g, "$1$2 $3");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function dedupeBensLabel(text) {
  return String(text ?? "").replace(/\b(bens\s*:)\s*\1\s*/gi, "$1 ");
}

function looksLikePeopleList(header) {
  const h = normalizeForCompare(header);
  return (
    h.includes("compareceram") ||
    h.includes("outorgante") ||
    h.includes("outorgado") ||
    h.includes("interveniente") ||
    h.includes("assistente")
  );
}

function looksLikeAssetList(header, rest) {
  const h = normalizeForCompare(header);
  if (h.includes("bens") || h.includes("arrolamento")) return true;
  return /\b[a-z]\)\s+/i.test(String(rest || ""));
}

function bulletizeBySemicolons(paragraph) {
  const p = String(paragraph || "").trim();
  if (!p) return p;

  const colonIdx = p.indexOf(":");
  if (colonIdx < 0) return p;

  const header = p.slice(0, colonIdx + 1).trim();
  const rest0 = p.slice(colonIdx + 1).trim();

  const peopleMode = looksLikePeopleList(header);
  const assetMode = looksLikeAssetList(header, rest0);

  if (!peopleMode && !assetMode) return p;

  if (assetMode) {
    const m = rest0.match(/\b[a-z]\)\s+/i);
    if (!m || typeof m.index !== "number") return p;

    const pos = m.index;
    const intro = rest0.slice(0, pos).trim();
    const listText = rest0.slice(pos).trim();

    const items = listText
      .split(/;\s*(?=[a-z]\)\s+)/i)
      .map((x) => x.trim())
      .filter(Boolean);

    if (items.length < 2) return p;
    if (items.some((it) => it.length > 80000)) return p;

    const bullets = items.map((it) => `• ${it.replace(/\s+([,.;:!?%])/g, "$1")}`).join("\n");
    return `${header}\n${intro ? intro + "\n" : ""}${bullets}`.trim();
  }

  const semiCount = (p.match(/;/g) || []).length;
  if (semiCount < 2) return p;

  const items = rest0.split(/;\s*/g).map((x) => x.trim()).filter(Boolean);
  if (items.length < 2) return p;
  if (items.some((it) => it.length > 80000)) return p;

  const bullets = items.map((it) => `• ${it.replace(/\s+([,.;:!?%])/g, "$1")}`).join("\n");
  return `${header}\n${bullets}`.trim();
}

function bulletizeConfrontando(text) {
  const s = String(text ?? "");
  if (!/\bconfrontando\s*:/i.test(s)) return s;

  const markers = [
    "pela frente",
    "pelo fundo",
    "por um lado",
    "por outro lado",
    "ao leste",
    "ao oeste",
    "ao norte",
    "ao sul",
    "distante",
  ];

  function splitClauses(raw) {
    const lower = raw.toLowerCase();
    const hits = [];

    for (const m of markers) {
      let idx = 0;
      while (true) {
        const j = lower.indexOf(m, idx);
        if (j < 0) break;
        const prev = lower[j - 1] || " ";
        if (/\p{L}/u.test(prev)) {
          idx = j + m.length;
          continue;
        }
        hits.push({ pos: j });
        idx = j + m.length;
      }
    }

    hits.sort((a, b) => a.pos - b.pos);
    if (!hits.length) return [raw.trim()].filter(Boolean);

    const clauses = [];
    for (let i = 0; i < hits.length; i++) {
      const start = hits[i].pos;
      const end = i + 1 < hits.length ? hits[i + 1].pos : raw.length;
      const piece = raw.slice(start, end).trim();
      if (piece) clauses.push(piece);
    }

    return clauses.map((x) => x.replace(/\s+([,.;:!?%])/g, "$1")).filter(Boolean);
  }

  return s.replace(
    /(confrontando\s*:)([\s\S]*?)(?=\n•\s*[a-z]\)\s+|\n{2,}|$)/gi,
    (_m, head, body) => {
      const raw = String(body || "").trim();
      if (!raw) return head;

      const cutRes = [
        raw.search(/\bDito\s+im[oó]vel\b/i),
        raw.search(/\bValor\s+atribu[ií]do\b/i),
        raw.search(/;\s*[a-z]\)\s+/i),
      ].filter((x) => x >= 0);

      const cutAt = cutRes.length ? Math.min(...cutRes) : -1;
      const confPart = cutAt >= 0 ? raw.slice(0, cutAt).trim() : raw;
      const restPart = cutAt >= 0 ? raw.slice(cutAt).trim() : "";

      const clauses = splitClauses(confPart);
      if (clauses.length <= 1) {
        return `${head} ${confPart}${restPart ? "\n" + restPart : ""}`.trimEnd();
      }

      const bullets = clauses.map((c) => `• ${c}`).join("\n");
      return `${head}\n${bullets}${restPart ? "\n" + restPart : ""}`.trimEnd();
    }
  );
}

function postStructure(text) {
  const paras = String(text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  for (const p of paras) out.push(bulletizeBySemicolons(p));

  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function dropDanglingCurrencyDuplicates(text) {
  const lines = String(text || "").split("\n");
  const out = [];

  const norm = (s) => String(s).replace(/\s+/g, " ").trim().replace(/"/g, "");
  const isCurrencyOnly = (s) => /^R\$\s*\d[\d\.\,]*$/.test(norm(s));

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (isCurrencyOnly(cur) && out.length) {
      const amount = norm(cur);
      const prev = norm(out[out.length - 1]);
      if (prev.includes(amount)) continue;
    }
    out.push(cur);
  }

  return out.join("\n");
}

function redactPIIText(text) {
  let out = String(text ?? "");
  out = out.replace(/\b(\d{3})\.\d{3}\.\d{3}-(\d{2})\b/g, (_m, a, last2) => `${a}.***.***-${last2}`);
  out = out.replace(/(identidade\s+n[úu]mero\s+)(\d{6,})/gi, (_m, p1) => `${p1}***`);
  out = out.replace(/\b(n[ºo]\s*)(\d{1,6})\b/gi, (_m, p1) => `${p1}***`);
  return out;
}

// ------------------------
// LLM
// ------------------------

async function callOllamaChat(system, user, cfg, perCallMs, numPredict) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("soft-timeout"), perCallMs);

  try {
    const body = {
      model: MODEL,
      stream: false,
      keep_alive: "120m",
      options: {
        num_ctx: 8192,
        temperature: cfg.temperature,
        top_p: 0.9,
        repeat_penalty: 1.05,
        seed: SEED,
        num_predict: numPredict,
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };

    const { data } = await axios.post(`${OLLAMA_URL}/api/chat`, body, {
      timeout: 0,
      signal: controller.signal,
    });

    return asString(data?.message?.content ?? data?.response ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------
// Rewrite mode (light)
// ------------------------

function buildSentencePrompt(cfg, sentenceProtected) {
  const system = [
    "Você é um simplificador jurídico PT-BR em Linguagem Simples.",
    "",
    "Regras:",
    "1) NÃO altere placeholders [[[LASCAS_*_####]]].",
    "2) Preserve exatamente números, datas, valores, prazos, negações, nomes próprios e referências oficiais.",
    "3) Não invente nem omita informações. Não troque sentidos.",
    "4) Não use prefácios. Retorne só o texto.",
    "5) Retorne UMA única frase em uma linha (sem bullets, sem títulos).",
    `INTENSIDADE: ${cfg.reduceHint}`,
  ].join("\n");

  const user = [
    "Reescreva a frase abaixo de modo mais simples, mantendo TODAS as informações e preservando placeholders:",
    "",
    asString(sentenceProtected),
  ].join("\n");

  return { system, user };
}

const SEMICOLON_MARK = "<<<LASCAS_SC>>>";

function splitSentencesForRewrite(paragraphProtected) {
  const p = String(paragraphProtected ?? "").replace(/;/g, SEMICOLON_MARK);
  const sents = splitSentencesProtected(p).map((x) => String(x ?? "").replaceAll(SEMICOLON_MARK, ";"));
  return sents.filter((x) => String(x).trim());
}

function validateSentenceSafe(origProt, outProt, cfg) {
  if (!outProt) return false;
  if (hasMetaPreamble(outProt)) return false;
  if (outProt.includes("\n")) return false;

  const A = extractPlaceholderSet(origProt);
  const B = extractPlaceholderSet(outProt);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;

  const drift = violatesNoNewKeywordsRewrite(origProt, outProt);
  if (drift) return false;

  const d = deltaRatio(origProt, outProt);
  if (d < cfg.minDelta) return false;

  const a = normalizeForCompare(origProt);
  const b = normalizeForCompare(outProt);
  const lenRatio = b.length / Math.max(1, a.length);
  if (lenRatio < cfg.minLenRatio) return false;
  if (lenRatio > cfg.maxLenRatio) return false;

  if (!validateIntegrity(origProt, outProt, { mode: "strict" })) return false;
  return true;
}

// ------------------------
// Condense mode (medium/strong)
// ------------------------

function splitIntoChunksByWords(text, minWords = 520, maxWords = 1050) {
  const paras = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let acc = [];
  let accWords = 0;

  const flush = () => {
    if (!acc.length) return;
    chunks.push(acc.join("\n\n").trim());
    acc = [];
    accWords = 0;
  };

  for (const p of paras) {
    const w = wordCount(p);
    if (accWords + w > maxWords) {
      if (accWords >= minWords) {
        flush();
        acc.push(p);
        accWords = w;
        continue;
      }
      flush();
      chunks.push(p);
      continue;
    }
    acc.push(p);
    accWords += w;
  }

  flush();
  return chunks.length ? chunks : [String(text ?? "").trim()];
}

function buildCondensePrompt(cfg, chunkProtected, targetWords, requiredPH = []) {
  const sys = [
    "Você é um simplificador jurídico PT-BR em Linguagem Simples.",
    "",
    "OBJETIVO: condensar MUITO o trecho (reduzir bastante o tamanho), sem inventar fatos.",
    `LIMITE DURO: no máximo ${targetWords} palavras (tente ficar abaixo).`,
    "",
    "Priorize manter apenas o essencial:",
    "- tipo do ato / decisão / declaração;",
    "- quem (nomes) e relação relevante;",
    "- o quê (bem/obrigação/efeito);",
    "- datas, valores, percentuais, prazos;",
    "- referências oficiais (processo/matrícula/R/1/Livro/Lei/art.).",
    "",
    "Você PODE OMITIR (quando não forem essenciais):",
    "- CPF, RG, órgão expedidor, endereço completo, CEP, naturalidade, profissão, filiação, repetições e fórmulas cartorárias.",
    "",
    "Regras obrigatórias:",
    "1) NÃO altere placeholders [[[LASCAS_*_####]]]. Copie exatamente se usar.",
    "2) NÃO invente fatos, nomes, números, datas, valores, prazos ou referências.",
    "3) Preserve o sentido de negações e condições.",
    "4) NÃO use prefácios. Retorne só o texto.",
    "5) NÃO use 1ª pessoa.",
    "6) NÃO crie listas/bullets/títulos (a menos que já existam no trecho).",
    `INTENSIDADE: ${cfg.reduceHint}`,
  ].join("\n");

  const keepLine =
    requiredPH.length > 0
      ? `\n\nMANTENHA OBRIGATORIAMENTE estes placeholders (copie exatamente):\n${requiredPH.join(" ")}\n`
      : "";

  const user = [
    "Condense e simplifique o trecho abaixo.",
    "",
    asString(chunkProtected),
    keepLine,
  ].join("\n");

  return { system: sys, user };
}

function buildPlaceholderIndex(placeholders) {
  const m = new Map();
  for (const p of placeholders || []) m.set(p.ph, p);
  return m;
}

function isCPF(val) {
  return /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(String(val || "").trim());
}
function isCNPJ(val) {
  return /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(String(val || "").trim());
}

function isCriticalNumValue(val) {
  const v = String(val ?? "").trim();

  if (/^R\$\s*\d/i.test(v)) return true; // money
  if (/^R\/\d+/i.test(v)) return true; // registry ref
  if (/^Livro\s+[A-Z]-\d+/i.test(v)) return true; // book ref
  if (/\d{3,}(?:[.\-\/]\d+){2,}/.test(v)) return true; // process-like

  return false;
}

function classifyPlaceholder(ph, phIndex) {
  const meta = phIndex.get(ph);
  const kind = String(meta?.kind || "");
  const val = String(meta?.val || "").trim();

  if (kind === "LAW" || kind === "DATE" || kind === "PERC" || kind === "NEG") return "essential";
  if (kind === "TERM") return "term";

  if (kind === "NUM") {
    if (isCPF(val) || isCNPJ(val)) return "pii";
    if (/^\d{9,}$/.test(val)) return "pii"; // long pure digits often personal/document ids
    if (isCriticalNumValue(val)) return "essential";
    return "other";
  }

  return "other";
}

function pickRequiredPlaceholdersForChunk(chunkProtected, phIndex) {
  const origPH = extractPlaceholderList(chunkProtected);
  const origSet = new Set(origPH);

  const required = [];

  // Always require: LAW/DATE/PERC + critical NUM + at least some NEG if present.
  const neg = [];

  for (const ph of origPH) {
    const cls = classifyPlaceholder(ph, phIndex);
    const meta = phIndex.get(ph);
    const kind = String(meta?.kind || "");

    if (kind === "LAW" || kind === "DATE" || kind === "PERC") required.push(ph);
    else if (kind === "NEG") neg.push(ph);
    else if (cls === "essential") required.push(ph);
  }

  // Keep a limited number of NEG placeholders (still preserves meaning in most cases)
  for (let i = 0; i < Math.min(12, neg.length); i++) required.push(neg[i]);

  // De-dupe preserving order
  const out = [];
  const seen = new Set();
  for (const x of required) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }

  return { required: out, origSet };
}

function candidateOkForCondense(origChunk, cand, cfg, requiredPH, origSet) {
  if (!cand) return false;
  if (hasMetaPreamble(cand)) return false;

  const drift = violatesNoNewKeywordsCondense(origChunk, cand);
  if (drift) return false;

  // Candidate must NOT invent placeholder ids that weren't in original chunk
  const candSet = extractPlaceholderSet(cand);
  for (const ph of candSet) {
    if (!origSet.has(ph)) return false;
  }

  // Candidate must contain all required placeholders
  for (const ph of requiredPH) {
    if (!candSet.has(ph)) return false;
  }

  // Must shrink enough
  const ow = Math.max(1, wordCount(origChunk));
  const cw = Math.max(1, wordCount(cand));
  const ratio = cw / ow;

  if (ratio > cfg.acceptMaxRatio) return false;

  return true;
}

// ---------- Guaranteed-shrink heuristic fallback ----------

function isHeadingLike(p) {
  const t = String(p || "").trim();
  if (!t) return false;
  if (t.length > 220) return false;
  if (!t.endsWith(":")) return false;
  // many headings are uppercase-ish
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (!letters) return true;
  const upper = letters.replace(/[^A-ZÀ-Ý]/g, "").length;
  return upper / Math.max(1, letters.length) > 0.65;
}

function stripQualificationTailSentence(sent) {
  let t = String(sent || "").trim();
  if (!t) return t;

  const cutRe =
    /\b(portador(?:a|es)?\b|inscrit(?:o|a|os|as)\s+(?:no|na|sob)\s+CPF\b|RG\b|CPF\b|CNPJ\b|SSP\/[A-Z]{2}\b|OAB\/[A-Z]{2}\b|órgão\s+expedidor\b|residente(?:s)?\s+e\s+domiciliad(?:o|a|os|as)\b|residente\b|domiciliad(?:o|a|os|as)\b|endereço\b|CEP\b|bairro\b|cidade\b|estado\s+civil\b|profiss[aã]o\b|natural(?:idade)?\b|nascid(?:o|a)\b|filh(?:o|a)\s+de\b)\b/iu;

  const idx = t.search(cutRe);
  if (idx >= 0) {
    t = t.slice(0, idx).replace(/[ ,;:\-]+$/g, "").trim();
  }
  return t;
}

function sentenceHasOnlyPIIPlaceholders(sentence, phIndex) {
  const phs = extractPlaceholderList(sentence);
  if (!phs.length) return false;

  let hasEssential = false;
  let hasOnlyPiiOrOther = true;

  for (const ph of phs) {
    const cls = classifyPlaceholder(ph, phIndex);
    if (cls === "essential") hasEssential = true;
    if (cls !== "pii" && cls !== "other") hasOnlyPiiOrOther = false;
  }

  return !hasEssential && hasOnlyPiiOrOther;
}

function sentenceHasEssentialSignals(sentence, phIndex) {
  const phs = extractPlaceholderList(sentence);
  for (const ph of phs) {
    if (classifyPlaceholder(ph, phIndex) === "essential") return true;
  }

  const s = normalizeForCompare(sentence);
  // keywords that usually indicate core facts (safe-ish)
  const kw =
    /\b(im[oó]vel|bens?|valor|pagament|quita|declara|ficou|fica|fica(m)?\s+assim|invent[aá]rio|partilha|testamento|matr[ií]cula|processo|registro|livro|folha|lei|art\.|resolu[cç][aã]o|decreto|portaria|prazo|data)\b/i;

  if (kw.test(s)) return true;
  return false;
}

function enforceWordBudgetByDropping(textProtected, budgetWords, phIndex) {
  let t = String(textProtected || "").trim();
  if (!t) return t;

  // Drop ASSINATURAS blocks aggressively in medium/strong
  t = t.replace(/(^|\n\n)\s*(ASSINATURAS?:)\s*\n[\s\S]*$/giu, "$1");

  // If still too long, drop tail paragraphs then tail sentences
  let paras = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const join = () => paras.join("\n\n").trim();

  while (paras.length > 1 && wordCount(join()) > budgetWords) {
    paras.pop();
  }

  // If still too long, trim last paragraph sentences
  if (wordCount(join()) > budgetWords && paras.length) {
    const last = paras[paras.length - 1];
    const sents = splitSentencesProtected(last).map((x) => String(x || "").trim()).filter(Boolean);

    while (sents.length > 1 && wordCount(paras.slice(0, -1).join("\n\n") + "\n\n" + sents.join(" ")) > budgetWords) {
      sents.pop();
    }

    paras[paras.length - 1] = sents.join(" ").trim();
  }

  // Final hard truncate by words (rare)
  let out = join();
  if (wordCount(out) > budgetWords) {
    const words = out.split(/\s+/).filter(Boolean);
    out = words.slice(0, Math.max(40, budgetWords)).join(" ").trim();
  }

  return out.trim();
}

function heuristicCondenseProtectedChunk(chunkProtected, cfg, phIndex, targetWords) {
  const paras = String(chunkProtected || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const outParas = [];

  for (let pi = 0; pi < paras.length; pi++) {
    const p = paras[pi];
    if (!p) continue;

    // drop pure ASSINATURAS heading block in condense
    const pn = normalizeForCompare(p);
    if (pn === "assinaturas:" || pn === "assinatura:" || pn.startsWith("assinaturas")) continue;

    if (isHeadingLike(p)) {
      outParas.push(p);
      continue;
    }

    const sents = splitSentencesProtected(p).map((x) => String(x || "").trim()).filter(Boolean);
    if (!sents.length) continue;

    const kept = [];

    // Keep essential sentences; drop PII-only sentences
    for (const s of sents) {
      if (sentenceHasOnlyPIIPlaceholders(s, phIndex)) continue;

      if (sentenceHasEssentialSignals(s, phIndex)) {
        kept.push(stripQualificationTailSentence(s));
      }
    }

    // If none essential, keep first sentence (medium) or maybe drop (strong)
    if (!kept.length) {
      if (cfg.reduceHint === "forte") {
        // strong: keep first sentence only if it seems informative
        const first = stripQualificationTailSentence(sents[0]);
        if (wordCount(first) >= 6) kept.push(first);
      } else {
        kept.push(stripQualificationTailSentence(sents[0]));
      }
    }

    const perParaLimit = cfg.reduceHint === "forte" ? 1 : 2;
    outParas.push(kept.slice(0, perParaLimit).join(" ").trim());
  }

  let out = outParas.filter(Boolean).join("\n\n").trim();

  // Enforce global budget for this chunk
  out = enforceWordBudgetByDropping(out, Math.max(70, targetWords), phIndex);

  // Safety: never return empty
  if (!out) out = String(chunkProtected || "").trim();

  return out.trim();
}

// ------------------------
// Main
// ------------------------

export async function simplifyBlocks(rawText, level = "light", opts = {}) {
  const lvl = ["light", "medium", "strong"].includes(level) ? level : "light";
  const cfg = LEVELS[lvl] || LEVELS.light;

  const redactPII = Boolean(opts?.redactPII);

  const meta = {
    usedLLM: false,
    failedLLM: false,
    paragraphs: 0,
    sentences: 0,
    llmCalls: 0,
    llmAccepted: 0,
    llmRejected: 0,
    llmHeuristicFallback: 0,
    redactPII,
    integrityWarning: "",
    origWords: 0,
    outWords: 0,
    ms: 0,
  };

  const t0 = Date.now();

  const raw0 = normalizeArtifactsForLegal(asString(rawText));
  const { protectedText, placeholders } = protectPlaceholders(raw0);

  const preLLM = applyBoilerplatePlainLanguage(protectedText);
  const structuredProtected = fixNumberedHeadings(addStructuralBreaks(preLLM));

  meta.origWords = wordCount(structuredProtected);

  // ------------------------
  // MODE: rewrite (light)
  // ------------------------
  if (cfg.mode === "rewrite") {
    const paragraphs = String(structuredProtected)
      .replace(/\r\n?/g, "\n")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);

    meta.paragraphs = paragraphs.length;

    const outParasProtected = [];
    const coldBoost = COLD_START ? 12000 : 0;

    for (let pi = 0; pi < paragraphs.length; pi++) {
      const p = paragraphs[pi];

      const isLabel = /:\s*$/.test(p) && p.length <= 180;
      if (isLabel) {
        outParasProtected.push(p);
        continue;
      }

      const sentences = splitSentencesForRewrite(p);
      meta.sentences += sentences.length;

      const outSents = [];
      for (let si = 0; si < sentences.length; si++) {
        const sent = sentences[si].trim();
        if (!sent) continue;

        const wc = wordCount(sent);
        const shouldRewrite = wc >= cfg.minWordsToRewrite;

        if (!shouldRewrite) {
          outSents.push(sent);
          continue;
        }

        const dynPredict = Math.max(160, Math.min(cfg.maxTokensCap, Math.ceil(wc * 2.0) + 60));
        const perCallMs = cfg.perCallMs + (COLD_START && pi === 0 && si < 3 ? coldBoost : 0);

        const { system, user } = buildSentencePrompt(cfg, sent);

        let candidate = null;
        try {
          candidate = await callOllamaChat(system, user, cfg, perCallMs, dynPredict);
          meta.usedLLM = true;
          meta.llmCalls++;
        } catch {
          meta.failedLLM = true;
        }

        if (candidate) candidate = sanitizeLLMSentence(candidate);

        if (candidate && validateSentenceSafe(sent, candidate, cfg)) {
          outSents.push(candidate);
          meta.llmAccepted++;
        } else {
          outSents.push(sent);
          meta.llmRejected++;
        }
      }

      outParasProtected.push(outSents.join(" "));
    }

    COLD_START = false;

    let mergedProtected = outParasProtected.join("\n\n");

    let finalText = unprotectPlaceholders(mergedProtected, placeholders);
    finalText = normalizeArtifactsForLegal(finalText);

    finalText = applyBoilerplatePlainLanguage(finalText);
    finalText = fixRegistryPhrasing(finalText);
    finalText = dedupeBensLabel(finalText);
    finalText = fixNumberedHeadings(addStructuralBreaks(finalText));
    finalText = postStructure(finalText);
    finalText = bulletizeConfrontando(finalText);
    finalText = dropDanglingCurrencyDuplicates(finalText);

    finalText = annotateFirstOccurrences(finalText);

    if (!validateIntegrity(raw0, finalText, { mode: "strict" })) {
      meta.integrityWarning =
        "Alguns termos/números podem ter mudado; revise principalmente nomes, datas e referências.";
    }

    if (redactPII) finalText = redactPIIText(finalText);

    meta.outWords = wordCount(finalText);
    meta.ms = Date.now() - t0;
    return { blocks: [finalText], meta };
  }

  // ------------------------
  // MODE: condense (medium/strong)
  // ------------------------
  const chunks = splitIntoChunksByWords(structuredProtected, 520, 1050);
  meta.paragraphs = chunks.length;

  const phIndex = buildPlaceholderIndex(placeholders);
  const outChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const ow = Math.max(1, wordCount(chunk));

    const targetWords = Math.max(
      cfg.reduceHint === "forte" ? 85 : 120,
      Math.round(ow * cfg.targetRatio)
    );

    const { required: requiredPH, origSet } = pickRequiredPlaceholdersForChunk(chunk, phIndex);

    // Force short generation by limiting num_predict ~ 2.0 * words (tokens)
    const numPredict = Math.max(
      220,
      Math.min(cfg.maxTokensCap, Math.round(targetWords * (cfg.reduceHint === "forte" ? 2.0 : 2.2)))
    );

    const { system, user } = buildCondensePrompt(cfg, chunk, targetWords, requiredPH);

    let best = "";
    let bestRatio = 9e9;
    let accepted = false;

    try {
      meta.usedLLM = true;

      // Up to 2 tries; if still not shrinking enough -> heuristic fallback guarantees shrink
      for (let pass = 0; pass < 2; pass++) {
        meta.llmCalls++;

        const perCallMs = cfg.perCallMs + (COLD_START && i === 0 ? 14000 : 0);
        const rawOut = await callOllamaChat(system, user, cfg, perCallMs, numPredict);
        const cand = sanitizeLLMBlock(rawOut);

        if (!cand) continue;
        if (!candidateOkForCondense(chunk, cand, cfg, requiredPH, origSet)) continue;

        const cw = Math.max(1, wordCount(cand));
        const ratio = cw / ow;

        if (ratio < bestRatio) {
          best = cand;
          bestRatio = ratio;
          accepted = true;
        }

        if (cfg.reduceHint === "forte" && ratio <= 0.50) break;
        if (cfg.reduceHint !== "forte" && ratio <= 0.65) break;
      }
    } catch {
      meta.failedLLM = true;
    }

    if (accepted) {
      outChunks.push(best);
      meta.llmAccepted++;
    } else {
      // GUARANTEED SHRINK fallback
      const h = heuristicCondenseProtectedChunk(chunk, cfg, phIndex, targetWords);
      outChunks.push(h);
      meta.llmRejected++;
      meta.llmHeuristicFallback++;
    }
  }

  COLD_START = false;

  let mergedProtected = outChunks.join("\n\n");

  // If still not smaller overall, apply one more pass of heuristic over the merged text
  const mergedWords = wordCount(mergedProtected);
  const desiredMax =
    lvl === "strong"
      ? Math.round(meta.origWords * 0.55)
      : Math.round(meta.origWords * 0.80);

  if (mergedWords > desiredMax) {
    const forced = heuristicCondenseProtectedChunk(
      mergedProtected,
      cfg,
      phIndex,
      Math.max(180, Math.round(meta.origWords * cfg.targetRatio))
    );
    mergedProtected = forced;
    meta.llmHeuristicFallback++;
  }

  let finalText = unprotectPlaceholders(mergedProtected, placeholders);
  finalText = normalizeArtifactsForLegal(finalText);

  finalText = applyBoilerplatePlainLanguage(finalText);
  finalText = fixRegistryPhrasing(finalText);
  finalText = dedupeBensLabel(finalText);
  finalText = fixNumberedHeadings(addStructuralBreaks(finalText));
  finalText = postStructure(finalText);
  finalText = bulletizeConfrontando(finalText);
  finalText = dropDanglingCurrencyDuplicates(finalText);

  finalText = annotateFirstOccurrences(finalText);

  if (!validateIntegrity(raw0, finalText, { mode: "summary" })) {
    meta.integrityWarning =
      "Saída resumida: pode ter omitido detalhes (ex.: qualificações/PII). Revise datas, valores e referências legais.";
  }

  if (redactPII) finalText = redactPIIText(finalText);

  meta.outWords = wordCount(finalText);
  meta.ms = Date.now() - t0;
  return { blocks: [finalText], meta };
}
