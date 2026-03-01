import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ENABLED = process.env.LASCAS_PDF_DUMP_TEXT === "1";

function safeName(s) {
  return String(s || "pdf")
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .slice(0, 120);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function dumpExtractedPdfText(text, meta = {}) {
  if (!ENABLED) return null;

  const outDir = path.resolve(process.cwd(), "debug", "pdf-extract");
  await fs.mkdir(outDir, { recursive: true });

  const source = safeName(meta.source || "pdf");
  const ts = stamp();

  const body = String(text ?? "");
  const hash = crypto.createHash("sha1").update(body).digest("hex").slice(0, 10);

  const filename = `extracted_${source}_${ts}_${hash}.txt`;
  const outPath = path.join(outDir, filename);

  const header =
    `# LASCAS PDF extracted text dump\n` +
    `# saved=${new Date().toISOString()}\n` +
    `# source=${meta.source || ""}\n` +
    `# length=${body.length}\n\n`;

  await fs.writeFile(outPath, header + body, "utf8");
  return outPath;
}
