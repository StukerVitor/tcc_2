import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Resolve paths for pdfjs-dist (legacy build) */
function resolvePdfjsPaths() {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("pdfjs-dist/package.json");
  const base = path.dirname(pkgJsonPath);
  const legacyBuild = path.join(base, "legacy", "build");
  return {
    workerSrcFs: path.join(legacyBuild, "pdf.worker.mjs"),
    standardFontsDir: path.join(legacyBuild, "standard_fonts"),
    cmapsDir: path.join(base, "cmaps"),
  };
}

/** Always return a plain Uint8Array */
function toUint8Array(input) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input) && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Unsupported input for PDF data. Expected Buffer/ArrayBuffer/TypedArray.");
}

function dirToFileUrl(dirPath) {
  const withSep = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep;
  return pathToFileURL(withSep).href;
}

function percentile(arr, q) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.max(0, Math.min(a.length - 1, Math.floor((q / 100) * (a.length - 1))));
  return a[idx];
}

function isBulletStart(line) {
  const s = String(line || "").trim();
  return (
    s.startsWith("•") ||
    s.startsWith("-") ||
    s.startsWith("–") ||
    /^\(?\d+\)?[.)-]\s+/.test(s) ||
    /^[a-zA-Z][.)]\s+/.test(s)
  );
}

