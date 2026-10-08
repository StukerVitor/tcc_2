(() => {
  const API_JSON = "http://localhost:5179/simplify";
  const API_PDF = "http://localhost:5179/simplify-pdf";
  const HEALTH = "http://localhost:5179/health";

  type Level = "light" | "medium" | "strong";

  function isPdfViewer(): boolean {
    const pdfEmb = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
    const url = window.location.href.toLowerCase();
    return !!pdfEmb || url.endsWith(".pdf") || document.contentType === "application/pdf";
  }

  // ---------------- UI ----------------

  let currentAbort: AbortController | null = null;
  let currentRunId: string | null = null;
  let heartbeatTimer: number | null = null;
  let heartbeatStartedAt = 0;
  let currentReader: FileReader | null = null;

  function fmtMs(ms: number) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
  }

  function ensureSidebar(): HTMLElement {
    let root = document.getElementById("lascas-sidebar");
    if (root) return root;

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("sidebar.css");
    document.documentElement.appendChild(link);

    root = document.createElement("div");
    root.id = "lascas-sidebar";
    root.setAttribute("role", "complementary");
    root.setAttribute("aria-label", "LASCAS simplification panel");
    root.innerHTML = `
      <div class="lascas-header">
        <strong>LASCAS – Simplificação</strong>
        <div class="lascas-actions">
          <button id="lascas-cancel" title="Cancelar">Cancelar</button>
          <button id="lascas-copy" title="Copiar">Copiar</button>
          <button id="lascas-close" title="Fechar">Fechar</button>
        </div>
      </div>
      <div class="lascas-cols">
        <div class="lascas-col">
          <pre
            id="lascas-simplified"
            class="lascas-text"
            aria-live="polite"
            style="white-space: pre-wrap; word-break: break-word;"
          >—</pre>
          <div id="lascas-meta" style="margin-top:8px;font-size:11px;opacity:.80;"></div>
        </div>
      </div>
      <div class="lascas-footer">
        Ferramenta educacional; não substitui aconselhamento jurídico.
      </div>
    `;
    document.documentElement.classList.add("lascas-open");

    const mount = document.body || document.documentElement;
    mount.appendChild(root);

    (root.querySelector("#lascas-close") as HTMLButtonElement).onclick = () => {
      stopHeartbeat();
      cancelCurrent("Fechado pelo usuário.");
      document.documentElement.classList.remove("lascas-open");
      root?.remove();
    };

    (root.querySelector("#lascas-copy") as HTMLButtonElement).onclick = async () => {
      const txt = (document.getElementById("lascas-simplified")!.textContent || "").trim();
      try {
        await navigator.clipboard.writeText(txt);
      } catch (e) {
        console.error("[LASCAS][CONTENT] Clipboard write failed:", e);
      }
    };

    (root.querySelector("#lascas-cancel") as HTMLButtonElement).onclick = () => {
      cancelCurrent("Cancelado.");
    };

    return root;
  }

  function setUi(phase: string, detail: string = "", metaLine: string = "") {
    const root = ensureSidebar();
    const elSimplified = root.querySelector("#lascas-simplified") as HTMLElement;
    const elMeta = root.querySelector("#lascas-meta") as HTMLElement;

    elSimplified.textContent = detail ? `${phase}\n${detail}` : phase || "—";
    elMeta.textContent = metaLine || "";
  }

  function startHeartbeat(runId: string) {
    stopHeartbeat();
    heartbeatStartedAt = Date.now();

    heartbeatTimer = window.setInterval(() => {
      if (currentRunId !== runId) return;

      const elapsed = Date.now() - heartbeatStartedAt;
      const root = ensureSidebar();
      const elMeta = root.querySelector("#lascas-meta") as HTMLElement;

      const hints: string[] = [];
      const sec = Math.floor(elapsed / 1000);

      if (sec >= 10 && sec < 60) hints.push("PDF grande pode demorar.");
      if (sec >= 60 && sec < 180) hints.push("Ainda processando… (modelo local pode estar ocupado)");
      if (sec >= 180) hints.push("Dica: veja logs do server/Ollama se parecer travado.");

      elMeta.textContent = [`⏱ ${fmtMs(elapsed)}`, ...hints].join(" · ");
    }, 1000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function cancelCurrent(message: string) {
    try {
      currentAbort?.abort("user-cancel");
    } catch {}
    currentAbort = null;

    try {
      currentReader?.abort();
    } catch {}
    currentReader = null;

    currentRunId = null;
    stopHeartbeat();

    if (message) setUi(message, "", "");
  }

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const ctrl = (init.signal ? null : new AbortController()) as AbortController | null;
    const signal = init.signal || ctrl!.signal;

    const timer = setTimeout(() => {
      try {
        ctrl?.abort("timeout");
      } catch {}
    }, timeoutMs);

    try {
      return await fetch(url, { ...init, signal, cache: "no-store" });
    } finally {
      clearTimeout(timer);
    }
  }

  async function healthCheck(): Promise<boolean> {
    try {
      const resp = await fetchWithTimeout(HEALTH, { method: "GET" }, 2000);
      return resp.ok;
    } catch {
      return false;
    }
  }

  async function pickPdfFile(): Promise<File | null> {
    // Prefer modern picker
    if ((window as any).showOpenFilePicker) {
      const [handle] = await (window as any).showOpenFilePicker({
        multiple: false,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
      return await handle.getFile();
    }

    // Fallback <input>
    return await new Promise<File | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf";
      input.onchange = () => resolve(input.files?.[0] || null);
      input.click();
    });
  }

  function mb(n: number) {
    return (n / (1024 * 1024)).toFixed(1);
  }

  // Reliable PDF read:
  // 1) Try FileReader with progress + stall watchdog
  // 2) If it stalls, fallback to file.arrayBuffer()
  async function readPdfArrayBufferReliable(
    file: File,
    runId: string,
    onProgress: (loaded: number, total: number, note?: string) => void,
    signal: AbortSignal
  ): Promise<ArrayBuffer> {
    // ---------- Attempt 1: FileReader with progress ----------
    const attemptFileReader = () =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const r = new FileReader();
        currentReader = r;

        let lastProgressAt = Date.now();
        let lastLoaded = 0;

        const TOTAL = file.size || 0;

        const stallCheck = window.setInterval(() => {
          if (signal.aborted) {
            try {
              r.abort();
            } catch {}
            clearInterval(stallCheck);
            reject(new Error("user-cancel"));
            return;
          }

          const now = Date.now();
          const stalledMs = now - lastProgressAt;

          // If no progress for 12s, show message (not fail yet)
          if (stalledMs > 12_000 && lastLoaded > 0 && lastLoaded < TOTAL) {
            onProgress(lastLoaded, TOTAL, "Sem progresso há alguns segundos…");
          }

          // If no progress for 45s, consider it stuck
          if (stalledMs > 45_000 && lastLoaded > 0 && lastLoaded < TOTAL) {
            try {
              r.abort();
            } catch {}
            clearInterval(stallCheck);
            reject(new Error("file-read-stalled"));
          }
        }, 1500);

        r.onerror = () => {
          clearInterval(stallCheck);
          reject(r.error || new Error("file-read-error"));
        };

        r.onabort = () => {
          clearInterval(stallCheck);
          reject(new Error("file-read-abort"));
        };

        r.onprogress = (ev) => {
          if (currentRunId !== runId) return;
          if (typeof ev.loaded === "number") {
            lastLoaded = ev.loaded;
            lastProgressAt = Date.now();
            onProgress(ev.loaded, ev.total || TOTAL, "");
          }
        };

        r.onload = () => {
          clearInterval(stallCheck);
          const buf = r.result;
          currentReader = null;
          if (buf instanceof ArrayBuffer) return resolve(buf);
          reject(new Error("file-read-bad-result"));
        };

        try {
          r.readAsArrayBuffer(file);
        } catch (e: any) {
          clearInterval(stallCheck);
          reject(e);
        }
      });

    try {
      return await attemptFileReader();
    } catch (e: any) {
      if (signal.aborted) throw e;

      // ---------- Attempt 2: file.arrayBuffer() fallback ----------
      onProgress(0, file.size || 0, "Tentando modo alternativo…");
      // small pause so UI paints
      await sleep(60);

      const FALLBACK_TIMEOUT_MS = 3 * 60 * 1000;
      const t0 = Date.now();

      while (Date.now() - t0 < 500) {
        // brief loop to keep UI alive
        if (signal.aborted) throw new Error("user-cancel");
        await sleep(40);
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        try {
          ctrl.abort("timeout");
        } catch {}
      }, FALLBACK_TIMEOUT_MS);

      try {
        // If caller cancels, cancel fallback too
        const abortListener = () => {
          try {
            ctrl.abort("user-cancel");
          } catch {}
        };
        signal.addEventListener("abort", abortListener, { once: true });

        // No progress events here; heartbeat will show elapsed.
        const buf = await Promise.race([
          file.arrayBuffer(),
          new Promise<ArrayBuffer>((_, reject2) =>
            ctrl.signal.addEventListener("abort", () => reject2(new Error(String(ctrl.signal.reason || "timeout"))), {
              once: true,
            })
          ),
        ]);

        signal.removeEventListener("abort", abortListener);
        return buf;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function requestSimplifyJson(payload: any, runId: string) {
    const ok = await healthCheck();
    if (!ok) throw new Error("API local offline (http://localhost:5179). Inicie o server.js.");

    currentAbort = new AbortController();
    const HARD_TIMEOUT_MS = 25 * 60 * 1000;

    const resp = await fetchWithTimeout(
      API_JSON,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: currentAbort.signal,
      },
      HARD_TIMEOUT_MS
    );

    let data: any = null;
    try {
      data = await resp.json();
    } catch {}

    if (!resp.ok) {
      const msg = data?.error ? String(data.error) : `HTTP ${resp.status}`;
      throw new Error(msg);
    }

    if (currentRunId !== runId) throw new Error("Resultado ignorado: uma nova execução começou.");
    return data as { blocks: string[]; meta?: any };
  }

  async function requestSimplifyPdfBinary(pdfBuf: ArrayBuffer, params: { level: Level; redactPII: boolean; fileName: string }, runId: string) {
    const ok = await healthCheck();
    if (!ok) throw new Error("API local offline (http://localhost:5179). Inicie o server.js.");

    currentAbort = new AbortController();
    const HARD_TIMEOUT_MS = 25 * 60 * 1000;

    const qs = new URLSearchParams({
      level: params.level,
      redactPII: params.redactPII ? "1" : "0",
      fileName: params.fileName || "upload.pdf",
    });

    const resp = await fetchWithTimeout(
      `${API_PDF}?${qs.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: pdfBuf,
        signal: currentAbort.signal,
      },
      HARD_TIMEOUT_MS
    );

    let data: any = null;
    try {
      data = await resp.json();
    } catch {}

    if (!resp.ok) {
      const msg = data?.error ? String(data.error) : `HTTP ${resp.status}`;
      throw new Error(msg);
    }

    if (currentRunId !== runId) throw new Error("Resultado ignorado: uma nova execução começou.");
    return data as { blocks: string[]; meta?: any };
  }

  function renderFinal(out: { blocks: string[]; meta?: any }) {
    const root = ensureSidebar();
    const elSimplified = root.querySelector("#lascas-simplified") as HTMLElement;
    const elMeta = root.querySelector("#lascas-meta") as HTMLElement;

    const text = (out?.blocks || []).join("\n\n").trim();
    elSimplified.textContent = text || "No meaningful changes.";

    if (out?.meta) {
      const m = out.meta;
      const bits: string[] = [];
      if (typeof m.ms === "number") bits.push(`⏱ ${m.ms}ms`);
      if (typeof m.llmCalls === "number") bits.push(`LLM calls: ${m.llmCalls}`);
      if (typeof m.llmAccepted === "number") bits.push(`accepted: ${m.llmAccepted}`);
      if (typeof m.llmRejected === "number") bits.push(`rejected: ${m.llmRejected}`);
      if (m.integrityWarning) bits.push(`⚠️ ${m.integrityWarning}`);
      elMeta.textContent = bits.join(" · ");
    } else {
      elMeta.textContent = "";
    }
  }

  async function runSimplification(level: Level, redactPII: boolean, pdfBase64?: string, fileName?: string) {
    cancelCurrent("");
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    currentRunId = runId;

    setUi("Processando…", "Preparando requisição…");
    startHeartbeat(runId);

    try {
      const isPdf = isPdfViewer();
      let payload: any;

      if (pdfBase64) {
        // (kept for backward compatibility, but we avoid this path now)
        payload = { hasPdf: true, pdfBase64, fileName, level, redactPII: Boolean(redactPII) };
      } else if (isPdf && (location.protocol === "http:" || location.protocol === "https:")) {
        payload = { hasPdf: true, pdfUrl: location.href, level, redactPII: Boolean(redactPII) };
      } else {
        const original = document.body?.innerText?.trim() || "";
        payload = { hasHtml: true, html: original, level, redactPII: Boolean(redactPII) };
      }

      setUi("Processando…", "Conectando ao servidor local…");
      const out = await requestSimplifyJson(payload, runId);

      stopHeartbeat();
      renderFinal(out);
    } catch (e: any) {
      stopHeartbeat();
      const msg = e?.message ? String(e.message) : String(e);

      const aborted = msg.includes("user-cancel") || msg.includes("AbortError") || msg.includes("timeout");
      if (aborted) {
        setUi("Cancelado.", msg.includes("timeout") ? "Tempo limite atingido. Tente novamente." : "");
      } else {
        setUi(
          "Falha ao simplificar.",
          `${msg}\n\nDicas:\n- Confirme server.js rodando (localhost:5179)\n- Confirme Ollama/modelo ativos\n- Veja logs no terminal para detalhes.`,
          ""
        );
      }
      console.error("[LASCAS][CONTENT] Error:", e);
    } finally {
      currentAbort = null;
      currentReader = null;
    }
  }

  async function runPickPdfFlow(level: Level, redactPII: boolean) {
    cancelCurrent("");
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    currentRunId = runId;

    setUi("Aguardando PDF…", "Selecione o arquivo na janela.");
    startHeartbeat(runId);

    try {
      const file = await pickPdfFile();
      if (!file) {
        stopHeartbeat();
        setUi("Cancelado.", "Nenhum arquivo selecionado.");
        return;
      }

      setUi("Lendo PDF…", `${file.name}\n${mb(file.size)} MB`);
      currentAbort = new AbortController();

      const buf = await readPdfArrayBufferReliable(
        file,
        runId,
        (loaded, total, note) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
          const detail =
            `${file.name}\n${mb(loaded)}/${mb(total || file.size)} MB (${pct}%)` + (note ? `\n${note}` : "");
          setUi("Lendo PDF…", detail);
        },
        currentAbort.signal
      );

      if (currentRunId !== runId) return;

      setUi("Enviando ao servidor…", `${file.name}\n${mb(file.size)} MB`);
      const out = await requestSimplifyPdfBinary(buf, { level, redactPII, fileName: file.name }, runId);

      stopHeartbeat();
      renderFinal(out);
    } catch (e: any) {
      stopHeartbeat();
      const msg = e?.message ? String(e.message) : String(e);

      const aborted = msg.includes("user-cancel") || msg.includes("AbortError") || msg.includes("timeout") || msg.includes("file-read-abort");
      if (aborted) {
        setUi("Cancelado.", msg.includes("timeout") ? "Tempo limite atingido. Tente novamente." : "");
      } else if (msg.includes("file-read-stalled")) {
        setUi(
          "Falha ao ler o PDF.",
          "A leitura travou no navegador.\nTente novamente.\nSe persistir: copie o PDF para uma pasta local diferente e tente de novo.",
          ""
        );
      } else {
        setUi(
          "Falha ao processar PDF.",
          `${msg}\n\nDicas:\n- Confirme server.js rodando (localhost:5179)\n- Confirme Ollama/modelo ativos\n- Veja logs no terminal para detalhes.`,
          ""
        );
      }
      console.error("[LASCAS][CONTENT] PDF flow error:", e);
    } finally {
      currentAbort = null;
      currentReader = null;
    }
  }

  // ---------------- Messages ----------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "LASCAS_OPEN") {
      const mode = msg?.payload?.mode;
      if (mode === "file-pdf") setUi("LASCAS pronto.", "Clique em “Sintetizar agora” e selecione o PDF.");
      else setUi("LASCAS pronto.", "Clique em “Sintetizar agora” para iniciar.");
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === "LASCAS_STATUS") {
      const phase = String(msg?.payload?.phase || "Processando…");
      const detail = String(msg?.payload?.detail || "");
      setUi(phase, detail);
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === "LASCAS_ENV_REQUEST") {
      sendResponse({ isPdf: isPdfViewer(), href: location.href, protocol: location.protocol });
      return true;
    }

    if (msg?.type === "LASCAS_RUN_PICK_PDF") {
      const { level = "light", redactPII } = msg.payload || {};
      runPickPdfFlow(level, Boolean(redactPII));
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === "LASCAS_RUN") {
      const { level = "light", redactPII, pdfBase64, fileName } = msg.payload || {};
      runSimplification(level, Boolean(redactPII), pdfBase64, fileName);
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
})();
