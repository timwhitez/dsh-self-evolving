#!/bin/bash
# Verifier: check that /app/answer.txt contains "42".
# Writes 1 (pass) or 0 (fail) to /logs/verifier/reward.txt — Harbor's contract.
set -e
apt-get update -qq && apt-get install -y -qq curl > /dev/null 2>&1
curl -LsSf https://astral.sh/uv/0.9.7/install.sh | sh > /dev/null 2>&1
source $HOME/.local/bin/env

mkdir -p /logs/verifier

if [ -f /app/answer.txt ] && [ "$(cat /app/answer.txt | tr -d '[:space:]')" = "42" ]; then
  echo 1 > /logs/verifier/reward.txt
  echo "PASS: answer is 42"
else
  echo 0 > /logs/verifier/reward.txt
  echo "FAIL: answer is not 42 (got: $(cat /app/answer.txt 2>/dev/null || echo MISSING))"
fi
