#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROMPTS_DIR="$ROOT_DIR/scripts/zai-benchmark/prompts"

# Load local env if present (kept out of git by default).
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
}

require_cmd curl
require_cmd jq
require_cmd unzip
require_cmd date

BASE_URL="${BASE_URL:-http://127.0.0.1:4001}"
API_KEY="${API_KEY:-${AGENT_API_KEY:-}}"

PROVIDER="${PROVIDER:-zai}"
MODEL="${MODEL:-glm-5}"
WORKSPACE_BACKEND="${WORKSPACE_BACKEND:-e2b}"

# 25 minutes max after a run starts executing (queued time is not counted).
RUN_TIMEOUT_SEC="${RUN_TIMEOUT_SEC:-1500}"
POLL_SEC="${POLL_SEC:-5}"

ZIP_MAX_TIME_SEC="${ZIP_MAX_TIME_SEC:-900}"
ZIP_RETRIES="${ZIP_RETRIES:-3}"

OUT_DIR="${OUT_DIR:-/tmp/zai_benchmark_$(date +%Y%m%d_%H%M%S)}"
ZIPS_DIR="$OUT_DIR/zips"
RUNS_DIR="$OUT_DIR/runs"
mkdir -p "$ZIPS_DIR" "$RUNS_DIR"

if [[ -z "${API_KEY:-}" ]]; then
  echo "API key missing. Set API_KEY or AGENT_API_KEY in env (or in $ROOT_DIR/.env)." >&2
  exit 1
fi

http_code() {
  # Usage: http_code <curl args...>
  curl -sS -o /dev/null -w "%{http_code}" "$@"
}

api_get_json() {
  local url="$1"
  curl -sS -H "X-Agent-Api-Key: $API_KEY" "$url"
}

api_post_json() {
  local url="$1"
  local payload="$2"
  curl -sS -H "X-Agent-Api-Key: $API_KEY" -H "Content-Type: application/json" -d "$payload" "$url"
}

check_server_auth() {
  local code
  code="$(http_code -H "X-Agent-Api-Key: $API_KEY" "${BASE_URL}/runs?limit=1")"
  if [[ "$code" != "200" ]]; then
    echo "Agent API not reachable/authorized: ${BASE_URL} (HTTP $code)" >&2
    echo "Make sure the server is running and API_KEY matches AGENT_API_KEY." >&2
    exit 1
  fi
}

create_run() {
  local prompt="$1"
  local payload
  payload="$(jq -n \
    --arg prompt "$prompt" \
    --arg provider "$PROVIDER" \
    --arg model "$MODEL" \
    --arg wb "$WORKSPACE_BACKEND" \
    '{prompt:$prompt, stream:false, provider:$provider, model:$model, workspaceBackend:$wb}')"

  local res run_id
  res="$(api_post_json "${BASE_URL}/runs" "$payload")"
  run_id="$(echo "$res" | jq -r '.id // empty')"
  if [[ -z "$run_id" ]]; then
    echo "Failed to create run. Response:" >&2
    echo "$res" >&2
    exit 1
  fi
  echo "$run_id"
}

get_run_status() {
  local run_id="$1"
  api_get_json "${BASE_URL}/runs/${run_id}" | jq -r '.status'
}

get_sandbox_id() {
  local run_id="$1"
  api_get_json "${BASE_URL}/runs/${run_id}/events" \
    | jq -r '[.[] | select(.type=="status") | .payload.sandboxId] | map(select(.!=null)) | .[0] // empty'
}

cancel_run() {
  local run_id="$1"
  api_post_json "${BASE_URL}/runs/${run_id}/cancel" '{}' >/dev/null || true
}

