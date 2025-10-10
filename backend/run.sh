#!/bin/bash

# Startup script for ReadAloud FastAPI backend

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Run the FastAPI server
uv run uvicorn main:app --host ${HOST:-0.0.0.0} --port ${PORT:-8000} --reload
