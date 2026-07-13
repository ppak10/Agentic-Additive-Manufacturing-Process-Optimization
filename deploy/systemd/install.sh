#!/usr/bin/env bash
# Install/refresh the agentic-sls systemd user units and enable lingering so
# they survive logout and start at boot.
#
#   deploy/systemd/install.sh          # install + enable + start
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
UNITS=(agentic-recorder.service agentic-broker.service)

mkdir -p "${UNIT_DIR}"
for u in "${UNITS[@]}"; do
    cp "${HERE}/${u}" "${UNIT_DIR}/${u}"
    echo "installed ${u}"
done

systemctl --user daemon-reload
for u in "${UNITS[@]}"; do
    systemctl --user enable "${u}" >/dev/null
done

# Keep user services running after logout / start them at boot.
loginctl enable-linger "$(whoami)" || echo "enable-linger failed (may need sudo); services stop at logout until fixed"

echo
echo "Start with:   systemctl --user start agentic-recorder agentic-broker"
echo "Status:       systemctl --user status agentic-recorder agentic-broker"
echo "Logs:         journalctl --user -u agentic-recorder -f"
echo
echo "NOTE: units run tsx WITHOUT watch — server code changes need a manual"
echo "      'systemctl --user restart agentic-recorder' at a safe moment."