download_zip() {
  local sandbox_id="$1"
  local out_file="$2"

  for attempt in $(seq 1 "$ZIP_RETRIES"); do
    rm -f "$out_file"

    local code
    code="$(curl -sS \
      --max-time "$ZIP_MAX_TIME_SEC" \
      -o "$out_file" \
      -w "%{http_code}" \
      -H "X-Agent-Api-Key: $API_KEY" \
      "${BASE_URL}/sandbox/${sandbox_id}/download.zip" || true)"

    if [[ "$code" == "200" ]] && [[ -s "$out_file" ]]; then
      if unzip -t "$out_file" >/dev/null 2>&1; then
        return 0
      fi
    fi

    # If server returned JSON error, keep a note.
    local head
    head="$(head -c 200 "$out_file" 2>/dev/null || true)"
    echo "  download attempt ${attempt}/${ZIP_RETRIES} failed (HTTP ${code}). head=${head@Q}" >&2
    sleep 3
  done

  rm -f "$out_file"
  return 1
}

poll_until_terminal() {
  local run_id="$1"

  local started_at_epoch=""
  local start_seen=0

  while true; do
    local run_json status
    run_json="$(api_get_json "${BASE_URL}/runs/${run_id}")"
    status="$(echo "$run_json" | jq -r '.status')"

    if [[ "$status" == "running" ]] && [[ "$start_seen" -eq 0 ]]; then
      start_seen=1
      started_at_epoch="$(date +%s)"
    fi

    if [[ "$status" == "completed" || "$status" == "error" || "$status" == "cancelled" ]]; then
      echo "$run_json"
      return 0
    fi

    if [[ "$start_seen" -eq 1 ]]; then
      local now elapsed
      now="$(date +%s)"
      elapsed="$((now - started_at_epoch))"
      if (( elapsed > RUN_TIMEOUT_SEC )); then
        echo "  timeout exceeded (${elapsed}s > ${RUN_TIMEOUT_SEC}s), cancelling run ${run_id}" >&2
        cancel_run "$run_id"
      fi
    fi

    sleep "$POLL_SEC"
  done
}

case_name_for() {
  local n="$1"
  case "$n" in
    1) echo "blog_magazine" ;;
    2) echo "ecommerce_fashion" ;;
    3) echo "ecommerce_electronics" ;;
    4) echo "ecommerce_beauty" ;;
    5) echo "restaurant_ordering" ;;
    6) echo "real_estate_listings" ;;
    7) echo "travel_booking" ;;
    8) echo "fitness_coaching" ;;
    9) echo "project_management_dashboard" ;;
    10) echo "browser_3d_game" ;;
    *) echo "case_${n}" ;;
  esac
}

prompt_file_for() {
  local n="$1"
  case "$n" in
    1) echo "$PROMPTS_DIR/01_blog_magazine.txt" ;;
    2) echo "$PROMPTS_DIR/02_ecommerce_fashion.txt" ;;
    3) echo "$PROMPTS_DIR/03_ecommerce_electronics.txt" ;;
    4) echo "$PROMPTS_DIR/04_ecommerce_beauty.txt" ;;
    5) echo "$PROMPTS_DIR/05_restaurant_ordering.txt" ;;
    6) echo "$PROMPTS_DIR/06_real_estate_listings.txt" ;;
    7) echo "$PROMPTS_DIR/07_travel_booking.txt" ;;
    8) echo "$PROMPTS_DIR/08_fitness_coaching.txt" ;;
    9) echo "$PROMPTS_DIR/09_project_management_dashboard.txt" ;;
    10) echo "$PROMPTS_DIR/10_browser_3d_game.txt" ;;
    *) return 1 ;;
  esac
}

