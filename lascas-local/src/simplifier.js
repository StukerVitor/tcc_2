import axios from "axios";
import {
  asString,
  protectPlaceholders,
  unprotectPlaceholders,
  normalizeArtifactsForLegal,
  splitSentencesProtected,
  prepareTextForProfile,
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
    temperature: 0.10,
    reduceHint: "leve",
    minWordsToRewrite: 8,
    perCallMs: 24000,
    maxTokensCap: 520,
    minDelta: 0.05,
    minLenRatio: 0.60,
    maxLenRatio: 1.35,
  },

  medium: {
    mode: "condense",
    temperature: 0.14,
    reduceHint: "médio",
    perCallMs: 52000,
    maxTokensCap: 950,
    targetRatio: 0.68,
    acceptMaxRatio: 0.96,
  },

  strong: {
    mode: "condense",
    temperature: 0.16,
    reduceHint: "forte",
    perCallMs: 65000,
    maxTokensCap: 820,
    targetRatio: 0.52,
    acceptMaxRatio: 0.86,
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

function detectDocumentProfile(text) {
  const s = normalizeForCompare(text);

  if (/(invent[aá]rio|espolio|espólio|herdeir|partilha|inventariante|itcmd|itcdm|arrolamento dos bens|testamento)/i.test(s)) {
    return "inventory";
  }

  if (/(peti[cç][aã]o inicial|dos fatos|dos pedidos|valor da causa|parte autora|parte ré|requerente|requerid[oa]|autor(?:a)?\b|r[eé]u\b)/i.test(s)) {
    return "petition";
  }

  if (/(locador|locat[aá]rio|fiador|contrato de loca[cç][aã]o|alugu[eé]l|cl[aá]usula|apartamento|im[oó]vel locado)/i.test(s)) {
    return "lease";
  }

  if (/(contratante|contratada|doravante|lei de licita[cç][oõ]es|art\.?\s*75|inciso\s+viii|gestor[ae]? do contrato|fiscal do contrato|prestação de servi[cç]os?|objeto contratual)/i.test(s)) {
    return "ti_contract";
  }

  if (/(senten[cç]a|reclamante|reclamada|vara do trabalho|tribunal regional do trabalho|trt|contesta[cç][aã]o|fase de instru[cç][aã]o|fundamenta[cç][aã]o|dispositivo)/i.test(s)) {
    return "labor";
  }

  return "generic";
}

function profilePromptNotes(profile, level) {
  if (profile === "inventory") {
    return [
      "Destaque bens, valores, partilha final e ITCMD/ITCDM quando existirem.",
      "Não omita bens do espólio.",
      "Quando houver partilha, informe o percentual e o valor recebido por cada herdeiro.",
      "Não dê destaque à CNIB ou a certidões do CNIB, salvo se forem decisivas para o resultado."
    ];
  }

  if (profile === "labor") {
    return [
      "Explique tribunal ou rito só uma vez, sem repetir assinatura eletrônica.",
      "Resuma a fundamentação sem copiar trechos longos literalmente.",
      "Inclua obrigatoriamente o dispositivo, resultado ou comando final da sentença quando ele aparecer.",
      "Mantenha claros os papéis de reclamante e reclamada."
    ];
  }

  if (profile === "lease") {
    return [
      "Ignore cabeçalhos repetidos e comece o conteúdo útil a partir do texto contratual, como 'Pelo presente' ou das cláusulas.",
      "Não altere a qualificação das partes; em nível leve, preserve-a sem parafrasear.",
      "Preserve o número do apartamento, unidade, box ou vaga quando existirem.",
      "Não generalize os papéis: mantenha locador, locatário e fiador.",
      "Resuma as cláusulas em linguagem mais acessível, sem copia e cola desnecessário.",
      "Se houver cláusulas numeradas, não omita indevidamente cláusulas 3, 4 e 5."
    ];
  }

  if (profile === "ti_contract") {
    return [
      "Ignore cabeçalhos repetidos e comece o conteúdo útil no texto contratual e nas cláusulas.",
      "Preserve contratante, contratada e doravante com sentido correto.",
      "Mencione de forma clara a base legal relevante, incluindo art. 75, inciso VIII, da Lei de Licitações, quando estiver no texto.",
      "No nível médio, inclua de forma resumida as cláusulas 4, 5, 6, 7 e 10 quando existirem.",
      "No nível forte, inclua ao menos um resumo das cláusulas 2, 3, 4 e 10 quando existirem."
    ];
  }

  if (profile === "petition") {
    return [
      "Mantenha os nomes da parte autora e da parte ré, sem repetir toda a qualificação.",
      "Remova jurisprudências extensas e transcrições literais de dispositivos legais; quando útil, cite apenas números de artigos.",
      "Preserve a coerência entre páginas e una trechos que continuem a mesma ideia.",
      "Inclua o valor da causa no final quando ele aparecer no documento."
    ];
  }

  return level === "light"
    ? ["Simplifique a linguagem sem copiar literalmente trechos longos."]
    : ["Resuma mantendo os fatos, valores, datas, percentuais e resultado principal."];
}

function splitParagraphs(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function isContractProfile(profile) {
  return profile === "lease" || profile === "ti_contract";
}

function looksLikeQualificationParagraph(paragraph, profile) {
  const p = normalizeForCompare(paragraph);
  if (profile === "lease") {
    return /(locador|locat[aá]rio|fiador)/i.test(p) && /(cpf|cnpj|inscrit|residente|domiciliad|doravante|neste ato)/i.test(p);
  }
  if (profile === "ti_contract") {
    return /(contratante|contratada)/i.test(p) && /(cpf|cnpj|inscrit|sede|doravante|neste ato)/i.test(p);
  }
  return false;
}

function shouldPreserveParagraphVerbatim(paragraph, profile, level) {
  if (level !== "light") return false;
  if (!isContractProfile(profile)) return false;
  return looksLikeQualificationParagraph(paragraph, profile);
}

function firstContractClauseIndex(paragraphs, profile) {
  const clauseRe = profile === "lease"
    ? /\b(cl[aá]usula\s+primeira|cl[aá]usula\s+1|cl[aá]usula\s+segunda|cl[aá]usula\s+terceira|do objeto|objeto da loca[cç][aã]o)\b/i
    : /\b(cl[aá]usula\s+primeira|cl[aá]usula\s+1|cl[aá]usula\s+segunda|do objeto|objeto do contrato)\b/i;
  return paragraphs.findIndex((p) => clauseRe.test(p));
}

function shouldPreserveContractIntroParagraph(paragraphs, idx, profile, level) {
  if (level !== "light" || !isContractProfile(profile)) return false;
  const clauseIdx = firstContractClauseIndex(paragraphs, profile);
  if (clauseIdx <= 0) return false;
  return idx < clauseIdx;
}

function removeContractHeaderResidue(text, profile) {
  if (!isContractProfile(profile)) return String(text ?? "").trim();

  return splitParagraphs(text)
    .filter((p) => {
      const short = p.replace(/\s+/g, " ").trim();
      if (!short) return false;
      if (/\b(pelo presente|cl[aá]usula|contratante|contratada|locador|locat[aá]rio|fiador)\b/i.test(short)) return true;
      if (/\b(estado do rio grande do sul|munic[ií]pio de nova esperan[cç]a|cidade das arauc[aá]rias|secretaria municipal de compras e contratos|semcc|avenida das arauc[aá]rias|telefone \(51\)|cep\s*90\.120-200|4º andar|centro - nova esperan[cç]a)\b/i.test(short)) {
        return false;
      }
      return !/\b(prefeitura|munic[ií]pio|secretaria|processo administrativo|licita[cç][aã]o|p[aá]gina|telefone|cep\s*\d|endere[cç]o)\b/i.test(short);
    })
    .join("\n\n")
    .trim();
}

function removePetitionJurisprudenceNoise(text, level) {
  return splitParagraphs(text)
    .filter((p) => {
      if (/\b(jurisprud[eê]ncia|ac[oó]rd[aã]o|precedente|s[úu]mula|tema repetitivo|stj|stf|trf|tjrs|tst)\b/i.test(p) && p.length > 150) {
        return false;
      }
      if (/^["“].{120,}["”]$/su.test(p.trim())) return false;
      if (level !== "light" && /\bart\.?\s*\d+/i.test(p) && /(constitui[cç][aã]o|c[oó]digo|lei)/i.test(p) && p.length > 240) {
        return false;
      }
      return true;
    })
    .join("\n\n")
    .trim();
}

function cleanPartyName(name) {
  return String(name ?? "")
    .replace(/\b(cpf|cnpj|rg|ssp|residente|domiciliad[oa]|com sede|inscrit[oa]|brasileir[oa]|casad[oa]|solteir[oa]|estado civil|profiss[aã]o|cep|endere[cç]o)\b[\s\S]*$/i, "")
    .replace(/[;:,.-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikePersonName(name) {
  const cleaned = cleanPartyName(name)
    .replace(/^[^A-ZÁÉÍÓÚÂÊÔÃÕÇ]+/iu, "")
    .trim();
  if (!cleaned) return false;
  if (cleaned.split(/\s+/).length < 2) return false;
  if (/\b(excelent[ií]ssimo|juiz|vara|comarca|processo|peti[cç][aã]o|autor|r[eé]u|parte|pedido|valor da causa)\b/i.test(cleaned)) return false;
  return /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'`.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'`.-]+)+$/u.test(cleaned);
}

function extractLabeledParty(text, rolePatterns) {
  const lines = String(text ?? "").split(/\n+/);
  for (const line of lines) {
    for (const re of rolePatterns) {
      const m = line.match(re);
      if (m?.[1]) {
        const name = cleanPartyName(m[1]);
        if (looksLikePersonName(name)) return name;
      }
    }
  }
  return "";
}

function extractPartyByContext(text, patterns) {
  const body = String(text ?? "").replace(/\s+/g, " ");
  for (const re of patterns) {
    const m = body.match(re);
    if (m?.[1]) {
      const name = cleanPartyName(m[1].replace(/\s+/g, " "));
      if (looksLikePersonName(name)) return name;
    }
  }
  return "";
}

function extractPetitionParties(text) {
  const author = extractLabeledParty(text, [
    /(?:parte autora|autora?|requerente|reclamante)\s*[:\-]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][^;,.\n]{4,120})/iu,
  ]) || extractPartyByContext(text, [
    /([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+){1,5})\s*,\s*(?:já\s+qualificad[oa]|brasileir[oa]|por\s+seu\s+advogado|vem\s+[àa]\s+presen[cç]a)/iu,
    /([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+){1,5})\s*,[^\n]{0,180}?\bprop[oõ]e\b/iu,
  ]);

  const defendant = extractLabeledParty(text, [
    /(?:parte ré|r[eé]u|requerid[oa]|reclamad[oa])\s*[:\-]\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][^;,.\n]{4,120})/iu,
  ]) || extractPartyByContext(text, [
    /em\s+face\s+de\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+){1,6})\s*,\s*(?:pessoa|pessoa jurídica|inscrit[ao]|com\s+sede|brasileir[oa]|pelos\s+fatos|pelos\s+motivos)/iu,
    /em\s+desfavor\s+de\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'`.-]+){1,6})/iu,
  ]);

  return { author, defendant };
}

