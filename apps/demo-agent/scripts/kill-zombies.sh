#!/bin/bash
# Kill any zombie voice agent processes before starting a new one

# Get PIDs of LiveKit agent worker processes (excluding this script and grep)
ZOMBIE_PIDS=$(ps aux | grep "job_proc_lazy_main.js.*agent.ts" | grep -v grep | awk '{print $2}')

if [ -n "$ZOMBIE_PIDS" ]; then
    echo "Found zombie agent processes: $ZOMBIE_PIDS"
    echo "$ZOMBIE_PIDS" | xargs kill -9 2>/dev/null
    echo "Killed zombie processes"
else
    echo "No zombie agent processes found"
fi

# Also try pkill as a fallback
pkill -9 -f "job_proc_lazy_main.js.*demo-agent" 2>/dev/null

echo "Cleanup complete"
