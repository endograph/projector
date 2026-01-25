#!/bin/bash
# Kill any zombie voice agent processes before starting a new one

# Find and kill any processes running the agent
pkill -f "demo-voice-agent" 2>/dev/null
pkill -f "voice-server/agent.ts" 2>/dev/null

# Also kill any tsx/bun processes running livekit agent code from this or similar directories
pkill -f "job_proc_lazy_main.js.*agent.ts" 2>/dev/null

echo "Cleaned up any zombie agent processes"