function extractArticleReferenceList(text) {
  const refs = [];
  const seen = new Set();
  const matches = String(text ?? "").match(/\bart\.?\s*\d+[A-Za-zº°]*\b/giu) || [];
  for (const raw of matches) {
    const norm = raw.toLowerCase().replace(/\s+/g, " ").replace(/art\.?\s*/i, "").trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    refs.push(norm);
  }
  return refs;
}

function firstSentenceOfParagraphMatching(text, re) {
  const para = splitParagraphs(text).find((p) => re.test(p));
  if (!para) return "";
  return firstMeaningfulSentence(para, 2);
}

function normalizeSentenceKey(s) {
  return normalizeForCompare(String(s ?? ""))
    .replace(/[.;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeRepeatedSentences(text) {
  const parts = splitParagraphs(text);
  const seen = new Set();
  const out = [];

  for (const p of parts) {
    const sents = splitSentencesProtected(p).map((x) => String(x || "").trim()).filter(Boolean);
    if (!sents.length) {
      const key = normalizeSentenceKey(p);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      continue;
    }

    const kept = [];
    for (const sent of sents) {
      const key = normalizeSentenceKey(sent);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      kept.push(sent);
    }
    if (kept.length) out.push(kept.join(" "));
  }

  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function removeIrrelevantCNIB(text) {
  return splitParagraphs(text)
    .filter((p) => !/\bCNIB\b/i.test(p))
    .join("\n\n")
    .trim();
}

function removeRedundantDigitalSignatureMentions(text) {
  let seen = false;
  return splitParagraphs(text)
    .filter((p) => {
      if (/(assinad[oa]\s+eletronicamente|assinatura\s+eletr[oô]nica|documento\s+assinado\s+eletronicamente|c[oó]digo\s+de\s+verifica[cç][aã]o)/i.test(p)) {
        if (seen) return false;
        seen = true;
      }
      return true;
    })
    .join("\n\n")
    .trim();
}

function removeDanglingQualificationFragments(text, profile) {
  return splitParagraphs(text)
    .filter((p) => {
      const short = p.replace(/\s+/g, " ").trim();
      if (!short) return false;
      if (profile === "ti_contract") {
        if (/^\d{5}-\d{3},?\s+inscrit[ao]\s+no\b/i.test(short)) return false;
        if (/^(inscrit[ao]\s+no|com sede\s+em|cep\s*\d{5}-\d{3})\b/i.test(short) && !/\b(contratante|contratada)\b/i.test(short)) return false;
      }
      if (profile === "lease") {
        if (/^(inscrit[ao]\s+no|residente\s+e\s+domiciliad[oa]|cep\s*\d{5}-\d{3})\b/i.test(short) && !/\b(locador|locat[aá]rio|fiador)\b/i.test(short)) return false;
      }
      return true;
    })
    .join("\n\n")
    .trim();
}

function removeKnownOutOfScopeLeaseNoise(text, originalText) {
  const original = normalizeForCompare(originalText);
  return splitParagraphs(text)
    .filter((p) => {
      const short = p.replace(/\s+/g, " ").trim();
      if (!short) return false;
      if (/\b(cheias|calamidade|bloco cir[úu]rgico|vigil[aâ]ncia sanit[aá]ria|conselho regional de medicina veterin[aá]ria|mobili[aá]rios em geral|grandes avarias)\b/i.test(short)) {
        const keyTerms = ["cheias", "calamidade", "bloco cirúrgico", "vigilância sanitária", "medicina veterinária", "grandes avarias"];
        const appears = keyTerms.some((t) => original.includes(normalizeForCompare(t)));
        if (!appears) return false;
      }
      return true;
    })
    .join("\n\n")
    .trim();
}

function extractLikelyNames(text) {
  const stop = new Set([
    "ASSINATURA", "ASSINATURAS", "OUTORGANTE", "OUTORGANTES", "OUTORGADO", "OUTORGADOS",
    "INTERVENIENTE", "INTERVENIENTES", "ASSISTENTE", "ASSISTENTES", "HERDEIRO", "HERDEIROS",
    "TABELIÃO", "TABELIAO", "ESCREVENTE", "CNIB"
  ]);

  const matches = String(text ?? "").match(/\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç']+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç']+){1,5}\b/g) || [];
  const out = [];
  const seen = new Set();

  for (const raw of matches) {
    const name = raw.replace(/\s+/g, " ").trim();
    const tokens = name.split(" ");
    if (tokens.every((t) => stop.has(t.toUpperCase()))) continue;
    if (tokens.length < 2) continue;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  return out;
}

function compactSignatureBlocks(text, level, profile) {
  const shouldKeepNames = level === "strong" || profile === "inventory";
  return String(text ?? "").replace(
    /(^|\n\n)\s*(ASSINATURAS?:)\s*\n([\s\S]*?)(?=\n\n(?:[A-ZÀ-Ý][A-ZÀ-Ý0-9 .'"ºª-]{2,}:|\d+\.|CL[AÁ]USULA\s+[A-ZÀ-Ý]+|$))/giu,
    (_m, p1, label, body) => {
      if (!shouldKeepNames) return p1 || "";
      const names = extractLikelyNames(body);
      if (!names.length) return `${p1 || ""}${label}`;
      return `${p1 || ""}${label}\nAssinam: ${names.join("; ")}.`;
    }
  ).trim();
}

function paragraphPriority(paragraph, profile, level) {
  const p = normalizeForCompare(paragraph);
  let score = 0;

  if (!p) return score;
  if (isHeadingLike(paragraph)) score += 2;
  if (/r\$|%|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}\s+de\s+[a-zçáéíóúâêôãõ]+\s+de\s+\d{4}\b/i.test(paragraph)) score += 3;
  if (/\bprocesso\b|\bmatr[ií]cula\b|\bregistro\b|\blivro\b|\bart\.?\b|\blei\b/i.test(p)) score += 2;

  if (profile === "inventory") {
    if (/\bbens?\b|\barrolamento\b|\bpartilha\b|\bherdeir\b|\besp[oó]lio\b|\binvent[aá]rio\b|\binventariante\b|\bitcmd\b|\bitcdm\b|\btestamento\b/i.test(p)) score += 6;
  } else if (profile === "labor") {
    if (/\bdispositivo\b|\bante o exposto\b|\bjulgo\b|\bcondeno\b|\bprocedent\b|\bimprocedent\b|\bdefiro\b|\bindefiro\b|\bcustas\b|\breclamante\b|\breclamada\b|\bfundamenta[cç][aã]o\b|\bm[eé]rito\b/i.test(p)) score += 6;
  } else if (profile === "lease") {
    if (/\bcl[aá]usula\b|\blocador\b|\blocat[aá]rio\b|\bfiador\b|\balugu[eé]l\b|\bprazo\b|\breajuste\b|\bmulta\b|\brescis[aã]o\b|\bapartamento\b|\bunidade\b|\bgarantia\b/i.test(p)) score += 6;
    if (/\bcl[aá]usula\s+(terceira|quarta|quinta)\b|\b3[.)-]\b|\b4[.)-]\b|\b5[.)-]\b/i.test(p)) score += 3;
  } else if (profile === "ti_contract") {
    if (/\bcontratante\b|\bcontratada\b|\bobjeto\b|\bpagamento\b|\bpenalidades\b|\bvig[eê]ncia\b|\bgestor[ae]? do contrato\b|\bfiscal do contrato\b|\blei de licita[cç][oõ]es\b|\bart\.?\s*75\b/i.test(p)) score += 6;
    if (/\bcl[aá]usula\s+(segunda|terceira|quarta|quinta|sexta|s[eé]tima|d[eé]cima)\b|\b(?:2|3|4|5|6|7|10)(?:[.)-]|\.\d)/i.test(p)) score += 4;
  } else if (profile === "petition") {
    if (/\b(parte autora|autor(?:a)?|requerente|reclamante|parte ré|r[eé]u|requerid[oa]|reclamad[oa])\b|\bpedidos?\b|\bvalor da causa\b|\bfatos\b|\bcausa de pedir\b|\brequer\b/i.test(p)) score += 6;
    if (/\bart\.?\s*\d+\b/i.test(p) && p.length < 160) score += 2;
  }

  if (level === "strong" && /\bdispositivo\b|\bpartilha\b|\bitcmd\b|\bitcdm\b|\bfiador\b|\bvalor da causa\b/i.test(p)) score += 2;

  return score;
}

function firstMeaningfulSentence(paragraph, limit = 2) {
  const sents = splitSentencesProtected(paragraph).map((x) => String(x || "").trim()).filter(Boolean);
  return sents.slice(0, limit).join(" ").trim() || String(paragraph || "").trim();
}

function appendMissingParagraph(finalParas, paragraph) {
  const key = normalizeForCompare(firstMeaningfulSentence(paragraph, 1)).slice(0, 120);
  const exists = finalParas.some((p) => normalizeForCompare(p).includes(key) || key.includes(normalizeForCompare(firstMeaningfulSentence(p, 1)).slice(0, 60)));
  if (!exists) finalParas.push(paragraph.trim());
}

function ensureInventoryCoverage(finalText, originalText, level) {
  const finalParas = splitParagraphs(finalText);
  const originalParas = splitParagraphs(originalText);

  const needsBens = !/\bbens\b|\barrolamento\b/i.test(finalText);
  const needsPartilha = !/\bpartilha\b|\bherdeir\b/i.test(finalText);
  const needsTax = !/\bitcmd\b|\bitcdm\b/i.test(finalText);

  for (const p of originalParas) {
    if (needsBens && /\bbens\b|\barrolamento\b/i.test(p)) appendMissingParagraph(finalParas, p);
    if (needsPartilha && /\bpartilha\b|\bherdeir\b/i.test(p)) appendMissingParagraph(finalParas, p);
    if (needsTax && /\bitcmd\b|\bitcdm\b/i.test(p)) appendMissingParagraph(finalParas, p);
  }

  let out = finalParas.join("\n\n").trim();
  if (level === "strong" && /\bassinaturas?:\b/i.test(originalText) && !/\bassinaturas?:\b/i.test(out)) {
    const sig = splitParagraphs(originalText).find((p) => /\bassinaturas?:\b/i.test(p));
    if (sig) out += `\n\n${sig}`;
  }
  return out;
}

function ensureLaborCoverage(finalText, originalText) {
  const finalParas = splitParagraphs(finalText);
  const originalParas = splitParagraphs(originalText);

  const hasDispositivo = /\bdispositivo\b|\bante o exposto\b|\bjulgo\b|\bcondeno\b|\bprocedent\b|\bimprocedent\b|\bdefiro\b|\bindefiro\b/i.test(finalText);
  if (!hasDispositivo) {
    for (const p of originalParas) {
      if (/\bdispositivo\b|\bante o exposto\b|\bjulgo\b|\bcondeno\b|\bprocedent\b|\bimprocedent\b|\bdefiro\b|\bindefiro\b|\bcustas\b/i.test(p)) {
        appendMissingParagraph(finalParas, p);
      }
    }
  }

  return finalParas.join("\n\n").trim();
}

function ensureLeaseCoverage(finalText, originalText) {
  const finalParas = splitParagraphs(finalText);
  const originalParas = splitParagraphs(originalText);

  const clauseNeeds = [
    { key: /\b(cl[aá]usula\s+terceira|3[.)-])\b/i, has: /\b(cl[aá]usula\s+terceira|3[.)-])\b/i.test(finalText) },
    { key: /\b(cl[aá]usula\s+quarta|4[.)-])\b/i, has: /\b(cl[aá]usula\s+quarta|4[.)-])\b/i.test(finalText) },
    { key: /\b(cl[aá]usula\s+quinta|5[.)-])\b/i, has: /\b(cl[aá]usula\s+quinta|5[.)-])\b/i.test(finalText) },
  ];

  for (const p of originalParas) {
    for (const clause of clauseNeeds) {
      if (!clause.has && clause.key.test(p)) appendMissingParagraph(finalParas, p);
    }
  }

  const mustRoles = [
    { src: /\blocador\b/i, dst: /\blocador\b/i },
    { src: /\blocat[aá]rio\b/i, dst: /\blocat[aá]rio\b/i },
    { src: /\bfiador\b/i, dst: /\bfiador\b/i },
  ];

  for (const role of mustRoles) {
    if (role.src.test(originalText) && !role.dst.test(finalText)) {
      const para = originalParas.find((p) => role.src.test(p));
      if (para) appendMissingParagraph(finalParas, para);
    }
  }

  return finalParas.join("\n\n").trim();
}

