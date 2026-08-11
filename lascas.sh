#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

# ---- Config (override by exporting before running) ----
PORT="${PORT:-5179}"
OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
OLLAMA_URL="${OLLAMA_URL:-http://$OLLAMA_HOST}"
MODEL_NAME="${MODEL_NAME:-legal-simplifier:latest}"

MODEFILE_PATH="$ROOT_DIR/ai/Modelfile"
MODEL_STAMP="$RUN_DIR/model.stamp"

# Auto-detect backend folder (repo has mixed naming in the conversation/logs)
BACKEND_DIR=""
if [[ -f "$ROOT_DIR/lascas-local/package.json" ]]; then
  BACKEND_DIR="$ROOT_DIR/lascas-local"
elif [[ -f "$ROOT_DIR/lascas-local-api/package.json" ]]; then
  BACKEND_DIR="$ROOT_DIR/lascas-local-api"
else
  echo "[fatal] Could not find backend folder. Expected lascas-local/ or lascas-local-api/ with package.json."
  exit 1
fi

EXT_DIR="$ROOT_DIR/lascas-extension"
if [[ ! -f "$EXT_DIR/package.json" ]]; then
  echo "[fatal] Could not find extension at $EXT_DIR/package.json"
  exit 1
fi

PID_BACKEND="$RUN_DIR/backend.pid"
PID_EXTWATCH="$RUN_DIR/extwatch.pid"

LOG_OLLAMA="$LOG_DIR/ollama.log"
LOG_BACKEND="$LOG_DIR/backend.log"
LOG_EXTWATCH="$LOG_DIR/extwatch.log"

have_cmd() { command -v "$1" >/dev/null 2>&1; }

pid_alive() {
  local pid="$1"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1
}

read_pidfile() {
  local f="$1"
  [[ -f "$f" ]] && cat "$f" || true
}

kill_pidfile() {
  local f="$1"
  local pid
  pid="$(read_pidfile "$f")"
  if [[ -n "${pid:-}" ]] && pid_alive "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 0.4
    if pid_alive "$pid"; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$f"
}

