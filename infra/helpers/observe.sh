# Connect to the provisioning agent's tmux session on the stake.
# Usage: seed-observe [stake-ip-or-hostname]
#
# This SSH's to the stake as josh and attaches to ada's provisioning
# tmux session in read-only mode. Press Ctrl-B then d to detach.
# Pass -w to attach read-write (you can type into the session).

STAKE="${1:-seed-stake}"
MODE="readonly"

if [ "${1:-}" = "-w" ]; then
  MODE="readwrite"
  STAKE="${2:-seed-stake}"
elif [ "${2:-}" = "-w" ]; then
  MODE="readwrite"
fi

SESSION="provision"

if [ "$MODE" = "readonly" ]; then
  echo "Attaching to provisioning session on $STAKE (read-only)..."
  echo "Press Ctrl-B then d to detach."
  exec ssh -t "$STAKE" "tmux attach-session -t $SESSION -r 2>/dev/null || echo 'No provisioning session running. Ada may not have started yet.'"
else
  echo "Attaching to provisioning session on $STAKE (read-write)..."
  echo "Press Ctrl-B then d to detach."
  exec ssh -t "$STAKE" "tmux attach-session -t $SESSION 2>/dev/null || echo 'No provisioning session running. Ada may not have started yet.'"
fi