function extractTIContractParties(text) {
  const body = String(text ?? "").replace(/\s+/g, " ");
  const partyAfterLabel = (label) => {
    const m = body.match(new RegExp(`${label}[^A-ZÁÉÍÓÚÂÊÔÃÕÇ]{0,30}([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'` + "`.-]+(?:\\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇa-záéíóúâêôãõç'` + "`.-]+){1,7})`, "iu"));
    const name = cleanPartyName(m?.[1] || "");
    return looksLikePersonName(name) ? name : "";
  };
  return {
    contratante: partyAfterLabel("CONTRATANTE"),
    contratada: partyAfterLabel("CONTRATADA"),
  };
}

function ensureTIContractCoverage(finalText, originalText, level) {
  let finalParas = splitParagraphs(finalText);
  const originalParas = splitParagraphs(originalText);

  const mustClauses = level === "strong"
    ? [2, 3, 4, 10]
    : [4, 5, 6, 7, 10];

  const clauseRes = {
    2: /\b(cl[aá]usula\s+segunda|2(?:\.\d+)?[.)-]?)\b/i,
    3: /\b(cl[aá]usula\s+terceira|3(?:\.\d+)?[.)-]?)\b/i,
    4: /\b(cl[aá]usula\s+quarta|4(?:\.\d+)?[.)-]?)\b/i,
    5: /\b(cl[aá]usula\s+quinta|5(?:\.\d+)?[.)-]?)\b/i,
    6: /\b(cl[aá]usula\s+sexta|6(?:\.\d+)?[.)-]?)\b/i,
    7: /\b(cl[aá]usula\s+s[eé]tima|7(?:\.\d+)?[.)-]?)\b/i,
    10: /\b(cl[aá]usula\s+d[eé]cima|10(?:\.\d+)?[.)-]?)\b/i,
  };

  const parties = extractTIContractParties(originalText);
  const intro = [];
  if (parties.contratante) intro.push(`Contratante: ${parties.contratante}.`);
  if (parties.contratada) intro.push(`Contratada: ${parties.contratada}.`);
  if (intro.length) {
    const introText = intro.join(" ");
    finalParas = finalParas.filter((p) => !/^\s*(Contratante:|Contratada:)/i.test(p));
    finalParas.unshift(introText);
  }

  for (const n of mustClauses) {
    const re = clauseRes[n];
    if (!re) continue;
    if (re.test(finalParas.join("\n\n"))) continue;
    const para = originalParas.find((q) => re.test(q));
    if (para) finalParas.push(para);
  }

  if (/art\.?\s*75/i.test(originalText) && !/art\.?\s*75/i.test(finalParas.join("\n\n"))) {
    const para = originalParas.find((q) => /art\.?\s*75|inciso\s+viii|lei de licita[cç][oõ]es/i.test(q));
    if (para) finalParas.push(para);
  }

  const out = finalParas.join("\n\n").trim();
  return removeDanglingQualificationFragments(out, "ti_contract");
}