main() {
  check_server_auth

  echo "Output directory: $OUT_DIR"
  echo "Provider/model: ${PROVIDER}/${MODEL}"
  echo "Workspace backend: $WORKSPACE_BACKEND"
  echo "Run timeout (after start): ${RUN_TIMEOUT_SEC}s"

  local summary_json="$OUT_DIR/summary.json"
  echo "[]" >"$summary_json"

  for n in $(seq 1 10); do
    local name prompt_file prompt
    name="$(case_name_for "$n")"
    prompt_file="$(prompt_file_for "$n")"

    if [[ ! -f "$prompt_file" ]]; then
      echo "Missing prompt file: $prompt_file" >&2
      exit 1
    fi

    prompt="$(cat "$prompt_file")"
    echo ""
    echo "[$n/10] Starting: $name"

    local run_id
    run_id="$(create_run "$prompt")"
    echo "  runId: $run_id"

    local run_dir
    run_dir="$RUNS_DIR/${n}_${name}_${run_id}"
    mkdir -p "$run_dir"

    echo "$prompt" >"$run_dir/prompt.txt"

    local final_run_json
    final_run_json="$(poll_until_terminal "$run_id")"
    echo "$final_run_json" >"$run_dir/run.json"

    local events_json sandbox_id status
    events_json="$(api_get_json "${BASE_URL}/runs/${run_id}/events")"
    echo "$events_json" >"$run_dir/events.json"
    sandbox_id="$(echo "$events_json" | jq -r '[.[] | select(.type=="status") | .payload.sandboxId] | map(select(.!=null)) | .[0] // empty')"
    status="$(echo "$final_run_json" | jq -r '.status')"

    local zip_path=""
    local zip_ok=false

    if [[ -n "$sandbox_id" ]]; then
      zip_path="$ZIPS_DIR/${n}_${name}_${run_id}_${sandbox_id}.zip"
      echo "  sandboxId: $sandbox_id"
      echo "  downloading zip..."
      if download_zip "$sandbox_id" "$zip_path"; then
        zip_ok=true
        echo "  zip: $zip_path"
      else
        echo "  zip download failed for sandboxId=$sandbox_id" >&2
      fi
    else
      echo "  sandboxId: (none found)" >&2
    fi

    local record
    record="$(jq -n \
      --arg n "$n" \
      --arg name "$name" \
      --arg runId "$run_id" \
      --arg status "$status" \
      --arg sandboxId "$sandbox_id" \
      --arg zipPath "$zip_path" \
      --argjson zipOk "$zip_ok" \
      --arg provider "$PROVIDER" \
      --arg model "$MODEL" \
      '{case: ($n|tonumber), name:$name, runId:$runId, status:$status, sandboxId:($sandboxId|select(length>0)), zipPath:($zipPath|select(length>0)), zipOk:$zipOk, provider:$provider, model:$model}')"

    jq --argjson rec "$record" '. + [$rec]' "$summary_json" >"$summary_json.tmp" && mv "$summary_json.tmp" "$summary_json"
  done

  jq -r '[
      "case,name,status,runId,sandboxId,zipOk,zipPath",
      (.[] | [
        (.case|tostring),
        .name,
        .status,
        .runId,
        (.sandboxId // ""),
        (.zipOk|tostring),
        (.zipPath // "")
      ] | @csv)
    ] | .[]' "$summary_json" >"$OUT_DIR/summary.csv"

  # Lightweight markdown report.
  {
    echo "# Z.AI GLM-5 Benchmark Report"
    echo ""
    echo "- Provider/model: ${PROVIDER}/${MODEL}"
    echo "- Workspace backend: ${WORKSPACE_BACKEND}"
    echo "- Output directory: ${OUT_DIR}"
    echo "- Zip download timeout: ${ZIP_MAX_TIME_SEC}s (retries: ${ZIP_RETRIES})"
    echo ""
    echo "## Results"
    echo ""
    jq -r '.[] | "- [" + (.case|tostring) + "] " + .name + ": status=" + .status + ", zipOk=" + (.zipOk|tostring) + (if .zipPath then ", zip=" + .zipPath else "" end)' "$summary_json"
  } >"$OUT_DIR/report.md"

  echo ""
  echo "Done."
  echo "Summary: $OUT_DIR/summary.csv"
  echo "Report:  $OUT_DIR/report.md"
}

main "$@"