port_listening() {
  local hostport="$1"
  local port="${hostport#*:}"
  if have_cmd ss; then
    ss -ltn | awk '{print $4}' | grep -qE "(^|:)${port}$"
  elif have_cmd lsof; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

ensure_node_deps() {
  local dir="$1"
  if [[ ! -d "$dir/node_modules" ]]; then
    echo "[deps] npm install in $dir"
    (cd "$dir" && npm install)
  fi
}

# Kill *whatever* is listening on $PORT (fixes EADDRINUSE)
free_port() {
  local port="$1"
  local pids=""

  if have_cmd lsof; then
    pids="$(sudo lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  elif have_cmd fuser; then
    # fuser outputs like: "5179/tcp: 1234"
    pids="$(sudo fuser -n tcp "$port" 2>/dev/null | tr ' ' '\n' || true)"
  else
    echo "[warn] Neither lsof nor fuser found; can't auto-free port $port."
    return 0
  fi

  if [[ -n "$pids" ]]; then
    echo "[port] Port $port is in use. Killing listener PID(s): $pids"
    for pid in $pids; do
      sudo kill "$pid" >/dev/null 2>&1 || true
    done
    sleep 0.5
    # Hard kill if still alive
    for pid in $pids; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        sudo kill -9 "$pid" >/dev/null 2>&1 || true
      fi
    done
  fi
}

health_check_backend() {
  for _ in {1..30}; do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

# ---- Ollama ----
ensure_ollama_running() {
  if port_listening "$OLLAMA_HOST"; then
    echo "[ollama] Listening on $OLLAMA_HOST (already running)."
    return 0
  fi

  if have_cmd systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
    echo "[ollama] Starting systemd service: ollama"
    sudo systemctl start ollama >/dev/null 2>&1 || true
    for _ in {1..40}; do
      port_listening "$OLLAMA_HOST" && return 0
      sleep 0.25
    done
    echo "[ollama] Warning: started service but port not detected. Check: sudo systemctl status ollama"
    return 0
  fi

  echo "[ollama] Starting manual 'ollama serve'..."
  nohup bash -c "cd '$ROOT_DIR' && ollama serve" >>"$LOG_OLLAMA" 2>&1 &
  for _ in {1..40}; do
    port_listening "$OLLAMA_HOST" && return 0
    sleep 0.25
  done

  echo "[fatal] Ollama didn't start. See $LOG_OLLAMA"
  exit 1
}

ensure_model() {
  if [[ ! -f "$MODEFILE_PATH" ]]; then
    echo "[fatal] Missing $MODEFILE_PATH"
    exit 1
  fi

  if [[ -f "$MODEL_STAMP" ]] && [[ "$MODEL_STAMP" -nt "$MODEFILE_PATH" ]]; then
    echo "[model] Up-to-date (no Modelfile changes)."
    return 0
  fi

  echo "[model] Pulling base model (llama3.1:8b) and creating $MODEL_NAME ..."
  ollama pull llama3.1:8b >>"$LOG_OLLAMA" 2>&1 || true
  (cd "$ROOT_DIR/ai" && ollama create "$MODEL_NAME" -f "Modelfile") >>"$LOG_OLLAMA" 2>&1
  touch "$MODEL_STAMP"
  echo "[model] Done."
}

# ---- Start services ----
start_backend() {
  ensure_node_deps "$BACKEND_DIR"

  export PORT
  export OLLAMA_URL
  export LASCAS_MODEL="${LASCAS_MODEL:-$MODEL_NAME}"

  # IMPORTANT: free the port (fixes your EADDRINUSE)
  free_port "$PORT"

  echo "[backend] Starting in $BACKEND_DIR"
  echo "[backend]   PORT=$PORT"
  echo "[backend]   OLLAMA_URL=$OLLAMA_URL"
  echo "[backend]   LASCAS_MODEL=$LASCAS_MODEL"

  nohup bash -c "cd '$BACKEND_DIR' && npm run dev" >>"$LOG_BACKEND" 2>&1 &
  echo $! >"$PID_BACKEND"

  if health_check_backend; then
    echo "[backend] Health OK."
    echo "[backend] /health response:"
    curl -fsS "http://127.0.0.1:${PORT}/health" || true
    echo
  else
    echo "[fatal] Backend did not become healthy on port $PORT."
    echo "-------- last 160 lines: $LOG_BACKEND --------"
    tail -n 160 "$LOG_BACKEND" || true
    echo
    echo "[hint] If you edited /health, ensure the line is syntactically correct."
    echo "       Example correct syntax:"
    echo "       app.get('/health', (_req, res) => res.json({ ok: true, updated: true }));"
    exit 1
  fi
}

start_extension_watch() {
  ensure_node_deps "$EXT_DIR"

  echo "[extension] Starting build watch in $EXT_DIR"
  echo "[extension] Output folder: $EXT_DIR/dist"
  echo "[extension] IMPORTANT: after rebuild, reload in chrome://extensions (Reload button)."

  nohup bash -c "
    set -euo pipefail
    cd '$EXT_DIR'
    if command -v stdbuf >/dev/null 2>&1; then
      CMD=(stdbuf -oL -eL npm run build -- --watch)
    else
      CMD=(npm run build -- --watch)
    fi
    \"\${CMD[@]}\" 2>&1 | tee -a '$LOG_EXTWATCH' | while IFS= read -r line; do
      echo \"\$line\"
      if echo \"\$line\" | grep -qiE 'built in|✓ built|build completed|bundled in|watching for file changes'; then
        # Only print the reminder on build completion lines (built in / ✓ built / bundled in)
        if echo \"\$line\" | grep -qiE 'built in|✓ built|build completed|bundled in'; then
          echo
          echo '[REMINDER] Extension rebuilt. Reload it at chrome://extensions (Reload button) to see changes.'
          echo
        fi
      fi
    done
  " >>"$LOG_EXTWATCH" 2>&1 &

  echo $! >"$PID_EXTWATCH"
}

# ---- Commands ----
do_start() {
  echo "== START =="
  ensure_ollama_running
  ensure_model

  # Stop old processes started by this script
  kill_pidfile "$PID_BACKEND" || true
  kill_pidfile "$PID_EXTWATCH" || true

  start_backend
  start_extension_watch

  echo "== READY =="
  echo "- Backend: http://127.0.0.1:${PORT}/health"
  echo "- Extension dist: $EXT_DIR/dist (Load unpacked + reload after rebuilds)"
}

do_stop() {
  echo "== STOP =="

  kill_pidfile "$PID_BACKEND" || true
  kill_pidfile "$PID_EXTWATCH" || true

  # Stop Ollama systemd service (prevents immediate respawn)
  if have_cmd systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
    if systemctl is-active --quiet ollama; then
      echo "[ollama] Stopping systemd service: ollama"
      sudo systemctl stop ollama >/dev/null 2>&1 || true
    else
      echo "[ollama] systemd service already stopped."
    fi
  fi

  # Kill any remaining ollama processes (manual serve / leftovers)
  if pgrep -x ollama >/dev/null 2>&1; then
    echo "[ollama] Killing remaining ollama processes..."
    pkill -x ollama >/dev/null 2>&1 || true
  fi

  # Also free the backend port just in case something else is holding it
  free_port "$PORT"

  echo "[stop] Done."
}

do_status() {
  echo "== STATUS =="
  echo "- Backend dir: $BACKEND_DIR"
  echo "- Extension dir: $EXT_DIR"
  echo "- Ollama: $OLLAMA_HOST -> $(port_listening "$OLLAMA_HOST" && echo LISTENING || echo NOT_LISTENING)"

  local pid
  pid="$(read_pidfile "$PID_BACKEND")"
  if [[ -n "${pid:-}" ]] && pid_alive "$pid"; then
    echo "- Backend: running (pid $pid)"
  else
    echo "- Backend: not running"
  fi

  pid="$(read_pidfile "$PID_EXTWATCH")"
  if [[ -n "${pid:-}" ]] && pid_alive "$pid"; then
    echo "- Extension watch: running (pid $pid)"
  else
    echo "- Extension watch: not running"
  fi

  echo "Logs:"
  echo "  - $LOG_BACKEND"
  echo "  - $LOG_EXTWATCH"
  echo "  - $LOG_OLLAMA"
}

do_logs() {
  echo "== LOGS (last 160) =="
  echo "--- backend ---"
  tail -n 160 "$LOG_BACKEND" 2>/dev/null || true
  echo
  echo "--- extension watch ---"
  tail -n 160 "$LOG_EXTWATCH" 2>/dev/null || true
  echo
  echo "--- ollama ---"
  tail -n 160 "$LOG_OLLAMA" 2>/dev/null || true
}

case "${1:-}" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
  logs) do_logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac

