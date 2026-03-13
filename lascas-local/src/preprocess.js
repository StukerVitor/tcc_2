export function asString(x) {
  return x == null ? "" : String(x);
}

const SPC = "[\\s\\u00A0\\u202F\\u2007\\u2009\\u200A]";
const SOFT_JOIN = "[[[LASCAS_JOIN_0000]]]";

export function normalizeArtifactsForLegal(input) {
  let out = asString(input);

  out = out.replace(/\f/g, "\n");
  out = out.replace(/(\d)\s*-\s*\n\s*(\d)/g, "$1-$2");
  out = out.replace(/(?<=\d)\s+(?=\d)/g, "");
  out = out.replace(new RegExp(`(\\d{1,3}(?:\\.\\d{3})*),${SPC}*(\\d{1,3})`, "g"), "$1,$2");
  out = out.replace(/R\$\s*(\d)/g, "R$ $1");

  // IMPORTANT: avoid merging normal words like "pública é sobre".
  // Keep only a safe OCR join for ALL-CAPS words split by ALL-CAPS accented fragments.
  out = out.replace(
    /(\p{Lu}{2,})\s+([ÁÉÍÓÚÂÊÔÃÕÇ]{1,3})\s+(\p{Lu}{2,})/gu,
    "$1$2$3"
  );

  out = out.replace(/([a-záéíóúâêôãõç])([A-ZÁÉÍÓÚÂÊÔÃÕÇ])/g, "$1 $2");
  out = out.replace(/([A-Za-zÁ-ú])(\d)(:)/g, "$1 $2$3");
  out = out.replace(/(^|\n)A\s+SSINATURAS\b/g, "$1ASSINATURAS");

  out = out.replace(
    /(\p{L}{2,})([Éé])(?=(reconhecid[ao]s?|feita|feito|feitas|feitos|responsável(?:es)?|sujeit[ao]s?))/giu,
    "$1 $2"
  );
  out = out.replace(
    /([Éé])(?=(reconhecid[ao]s?|feita|feito|feitas|feitos|responsável(?:es)?|sujeit[ao]s?))/giu,
    "$1 "
  );

  out = out.replace(new RegExp(`;(?!${SPC}|\\n)`, "g"), "; ");
  out = out.replace(new RegExp(`:(?!${SPC}|\\n)`, "g"), ": ");

  out = out.replace(new RegExp(`,(?!${SPC}|\\n)`, "g"), (m, offset, str) => {
    const prev = str[offset - 1] || "";
    const next = str[offset + 1] || "";
    if (/\d/.test(prev) && /\d/.test(next)) return ",";
    return ", ";
  });

  out = out.replace(/\s+([,.;:!?%])/g, "$1");
  out = out.replace(/[ \t]{2,}/g, " ");

  return out.trim();
}

function looksLikeRepeatedHeaderParagraph(paragraph) {
  const p = asString(paragraph).replace(/\s+/g, " ").trim();
  if (!p) return false;
  if (/\bcl[aá]usula\b|\bpelo presente\b|\bcontratante\b|\bcontratada\b|\blocador\b|\blocat[aá]rio\b|\bfiador\b/i.test(p)) return false;
  return /\b(estado do rio grande do sul|munic[ií]pio|secretaria|semcc|cidade das arauc[aá]rias|avenida das arauc[aá]rias|processo administrativo|licita[cç][aã]o|p[aá]gina|telefone|endere[cç]o|cep\s*\d|nova esperan[cç]a)\b/i.test(p);
}

