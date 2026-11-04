#!/bin/bash
# Trainer watchdog: relaunches train.py on any exit (GPU faults, OOM, bugs)
# with backoff + crash-loop detection. Resumes from --ckpt automatically.
#
# Usage: export the RL_* env first, then
#   ./supervise.sh genobs --envs 8 --levels ... --ckpt runs/genobs/latest.pt
# Logs: runs/supervise.<tag>.log — launch/exit history with runtimes.
cd "$(dirname "$0")"
TAG="${1:?usage: supervise.sh <tag> [train.py args]}"
shift
PY=/home/alby/ml/venv/bin/python
LOG="runs/supervise.$TAG.log"
FAST=0
while true; do
  echo "[$(date '+%F %T')] launch (fast_crash_streak=$FAST)" >> "$LOG"
  start=$(date +%s)
  "$PY" train.py "$@" >> "runs/$TAG.log" 2>&1 &
  pid=$!
  # stall watchdog: the trainer rewrites latest.pt every iteration (~90s);
  # a live process that stops checkpointing for 15min is a wedge — GPU
  # queue hang, observed twice (one hung the desktop). Kill and count as
  # a crash event so the run auto-recovers instead of burning hours.
  CK="runs/$TAG/latest.pt"
  while kill -0 $pid 2>/dev/null; do
    # zombie children still pass kill -0 — don't mistake a natural exit for a stall
    [ "$(awk '{print $3}' /proc/$pid/stat 2>/dev/null)" = "Z" ] && break
    sleep 60
    last_ck=$start
    [ -f "$CK" ] && [ "$(stat -c %Y "$CK")" -gt "$last_ck" ] && last_ck=$(stat -c %Y "$CK")
    if [ $(( $(date +%s) - last_ck )) -gt 900 ]; then
      echo "[$(date '+%F %T')] stall: no checkpoint write >900s — killing $pid" >> "$LOG"
      kill $pid 2>/dev/null; sleep 10; kill -9 $pid 2>/dev/null
      break
    fi
  done
  wait $pid; rc=$?
  el=$(( $(date +%s) - start ))
  echo "[$(date '+%F %T')] exited rc=$rc after ${el}s" >> "$LOG"
  # died under 5min after launch = crash loop; give up after 5 in a row
  if [ "$el" -lt 300 ]; then
    FAST=$((FAST+1))
    if [ "$FAST" -ge 5 ]; then
      echo "[$(date '+%F %T')] 5 consecutive fast crashes — giving up" >> "$LOG"
      exit 1
    fi
    sleep $((FAST * 60))   # linear backoff on repeated fast crashes
  else
    FAST=0
    sleep 30               # clean-ish exit after real work — brief pause
  fi
done
