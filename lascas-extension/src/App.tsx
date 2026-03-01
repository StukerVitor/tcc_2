import React, { useState } from 'react';

type Level = 'light' | 'medium' | 'strong';

export default function App() {
  const [level, setLevel] = useState<Level>('light');
  const [redactPII, setRedactPII] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>('');

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function sendToTab<T = any>(
    tabId: number,
    message: any,
    opts: { tries?: number; delayMs?: number } = {}
  ): Promise<T> {
    const tries = opts.tries ?? 10;
    const delayMs = opts.delayMs ?? 150;

    let lastErr: any = null;

    for (let i = 0; i < tries; i++) {
      const resp = await new Promise<{ ok: boolean; value?: any; err?: any }>((resolve) => {
        try {
          chrome.tabs.sendMessage(tabId, message, (value) => {
            const err = chrome.runtime.lastError;
            if (err) return resolve({ ok: false, err });
            resolve({ ok: true, value });
          });
        } catch (e) {
          resolve({ ok: false, err: e });
        }
      });

      if (resp.ok) return resp.value as T;

      lastErr = resp.err;
      await sleep(delayMs);
    }

    throw lastErr || new Error('sendMessage failed');
  }

  async function run() {
    if (running) return;
    setRunning(true);
    setStatus('');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setStatus('Não foi possível identificar a aba ativa.');
        setRunning(false);
        return;
      }

      // Ask env (retry, because content script may not be ready immediately)
      const env = await sendToTab<any>(tab.id, { type: 'LASCAS_ENV_REQUEST' }, { tries: 12, delayMs: 150 });
      console.log('[LASCAS][POPUP] ENV', env);

      // Open sidebar immediately (so user always sees feedback)
      await sendToTab(
        tab.id,
        {
          type: 'LASCAS_OPEN',
          payload: env?.isPdf && env?.protocol === 'file:' ? { mode: 'file-pdf' } : { mode: 'page' },
        },
        { tries: 12, delayMs: 150 }
      );

      // IMPORTANT FIX:
      // For file:// PDFs, do NOT read/encode in the popup.
      // Tell the content script to open the picker and handle reading with progress.
      if (env?.isPdf && env?.protocol === 'file:') {
        await sendToTab(
          tab.id,
          { type: 'LASCAS_RUN_PICK_PDF', payload: { level, redactPII } },
          { tries: 12, delayMs: 150 }
        );
        window.close();
        return;
      }

      // Normal flow: page text or http(s) PDF url
      await sendToTab(tab.id, { type: 'LASCAS_STATUS', payload: { phase: 'Iniciando…', detail: 'Enviando solicitação…' } });
      await sendToTab(tab.id, { type: 'LASCAS_RUN', payload: { level, redactPII } }, { tries: 12, delayMs: 150 });

      window.close();
    } catch (e: any) {
      console.error('[LASCAS][POPUP] run failed', e);
      setStatus(`Falha ao iniciar: ${e?.message ? e.message : String(e)}`);
      setRunning(false);
    }
  }

  return (
    <div style={{ width: 360, padding: 16, fontFamily: 'system-ui, Segoe UI, Roboto, Arial, sans-serif' }}>
      <h2 style={{ margin: '0 0 4px', letterSpacing: 0.3 }}>LASCAS</h2>
      <p style={{ margin: '0 0 12px', opacity: 0.8 }}>Local legal text simplification (PT-BR).</p>

      <label htmlFor="level" style={{ fontWeight: 600, fontSize: 12, textTransform: 'uppercase' }}>
        Simplification level
      </label>

      <div role="radiogroup" aria-label="Simplification level" style={{ display: 'flex', gap: 8, margin: '8px 0 14px' }}>
        {(['light', 'medium', 'strong'] as Level[]).map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={level === v}
            onClick={() => !running && setLevel(v)}
            style={{
              flex: 1,
              padding: '8px 10px',
              borderRadius: 999,
              border: '1px solid #e5e7eb',
              background: level === v ? '#111827' : '#fff',
              color: level === v ? '#fff' : '#111827',
              cursor: running ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              opacity: running ? 0.7 : 1,
            }}
          >
            {v === 'light' ? 'Leve' : v === 'medium' ? 'Médio' : 'Forte'}
          </button>
        ))}
      </div>

      <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, margin: '0 0 14px' }}>
        <input
          type="checkbox"
          checked={redactPII}
          onChange={(e) => !running && setRedactPII(e.target.checked)}
          aria-label="Mask personal data"
          disabled={running}
        />
        Mascarar dados pessoais (CPF/RG/endereço) no texto final
      </label>

      <button
        onClick={run}
        aria-label="Run simplification"
        disabled={running}
        style={{
          width: '100%',
          padding: '10px 14px',
          borderRadius: 10,
          border: 'none',
          background: running ? '#94a3b8' : 'linear-gradient(90deg,#4f46e5,#06b6d4)',
          color: '#fff',
          fontWeight: 700,
          cursor: running ? 'not-allowed' : 'pointer',
          boxShadow: running ? 'none' : '0 6px 16px rgba(79,70,229,.35)',
        }}
      >
        {running ? 'Processando…' : 'Sintetizar agora'}
      </button>

      {status ? <p style={{ fontSize: 12, marginTop: 10, opacity: 0.85, whiteSpace: 'pre-wrap' }}>{status}</p> : null}

      <p style={{ fontSize: 11, opacity: 0.7, marginTop: 10 }}>
        Aviso: ferramenta educacional; não substitui aconselhamento jurídico.
      </p>
    </div>
  );
}