function normalizeHeaderLineCandidate(line) {
  return asString(line)
    .replace(/^\s*\d+\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function looksLikeRepeatedHeaderLine(line) {
  const p = normalizeHeaderLineCandidate(line);
  if (!p) return false;
  if (/\bcl[aá]usula\b|\bpelo presente\b|\bcontratante\b|\bcontratada\b|\blocador\b|\blocat[aá]rio\b|\bfiador\b/i.test(p)) return false;
  return /\b(estado do rio grande do sul|munic[ií]pio|secretaria|semcc|cidade das arauc[aá]rias|avenida das arauc[aá]rias|nova esperan[cç]a|processo administrativo|licita[cç][aã]o|telefone|cep\s*\d|4º andar|centro)\b/i.test(p);
}

function stripRepeatedContractHeaderLines(input) {
  const lines = asString(input).replace(/\r\n?/g, "\n").split("\n");
  const counts = new Map();

  for (const line of lines) {
    const key = normalizeHeaderLineCandidate(line);
    if (!key || !looksLikeRepeatedHeaderLine(line)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const out = [];
  for (const line of lines) {
    const key = normalizeHeaderLineCandidate(line);
    const repeated = key && looksLikeRepeatedHeaderLine(line) && counts.get(key) >= 1;
    if (repeated) continue;
    out.push(line);
  }

  return out.join("\n");
}

export function mergeBrokenPageText(input) {
  let out = asString(input);

  out = out.replace(/\f/g, "\n");
  out = out.replace(/(?:^|\n)\s*(?:p[aá]gina\s+\d+(?:\s+de\s+\d+)?|folha\s+\d+|\d+\s*\/\s*\d+)\s*(?=\n|$)/giu, "\n");
  out = out.replace(/(\p{L})-\n(?=\p{L})/gu, "$1");
  out = out.replace(/([,:;])\n+(?=\S)/g, "$1 ");
  out = out.replace(/([a-záéíóúâêôãõç0-9)])\n(?=[a-záéíóúâêôãõç])/giu, "$1 ");
  out = out.replace(/([a-záéíóúâêôãõç])\n(?=\d)/giu, "$1 ");
  out = out.replace(/(\d)\n(?=[a-záéíóúâêôãõç])/giu, "$1 ");
  out = out.replace(/\n{3,}/g, "\n\n");

  return normalizeArtifactsForLegal(out);
}

export function stripContractLeadHeaders(input, profile = "generic") {
  if (!["lease", "ti_contract"].includes(String(profile || ""))) {
    return normalizeArtifactsForLegal(input);
  }

  let merged = mergeBrokenPageText(input);
  merged = stripRepeatedContractHeaderLines(merged);

  const raw = merged.replace(/\r\n?/g, "\n");
  const anchorRe = profile === "lease"
    ? /\b(pelo presente|locador(?:a)?\b|locat[áa]ri[oa]\b|cl[aá]usula\s+primeira|cl[aá]usula\s+1)\b/i
    : /\b(pelo presente|contratante\b|contratada\b|cl[aá]usula\s+primeira|cl[aá]usula\s+1|objeto do contrato|do objeto)\b/i;

  const anchorMatch = raw.match(anchorRe);
  if (anchorMatch && typeof anchorMatch.index === "number" && anchorMatch.index > 0 && anchorMatch.index < Math.min(raw.length, 6000)) {
    merged = raw.slice(anchorMatch.index).trim();
  }

  let paras = merged
    .split(/\n{2,}/)
    .map((q) => q.trim())
    .filter(Boolean);

  const counts = new Map();
  for (const para of paras) {
    const key = para.replace(/\s+/g, " ").trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  paras = paras.filter((para, idx) => {
    const key = para.replace(/\s+/g, " ").trim().toLowerCase();
    if (looksLikeRepeatedHeaderParagraph(para) && counts.get(key) >= 1) return false;
    if (idx < 4 && looksLikeRepeatedHeaderParagraph(para)) return false;
    return true;
  });

  return normalizeArtifactsForLegal(paras.join("\n\n"));
}

export function prepareTextForProfile(input, profile = "generic") {
  let out = mergeBrokenPageText(input);
  if (["lease", "ti_contract"].includes(String(profile || ""))) {
    out = stripContractLeadHeaders(out, profile);
  }
  return normalizeArtifactsForLegal(out);
}

/** Placeholder protection (NUM/DATE/PERC/NEG/LAW + TERM for critical roles/phrases) */
export function protectPlaceholders(text) {
  let s = asString(text);
  const placeholders = [];
  let idx = 0;

  const put = (kind, val) => {
    const id = String(idx++).padStart(4, "0");
    const ph = `[[[LASCAS_${kind}_${id}]]]`;
    placeholders.push({ ph, val, kind });
    return ph;
  };

  // Protect critical legal role terms + fragile phrases
  const CRITICAL_TERMS = [
    /\bOUTORGANTES?\b/giu,
    /\bOUTORGADOS?\b/giu,
    /\bRECIPROCAMENTE\b/giu,
    /\bINTERVENIENTES?\b/giu,
    /\bASSISTENTES?\b/giu,
    /\bLOCADOR(?:A)?\b/giu,
    /\bLOCAT[ÁA]RI[OA]S?\b/giu,
    /\bFIADOR(?:A|ES)?\b/giu,
    /\bCONTRATANTE\b/giu,
    /\bCONTRATADA\b/giu,
    /\bDORAVANTE\b/giu,
    /\bRECLAMANTE\b/giu,
    /\bRECLAMADA\b/giu,
    /\bAUTOR(?:A)?\b/giu,
    /\bR[EÉ]U\b/giu,
    /\bREQUERENTE\b/giu,
    /\bREQUERID[OA]\b/giu,
    /\bVALOR\s+DA\s+CAUSA\b/giu,
    /\bDISPOSITIVO\b/giu,
    /\bITCMD\b/giu,
    /\bITCDM\b/giu,
    /\bde\s+cujus\b/giu,
    /\bdou\s+fé\b/giu,
    /\bpor\s+mim\b/giu,
    /\bTESTAMENTO\s+PÚBLICO\b/giu,
  ];
  for (const re of CRITICAL_TERMS) {
    s = s.replace(re, (m) => put("TERM", m));
  }

  // Dates
  s = s.replace(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g, (m) => put("DATE", m));
  s = s.replace(
    /\b(\d{1,2}\s+de\s+[A-Za-zçáéíóúâêôãõÇÁÉÍÓÚÂÊÔÃÕ]+\s+de\s+\d{4})\b/giu,
    (m) => put("DATE", m)
  );

  // CPF/CNPJ
  s = s.replace(/\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/g, (m) => put("NUM", m));
  s = s.replace(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/g, (m) => put("NUM", m));

  // Process numbers / registry ids
  s = s.replace(/\b(\d{3,}(?:[.\-\/]\d+){2,})\b/g, (m) => put("NUM", m));
  s = s.replace(/\b(R\/\d+)\b/gi, (m) => put("NUM", m));
  s = s.replace(/\b(Livro\s+[A-Z]-\d+)\b/giu, (m) => put("NUM", m));
  s = s.replace(/\b(\d{9,})\b/g, (m) => put("NUM", m));
  s = s.replace(/\b(R\$\s*\d[\d\.\,]*)\b/g, (m) => put("NUM", m));

  // Percent
  s = s.replace(/\b(\d{1,3}(?:[.,]\d+)?\s*%)\b/g, (m) => put("PERC", m));

  // Normative IDs
  s = s.replace(/\b([A-Z]{2,}(?:-[A-Z]{2,})+\/\d{4})\b/g, (m) => put("LAW", m));
  s = s.replace(/\b(Lei|Resolução|Decreto|Portaria)\s*(n[ºo]\s*)?\d{1,5}\/\d{2,4}\b/giu, (m) => put("LAW", m));
  s = s.replace(/\b(art\.?\s*\d+[ºo]?(\s*,\s*§\s*\d+[ºo]?)?)\b/giu, (m) => put("LAW", m));

  // Negations
  s = s.replace(/\b(não|nunca|sem)\b/giu, (m) => put("NEG", m));

  return { protectedText: s, placeholders };
}

export function unprotectPlaceholders(text, placeholders = []) {
  let s = asString(text);
  for (const { ph, val } of placeholders) s = s.replaceAll(ph, val);
  return s;
}

export function splitSentencesProtected(text) {
  const ABBR = ["Art", "art", "Dr", "Dra", "Sr", "Sra", "Srs", "Sras", "Av", "Rod", "Prof", "Profa", "Inc", "Par", "No", "Nº", "nº", "Ex", "Ilmo", "Exmo"];
  let s = asString(text);

  s = s.replace(new RegExp(`\\b(?:${ABBR.join("|")})\\.(?=\\s+[A-ZÀ-Ý])`, "g"), (m) => m.replace(".", "§DOT§"));

  const parts = [];
  let buf = "";
  let inPH = 0;

  const flush = () => {
    if (buf) {
      parts.push(buf.trim());
      buf = "";
    }
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (s.startsWith("[[[", i)) {
      inPH++;
      buf += "[[[";
      i += 2;
      continue;
    }
    if (s.startsWith("]]]", i)) {
      inPH = Math.max(0, inPH - 1);
      buf += "]]]";
      i += 2;
      continue;
    }

    buf += ch;

    if (!inPH && /[.!?;]/.test(ch)) {
      const next = s.slice(i + 1).match(/^\s+/)?.[0] ?? "";
      if (next) {
        flush();
        buf = "";
        i += next.length;
        continue;
      }
    }
  }
  flush();

  return parts.map((x) => x.replace(/§DOT§/g, ".")).filter(Boolean);
}

export function chunkByWords(text, minWords = 280, maxWords = 520) {
  const s = asString(text).trim();
  if (!s) return [];

  const paras = s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let acc = [];

  const countWords = (str) =>
    str
      .replace(/\n+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;

  const accWordCount = () => countWords(acc.join("\n\n"));

  const flush = () => {
    if (!acc.length) return;
    chunks.push(acc.join("\n\n").trim());
    acc = [];
  };

  for (const p of paras) {
    const pWordsCount = countWords(p);
    const curCount = accWordCount();

    if (curCount + pWordsCount > maxWords) {
      if (curCount >= minWords) {
        flush();
        acc.push(p);
        continue;
      }

      const words = p.replace(/\n+/g, " ").trim().split(/\s+/).filter(Boolean);
      flush();

      for (let i = 0; i < words.length; i += maxWords) {
        const piece = words.slice(i, i + maxWords).join(" ").trim();
        if (!piece) continue;

        const isLast = i + maxWords >= words.length;
        chunks.push(isLast ? piece : `${piece} ${SOFT_JOIN}`);
      }
      continue;
    }

    acc.push(p);
  }

  flush();
  return chunks.length ? chunks : [s];
}