function mergeInline(prev, cur) {
  const a = String(prev || "");
  const b = String(cur || "");

  const aTrim = a.trimEnd();
  const bTrim = b.trimStart();
  if (!aTrim) return bTrim;
  if (!bTrim) return aTrim;

  // Join hyphenation across wraps: "comerciá-" + "rio" -> "comerciário"
  if (aTrim.endsWith("-") && /^[\p{L}]/u.test(bTrim)) {
    return aTrim.slice(0, -1) + bTrim;
  }

  // No space before punctuation
  if (/^[,.;:!?)}\]]/.test(bTrim)) return aTrim + bTrim;

  // No space after opening punctuation
  const last = aTrim.slice(-1);
  if (/[({\["'«]$/.test(last)) return aTrim + bTrim;

  return aTrim + " " + bTrim;
}

/**
 * Rebuild page text:
 * - Group text items into lines by y
 * - Join items in a line by x-gap
 * - Detect paragraph breaks by y-gap
 * - Merge soft wraps within a paragraph
 */
function pageTextByGeometry(items) {
  const Y_TOL = 2.5;

  const runs = (items || [])
    .map((it) => {
      const tr = it?.transform;
      const x = Array.isArray(tr) ? tr[4] : it?.x ?? 0;
      const y = Array.isArray(tr) ? tr[5] : it?.y ?? 0;

      // pdfjs provides width for the text item (in page units)
      const w = Number.isFinite(it?.width) ? it.width : 0;

      let s = String(it?.str ?? "");
      if (!s) return null;

      // Some PDFs represent spaces as standalone items. Keep them if they have width.
      if (!s.trim() && w > 0) s = " ";

      // Drop truly empty / zero-width whitespace noise
      if (!s.trim() && w <= 0) return null;

      return { s, x, y, w };
    })
    .filter(Boolean);

  if (!runs.length) return "";

  // Sort top->bottom, then left->right
  runs.sort((a, b) => b.y - a.y || a.x - b.x);

  // Group into lines by y tolerance
  const lines = [];
  let current = null;

  for (const r of runs) {
    if (!current || Math.abs(current.y - r.y) > Y_TOL) {
      current = { y: r.y, items: [] };
      lines.push(current);
    }
    current.items.push(r);
  }

  function joinLineByGap(lineItems) {
    if (!lineItems.length) return "";
    lineItems.sort((a, b) => a.x - b.x);

    const rightEdge = (it) => (it?.x ?? 0) + (it?.w ?? 0);

    // Compute "true" whitespace gaps (next.startX - prev.endX)
    const gaps = [];
    for (let i = 0; i < lineItems.length - 1; i++) {
      const prev = lineItems[i];
      const next = lineItems[i + 1];
      const g = (next.x ?? 0) - rightEdge(prev);
      if (g > 0) gaps.push(g);
    }

    const p50 = gaps.length ? percentile(gaps, 50) : 0;
    const p90 = gaps.length ? percentile(gaps, 90) : 0;

    // Heuristic:
    // - If gaps are mostly uniform, treat most gaps as word gaps (insert spaces frequently)
    // - If gaps are bimodal (letters vs words), threshold between p50 and p90
    const ratio = p50 > 0 ? p90 / p50 : 999;
    let SPACE_GAP;
    if (!gaps.length) {
      SPACE_GAP = 0; // no evidence; rely on explicit " " items + punctuation rules
    } else if (ratio < 1.35) {
      SPACE_GAP = p50 * 0.6; // uniform spacing => be eager inserting spaces
    } else {
      SPACE_GAP = (p50 + p90) / 2; // bimodal => split the difference
    }

    // Small floor to avoid "SPACE_GAP = 0" causing random extra spaces
    SPACE_GAP = Math.max(SPACE_GAP, 0.5);

    let buf = "";

    for (let i = 0; i < lineItems.length; i++) {
      const curItem = lineItems[i];
      const prevItem = lineItems[i - 1];

      const cur = String(curItem?.s ?? "");

      // Explicit space item
      if (cur === " ") {
        if (buf && !buf.endsWith(" ")) buf += " ";
        continue;
      }

      const prevCh = buf.slice(-1);
      const prevStr = String(prevItem?.s ?? "");

      const gap = i > 0 ? (curItem.x ?? 0) - rightEdge(prevItem) : 0;

      let needSpace = i > 0 && gap > SPACE_GAP;

      // Punctuation spacing rules
      if (/^[,.;:!?)}\]]/.test(cur)) needSpace = false;
      if (/[({\["'«]$/.test(prevCh)) needSpace = false;

      // Slash/hyphen glue rules (avoid " / " and "- ")
      if (cur.startsWith("/") || prevStr.endsWith("/") || cur.startsWith("-") || prevStr.endsWith("-"))
        needSpace = false;

      // Avoid double spaces
      if (needSpace && (buf.endsWith(" ") || !buf)) needSpace = false;

      if (needSpace) buf += " ";
      buf += cur;
    }

    return buf
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  const lineObjs = lines
    .map((L) => ({ y: L.y, text: joinLineByGap(L.items) }))
    .filter((L) => L.text && L.text.trim());

  if (lineObjs.length <= 1) return (lineObjs[0]?.text || "").trim();

  // Paragraph detection stays the same
  const gapsY = [];
  for (let i = 0; i < lineObjs.length - 1; i++) {
    const g = lineObjs[i].y - lineObjs[i + 1].y;
    if (g > 0) gapsY.push(g);
  }
  const baseGap = Math.max(percentile(gapsY, 50) || 0, 8);
  const PARA_GAP = baseGap * 1.75;

  let out = lineObjs[0].text;

  for (let i = 1; i < lineObjs.length; i++) {
    const prev = lineObjs[i - 1];
    const cur = lineObjs[i];
    const gapY = prev.y - cur.y;

    const curText = String(cur.text || "");

    if (isBulletStart(curText)) {
      out = out.trimEnd() + "\n" + curText.trim();
      continue;
    }

    if (gapY > PARA_GAP) {
      out = out.trimEnd() + "\n\n" + curText.trim();
      continue;
    }

    out = mergeInline(out, curText);
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Glue pages:
 * - Avoid inserting "\n\n" (the main issue you described)
 * - Use a single newline after sentence end, otherwise a space
 */
function gluePages(prevPage, nextPage) {
  const a = String(prevPage || "").trimEnd();
  const b = String(nextPage || "").trimStart();
  if (!a) return b;
  if (!b) return a;

  // Hyphenated split across pages
  if (a.endsWith("-") && /^[\p{L}]/u.test(b)) return a.slice(0, -1) + b;

  // If sentence ended, keep a *single* newline (not blank line)
  if (/[.!?]$/.test(a)) return a + "\n" + b;

  // Default: page breaks are usually mid-paragraph -> join with space
  return a + " " + b;
}

/** Main extraction */
export async function extractTextFromPdfBuffer(bufferLike) {
  const { workerSrcFs, standardFontsDir, cmapsDir } = resolvePdfjsPaths();

  GlobalWorkerOptions.workerSrc = pathToFileURL(workerSrcFs).href;

  const data = toUint8Array(bufferLike);

  const loadingTask = getDocument({
    data,
    standardFontDataUrl: dirToFileUrl(standardFontsDir),
    cMapUrl: dirToFileUrl(cmapsDir),
    cMapPacked: true,
    useWorkerFetch: false,
    stopAtErrors: false,
    verbosity: 0,
    isEvalSupported: false,
  });

  const pdf = await loadingTask.promise;

  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    // Geometry-first extraction to fix wraps + paragraph detection
    const content = await page.getTextContent({
      includeMarkedContent: false,
      disableCombineTextItems: true,
    });

    const pageText = pageTextByGeometry(content.items || []);
    text = text ? gluePages(text, pageText) : pageText;
  }

  // Final cleanup
  text = String(text || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\d)\s*-\s*\n\s*(\d)/g, "$1-$2")
    .trim();

  return text;
}
