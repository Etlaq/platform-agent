#!/bin/bash

# Script to monitor runs and download completed project zips to /tmp

API_KEY="test-api-key-123"
BASE_URL="http://localhost:4000"
DOWNLOAD_DIR="/tmp/agent-projects"

mkdir -p "$DOWNLOAD_DIR"

echo "Starting to monitor runs... (Ctrl+C to stop)"
echo "Download directory: $DOWNLOAD_DIR"
echo ""

while true; do
    # Get runs with limit 10
    RUNS=$(curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/runs?limit=10")
    
    # Parse each run
    echo "$RUNS" | jq -r '.[] | @json' 2>/dev/null | while read -r run; do
        STATUS=$(echo "$run" | jq -r '.status')
        RUN_ID=$(echo "$run" | jq -r '.id')
        
        if [ "$STATUS" = "completed" ]; then
            # Check if already downloaded
            if [ -f "$DOWNLOAD_DIR/${RUN_ID}.zip" ]; then
                continue
            fi
            
            # Get events to find download path
            EVENTS=$(curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/runs/$RUN_ID/events")
            SANDBOX_ID=$(echo "$EVENTS" | jq -r '.[] | select(.type == "status" and .payload.downloadPath != null) | .payload.sandboxId' 2>/dev/null | head -1)
            
            if [ -n "$SANDBOX_ID" ] && [ "$SANDBOX_ID" != "null" ]; then
                echo "Downloading project for run $RUN_ID (sandbox: $SANDBOX_ID)..."
                curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/sandbox/$SANDBOX_ID/download.zip" -o "$DOWNLOAD_DIR/${RUN_ID}.zip"
                
                if [ $? -eq 0 ] && [ -s "$DOWNLOAD_DIR/${RUN_ID}.zip" ]; then
                    echo "  ✓ Saved to $DOWNLOAD_DIR/${RUN_ID}.zip"
                else
                    echo "  ✗ Failed to download"
                    rm -f "$DOWNLOAD_DIR/${RUN_ID}.zip"
                fi
            else
                # Try alternative - check for nextjsUrl event which also has sandboxId
                SANDBOX_ID=$(echo "$EVENTS" | jq -r '.[] | select(.type == "status" and .payload.nextjsUrl != null) | .payload.sandboxId' 2>/dev/null | head -1)
                if [ -n "$SANDBOX_ID" ] && [ "$SANDBOX_ID" != "null" ]; then
                    echo "Downloading project for run $RUN_ID (sandbox: $SANDBOX_ID)..."
                    curl -s -H "X-Agent-Api-Key: $API_KEY" "$BASE_URL/sandbox/$SANDBOX_ID/download.zip" -o "$DOWNLOAD_DIR/${RUN_ID}.zip"
                    
                    if [ $? -eq 0 ] && [ -s "$DOWNLOAD_DIR/${RUN_ID}.zip" ]; then
                        echo "  ✓ Saved to $DOWNLOAD_DIR/${RUN_ID}.zip"
                    else
                        echo "  ✗ Failed to download"
                        rm -f "$DOWNLOAD_DIR/${RUN_ID}.zip"
                    fi
                fi
            fi
        fi
    done
    
    sleep 10
done
