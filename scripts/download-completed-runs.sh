#!/bin/bash

# Script to monitor runs and download project zips to /tmp
# Downloads while the sandbox is still active - checks frequently during "running" status

API_KEY="test-api-key-123"
BASE_URL="http://localhost:4000"
DOWNLOAD_DIR="/tmp/agent-projects"

mkdir -p "$DOWNLOAD_DIR"

echo "Monitoring runs and downloading completed project zips..."
echo "Download directory: $DOWNLOAD_DIR"
echo ""

download_sandbox() {
    local run_id="$1"
    local sandbox_id="$2"
    local filename="${3:-$run_id}"
    local output_file="$DOWNLOAD_DIR/${filename}.zip"
    
    echo "Downloading project for run $run_id (sandbox: $sandbox_id)..."
    
    # Try up to 5 times with shorter delays
    for i in 1 2 3 4 5; do
        response=$(curl -s -w "%{http_code}" -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/sandbox/$sandbox_id/download.zip" -o "$output_file")
        
        if [ "$response" = "200" ] && [ -s "$output_file" ]; then
            # Check if it's a valid zip
            if unzip -t "$output_file" >/dev/null 2>&1; then
                echo "  ✓ Saved to $output_file"
                return 0
            else
                echo "  ✗ Invalid zip file, retrying..."
                rm -f "$output_file"
            fi
        else
            # Check for error message
            if [ -f "$output_file" ]; then
                error=$(cat "$output_file")
                if echo "$error" | grep -q "not found\|Paused"; then
                    echo "  ✗ Sandbox expired (attempt $i/5)"
                    rm -f "$output_file"
                else
                    echo "  Attempt $i failed (response: $response), retrying..."
                fi
            else
                echo "  Attempt $i failed (response: $response), retrying..."
            fi
        fi
        sleep 3
    done
    
    echo "  ✗ Failed to download after 5 attempts"
    rm -f "$output_file"
    return 1
}

# Track downloaded runs
declare -A DOWNLOADED

while true; do
    # Get all runs
    RUNS=$(curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/runs?limit=20")
    
    # Process runs
    echo "$RUNS" | jq -r '.[] | @json' 2>/dev/null | while read -r run; do
        STATUS=$(echo "$run" | jq -r '.status')
        RUN_ID=$(echo "$run" | jq -r '.id')
        
        # Skip if already downloaded
        if [ "${DOWNLOADED[$RUN_ID]}" = "1" ]; then
            continue
        fi
        
        # Get events - need sandbox ID
        EVENTS=$(curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/runs/$RUN_ID/events")
        SANDBOX_ID=$(echo "$EVENTS" | jq -r '.[] | select(.type == "status" and .payload.sandboxId != null) | .payload.sandboxId' 2>/dev/null | head -1)
        
        if [ -z "$SANDBOX_ID" ] || [ "$SANDBOX_ID" = "null" ]; then
            continue
        fi
        
        # Download if completed or error
        if [ "$STATUS" = "completed" ] || [ "$STATUS" = "error" ]; then
            if download_sandbox "$RUN_ID" "$SANDBOX_ID"; then
                DOWNLOADED[$RUN_ID]=1
            fi
        fi
    done
    
    echo "Waiting 5 seconds..."
    sleep 5
done
