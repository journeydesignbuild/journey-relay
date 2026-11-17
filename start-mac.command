#!/bin/bash
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed. Get the LTS version from https://nodejs.org, install it, then double-click this again."
  read -p "Press Enter to close"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing (1-2 minutes)..."
  npm install --no-audit --no-fund || { read -p "Install failed. Press Enter to close"; exit 1; }
fi
npm start
