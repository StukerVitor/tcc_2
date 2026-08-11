# Benchmark de performance do backend LASCAS

Mede latência end-to-end, throughput, comportamento do LLM (aceitação/fallback), uso de GPU/RAM e coleta as specs da máquina. Não altera nada no backend.

## Como rodar

1. (Opcional, para medir cold start real) reinicie tudo antes:
   ```bash
   ./lascas.sh restart
   ```
2. Com o backend saudável (`./lascas.sh status`), rode:
   ```bash
   node bench/run_bench.mjs --docs /caminho/para/os/3/documentos
   ```
   A pasta pode conter `.pdf`, `.html` ou `.txt`.

## Plano padrão

- Documento: `peticao_inicial_consumidor.pdf` (colocar em `bench/docs/`), o mais usado no estudo
- `medium` x 10 repetições (nível adotado no estudo com 30 participantes)
- `light` e `strong` desativados por padrão (habilite com `--reps-light 1 --reps-strong 1` se quiser referência)
- 1 requisição de priming antes de tudo (reportada como cold start, fora das médias)

Ajustes: `--reps-medium 5 --api http://127.0.0.1:5179`

## Saída

`bench/results/bench-<timestamp>.json` com runs brutos, estatísticas agregadas (média, DP, mediana, min/max), baselines de recursos e specs (CPU, RAM, GPU/VRAM, driver, Ollama, modelo via `ollama show`, host Windows via PowerShell interop).

Duração estimada: 40 a 90 min, dominada pelas chamadas ao modelo. Pode deixar rodando; o resumo aparece no console ao final.
