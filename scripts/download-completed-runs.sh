#!/bin/bash

# Script to monitor runs and download project zips to /tmp
# Downloads while the sandbox is still active

API_KEY="test-api-key-123"
BASE_URL="http://localhost:4000"
DOWNLOAD_DIR="/tmp/agent-projects"

mkdir -p "$DOWNLOAD_DIR"

echo "Monitoring runs and downloading completed project zips..."
echo "Download directory: $DOWNLOAD_DIR"
echo ""

DOWNLOADED=()

download_sandbox() {
    local run_id="$1"
    local sandbox_id="$2"
    local filename="${3:-$run_id}"
    local output_file="$DOWNLOAD_DIR/${filename}.zip"
    
    # Skip if already downloaded
    for d in "${DOWNLOADED[@]}"; do
        if [ "$d" = "$run_id" ]; then
            return 0
        fi
    done
    
    echo "Downloading project for run $run_id (sandbox: $sandbox_id)..."
    
    # Try up to 3 times
    for i in 1 2 3; do
        response=$(curl -s -w "%{http_code}" -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/sandbox/$sandbox_id/download.zip" -o "$output_file")
        
        if [ "$response" = "200" ] && [ -s "$output_file" ]; then
            # Check if it's a valid zip
            if unzip -t "$output_file" >/dev/null 2>&1; then
                echo "  ✓ Saved to $output_file"
                DOWNLOADED+=("$run_id")
                return 0
            else
                echo "  ✗ Invalid zip file, retrying..."
                rm -f "$output_file"
            fi
        else
            # Check for error message
            if [ -f "$output_file" ]; then
                error=$(cat "$output_file")
                if echo "$error" | grep -q "not found"; then
                    echo "  ✗ Sandbox not found (may have expired)"
                    rm -f "$output_file"
                    return 1
                fi
            fi
            echo "  Attempt $i failed, retrying..."
        fi
        sleep 2
    done
    
    echo "  ✗ Failed to download after 3 attempts"
    rm -f "$output_file"
    return 1
}

while true; do
    # Get all runs
    RUNS=$(curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/runs?limit=20")
    
    # Process runs
    echo "$RUNS" | jq -r '.[] | @json' 2>/dev/null | while read -r run; do
        STATUS=$(echo "$run" | jq -r '.status')
        RUN_ID=$(echo "$run" | jq -r '.id')
        
        # Get events - need sandbox ID for completed or error runs
        if [ "$STATUS" = "completed" ] || [ "$STATUS" = "error" ]; then
            EVENTS=$(curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/runs/$RUN_ID/events")
            SANDBOX_ID=$(echo "$EVENTS" | jq -r '.[] | select(.type == "status" and .payload.sandboxId != null) | .payload.sandboxId' 2>/dev/null | head -1)
            
            if [ -n "$SANDBOX_ID" ] && [ "$SANDBOX_ID" != "null" ]; then
                download_sandbox "$RUN_ID" "$SANDBOX_ID"
            fi
        fi
    done
    
    echo "Waiting 10 seconds..."
    sleep 10
done