function ensurePetitionCoverage(finalText, originalText, level) {
  let out = String(finalText ?? "").trim();
  const finalParas = splitParagraphs(out);
  const parties = extractPetitionParties(originalText);

  if (parties.author && !new RegExp(parties.author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(out)) {
    finalParas.unshift(`Parte autora: ${parties.author}.`);
  }
  if (parties.defendant && !new RegExp(parties.defendant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(finalParas.join("\n\n"))) {
    const label = `Parte ré: ${parties.defendant}.`;
    if (finalParas.length) finalParas.splice(Math.min(1, finalParas.length), 0, label);
    else finalParas.push(label);
  }

  out = finalParas.join("\n\n").trim();

  if (/valor\s+da\s+causa/i.test(originalText) && !/valor\s+da\s+causa/i.test(out)) {
    const sentence = firstSentenceOfParagraphMatching(originalText, /valor\s+da\s+causa/i);
    if (sentence) out += `${out ? "\n\n" : ""}${sentence}`;
  }

  if (level !== "strong") {
    const refs = extractArticleReferenceList(originalText);
    if (refs.length && !/refer[êe]ncias legais:/i.test(out)) {
      out += `${out ? "\n\n" : ""}Referências legais: arts. ${refs.join(", ")}.`;
    }
  }

  return out.trim();
}

function applyProfilePostProcessing(finalText, originalStructuredPlain, profile, level) {
  let out = String(finalText ?? "").trim();

  out = dedupeRepeatedSentences(out);
  out = removeContractHeaderResidue(out, profile);
  out = removeDanglingQualificationFragments(out, profile);

  if (profile === "inventory") out = removeIrrelevantCNIB(out);
  if (profile === "labor") out = removeRedundantDigitalSignatureMentions(out);
  if (profile === "petition") out = removePetitionJurisprudenceNoise(out, level);
  if (profile === "lease") out = removeKnownOutOfScopeLeaseNoise(out, originalStructuredPlain);

  if (profile === "inventory") out = ensureInventoryCoverage(out, originalStructuredPlain, level);
  if (profile === "labor") out = ensureLaborCoverage(out, originalStructuredPlain);
  if (profile === "lease") out = ensureLeaseCoverage(out, originalStructuredPlain);
  if (profile === "ti_contract") out = ensureTIContractCoverage(out, originalStructuredPlain, level);
  if (profile === "petition") out = ensurePetitionCoverage(out, originalStructuredPlain, level);

  out = compactSignatureBlocks(out, level, profile);
  out = dedupeRepeatedSentences(out);
  out = removeContractHeaderResidue(out, profile);
  out = removeDanglingQualificationFragments(out, profile);

  return out.trim();
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

  out = out.replace(/(\d{3})\.\d{3}\.\d{3}-(\d{2})/g, (_m, a, last2) => `${a}.***.***-${last2}`);
  out = out.replace(/(\d{2})\.\d{3}\.\d{3}\/\d{4}-(\d{2})/g, (_m, a, last2) => `${a}.***.***/****-${last2}`);
  out = out.replace(/(matr[ií]cula\s*(?:n[ºo.]*)?\s*)(\d[\d.\-/]*)/giu, (_m, p1) => `${p1}***`);
  out = out.replace(/((?:certid[aã]o|registro|termo|livro|folha)\s*(?:n[ºo.]*)?\s*)(\d[\d.\-/]*)/giu, (_m, p1) => `${p1}***`);
  out = out.replace(/((?:testamento\s*(?:p[uú]blico\s*)?(?:sob\s+o\s+)?n[ºo.]?\s*))(\d[\d.\-/]*)/giu, (_m, p1) => `${p1}***`);
  out = out.replace(/((?:[oó]bito\s*(?:sob\s+o\s+)?n[ºo.]?\s*))(\d[\d.\-/]*)/giu, (_m, p1) => `${p1}***`);
  out = out.replace(/(\d{7,}(?:[-./]\d+)*)/g, "***");

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

function buildSentencePrompt(cfg, sentenceProtected, profile = "generic") {
  const extra = profilePromptNotes(profile, "light");

  const system = [
    "Você é um simplificador jurídico PT-BR em Linguagem Simples.",
    "",
    "Regras:",
    "1) NÃO altere placeholders [[[LASCAS_*_####]]].",
    "2) Preserve exatamente números, datas, valores, prazos, negações, nomes próprios e referências oficiais.",
    "3) Não invente nem omita informações. Não troque sentidos.",
    "4) Você pode encurtar levemente a frase quando isso melhorar a clareza, sem perder fatos essenciais.",
    "5) Não use prefácios. Retorne só o texto.",
    "6) Retorne UMA única frase em uma linha (sem bullets, sem títulos).",
    ...extra.map((x, i) => `${i + 7}) ${x}`),
    `INTENSIDADE: ${cfg.reduceHint}`,
  ].join("\n");

  const user = [
    "Reescreva a frase abaixo de modo mais simples, mantendo TODAS as informações essenciais e preservando placeholders:",
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

  if (!validateIntegrity(origProt, outProt, { mode: "relaxed" })) return false;
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

function buildCondensePrompt(cfg, chunkProtected, targetWords, requiredPH = [], profile = "generic") {
  const extra = profilePromptNotes(profile, cfg.reduceHint === "forte" ? "strong" : "medium");

  const sys = [
    "Você é um simplificador jurídico PT-BR em Linguagem Simples.",
    "",
    "OBJETIVO: condensar o trecho com clareza, sem inventar fatos e sem omitir o que muda o entendimento do documento.",
    `META: cerca de ${targetWords} palavras; pode passar um pouco se isso evitar omissões importantes.`,
    "",
    "Priorize manter apenas o essencial:",
    "- tipo do ato / decisão / declaração;",
    "- quem são as partes e o papel de cada uma;",
    "- bens, obrigações, resultado prático e efeito jurídico;",
    "- datas, valores, percentuais, prazos;",
    "- referências oficiais (processo/matrícula/R/1/Livro/Lei/art.).",
    "",
    "Você PODE OMITIR quando não forem essenciais:",
    "- CPF, RG, órgão expedidor, endereço completo, CEP, naturalidade, profissão, filiação e fórmulas cartorárias repetitivas.",
    "",
    "Regras obrigatórias:",
    "1) NÃO altere placeholders [[[LASCAS_*_####]]]. Copie exatamente se usar.",
    "2) NÃO invente fatos, nomes, números, datas, valores, prazos ou referências.",
    "3) Preserve o sentido de negações e condições.",
    "4) NÃO use prefácios. Retorne só o texto.",
    "5) NÃO use 1ª pessoa.",
    "6) Pode usar quebras de linha curtas para organizar melhor o resultado.",
    ...extra.map((x, i) => `${i + 7}) ${x}`),
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

function sentenceHasEssentialSignals(sentence, phIndex, profile = "generic") {
  const phs = extractPlaceholderList(sentence);
  for (const ph of phs) {
    if (classifyPlaceholder(ph, phIndex) === "essential") return true;
  }

  const s = normalizeForCompare(sentence);
  const generalKw =
    /\b(im[oó]vel|bens?|valor|pagament|quita|declara|ficou|fica|invent[aá]rio|partilha|testamento|matr[ií]cula|processo|registro|livro|folha|lei|art\.?|resolu[cç][aã]o|decreto|portaria|prazo|data|apartamento|unidade|cl[aá]usula|alugu[eé]l|multa|rescis[aã]o)\b/i;
  if (generalKw.test(s)) return true;
  if (profile === "inventory" && /\b(espolio|espólio|herdeir|inventariante|itcmd|itcdm|arrolamento)\b/i.test(s)) return true;
  if (profile === "labor" && /\b(reclamante|reclamada|contesta[cç][aã]o|fundamenta[cç][aã]o|m[eé]rito|fase de instru[cç][aã]o|dispositivo|julgo|condeno|procedent|improcedent|defiro|indefiro|custas)\b/i.test(s)) return true;
  if (profile === "lease" && /\b(locador|locat[aá]rio|fiador|garantia|reajuste|vig[eê]ncia|prazo)\b/i.test(s)) return true;
  if (profile === "ti_contract" && /\b(contratante|contratada|doravante|pagamento|penalidades|vig[eê]ncia|gestor[ae]? do contrato|fiscal do contrato|lei de licita[cç][oõ]es|art\.?\s*75)\b/i.test(s)) return true;
  if (profile === "petition" && /\b(parte autora|autor(?:a)?|requerente|reclamante|parte ré|r[eé]u|requerid[oa]|reclamad[oa]|pedidos?|valor da causa|fatos|requer)\b/i.test(s)) return true;
  return false;
}

function enforceWordBudgetByDropping(textProtected, budgetWords, phIndex, profile = "generic", level = "medium") {
  let t = String(textProtected || "").trim();
  if (!t) return t;

  let paras = splitParagraphs(t);
  if (wordCount(paras.join("\n\n")) <= budgetWords) return paras.join("\n\n").trim();

  const scored = paras.map((p, i) => ({
    i,
    p,
    words: Math.max(1, wordCount(p)),
    score: paragraphPriority(p, profile, level),
    heading: isHeadingLike(p),
  }));

  const chosen = new Set();
  let used = 0;
  const tryAdd = (item) => {
    if (chosen.has(item.i)) return;
    if (used + item.words <= budgetWords || chosen.size === 0 || item.score >= 9) {
      chosen.add(item.i);
      used += item.words;
    }
  };

  for (const item of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (item.score >= 6 || item.heading) tryAdd(item);
  }
  for (const item of scored) tryAdd(item);

  let outParas = scored.filter((x) => chosen.has(x.i)).sort((a, b) => a.i - b.i).map((x) => x.p);
  if (!outParas.length) outParas = [paras[0]];

  let out = outParas.join("\n\n").trim();
  if (wordCount(out) > budgetWords) {
    const trimmed = [];
    let running = 0;
    for (const para of outParas) {
      const remaining = budgetWords - running;
      if (remaining <= 0) break;
      if (wordCount(para) <= remaining) {
        trimmed.push(para);
        running += wordCount(para);
        continue;
      }
      const sents = splitSentencesProtected(para).map((x) => String(x || "").trim()).filter(Boolean);
      const kept = [];
      for (const sent of sents) {
        if (running + wordCount(kept.join(" ") + " " + sent) > budgetWords) break;
        kept.push(sent);
      }
      if (kept.length) trimmed.push(kept.join(" ").trim());
      break;
    }
    out = trimmed.join("\n\n").trim();
  }

  return out.trim();
}

function heuristicCondenseProtectedChunk(chunkProtected, cfg, phIndex, targetWords, profile = "generic", level = "medium") {
  const paras = String(chunkProtected || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const outParas = [];
  for (const p of paras) {
    if (!p) continue;
    if (isHeadingLike(p)) {
      outParas.push(p);
      continue;
    }

    const sents = splitSentencesProtected(p).map((x) => String(x || "").trim()).filter(Boolean);
    if (!sents.length) continue;

    const kept = [];
    for (const s of sents) {
      if (sentenceHasOnlyPIIPlaceholders(s, phIndex)) continue;
      if (sentenceHasEssentialSignals(s, phIndex, profile)) kept.push(stripQualificationTailSentence(s));
    }

    if (!kept.length) {
      const fallbackLimit = ["lease", "ti_contract", "petition"].includes(profile) ? 2 : 1;
      kept.push(...sents.slice(0, fallbackLimit).map((x) => stripQualificationTailSentence(x)).filter(Boolean));
    }

    let perParaLimit = level === "strong" ? 2 : 3;
    if (profile === "inventory") perParaLimit = level === "strong" ? 3 : 4;
    if (profile === "petition") perParaLimit = level === "strong" ? 2 : 3;
    if (profile === "ti_contract") perParaLimit = level === "strong" ? 2 : 3;
    outParas.push(kept.slice(0, perParaLimit).join(" ").trim());
  }

  let out = outParas.filter(Boolean).join("\n\n").trim();
  out = enforceWordBudgetByDropping(out, Math.max(level === "strong" ? 120 : 160, targetWords), phIndex, profile, level);
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
  const profile = detectDocumentProfile(rawText);

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
    profile,
  };

  const t0 = Date.now();

  const raw0 = normalizeArtifactsForLegal(asString(rawText));
  const preparedRaw = prepareTextForProfile(raw0, profile);
  const validationSource = preparedRaw;
  const { protectedText, placeholders } = protectPlaceholders(preparedRaw);

  const preLLM = applyBoilerplatePlainLanguage(protectedText);
  const structuredProtected = fixNumberedHeadings(addStructuralBreaks(preLLM));
  const originalStructuredPlain = postStructure(fixNumberedHeadings(addStructuralBreaks(applyBoilerplatePlainLanguage(preparedRaw))));

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
      if (isLabel || shouldPreserveParagraphVerbatim(p, profile, lvl) || shouldPreserveContractIntroParagraph(paragraphs, pi, profile, lvl)) {
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

        const { system, user } = buildSentencePrompt(cfg, sent, profile);

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
    finalText = applyProfilePostProcessing(finalText, originalStructuredPlain, profile, lvl);

    if (!validateIntegrity(validationSource, finalText, { mode: "strict" })) {
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

    const { system, user } = buildCondensePrompt(cfg, chunk, targetWords, requiredPH, profile);

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
      const h = heuristicCondenseProtectedChunk(chunk, cfg, phIndex, targetWords, profile, lvl);
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
      ? Math.round(meta.origWords * 0.75)
      : Math.round(meta.origWords * 0.92);

  if (mergedWords > desiredMax) {
    const forced = heuristicCondenseProtectedChunk(
      mergedProtected,
      cfg,
      phIndex,
      Math.max(220, Math.round(meta.origWords * cfg.targetRatio)),
      profile,
      lvl
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
  finalText = applyProfilePostProcessing(finalText, originalStructuredPlain, profile, lvl);

  if (!validateIntegrity(validationSource, finalText, { mode: "summary" })) {
    meta.integrityWarning =
      "Saída resumida: pode ter omitido detalhes (ex.: qualificações/PII). Revise datas, valores e referências legais.";
  }

  if (redactPII) finalText = redactPIIText(finalText);

  meta.outWords = wordCount(finalText);
  meta.ms = Date.now() - t0;
  return { blocks: [finalText], meta };
}
