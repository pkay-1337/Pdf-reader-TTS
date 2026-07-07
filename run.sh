#!/bin/bash

# Define colors for terminal output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Starting TTS Backend on port 8000...${NC}"
uvicorn main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

echo -e "${GREEN}Starting Frontend on port 8080...${NC}"
python3 -m http.server 8080 &
FRONTEND_PID=$!

# Trap SIGINT (Ctrl+C) and cleanly kill both processes
trap "echo -e '\nShutting down...'; kill $BACKEND_PID $FRONTEND_PID; exit" INT

echo "----------------------------------------"
echo "✅ App is running!"
echo "➡️  Open http://localhost:8080 in your browser"
echo "Press Ctrl+C to stop both servers."
echo "----------------------------------------"

# Wait keeps the script running so the trap can catch the exit signal
wait
