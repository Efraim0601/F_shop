#!/usr/bin/env bash
# Mise à jour de F-Shop déjà installé (à lancer en root).
set -euo pipefail
BRANCH="${BRANCH:-claude/meal-ordering-platform-c3oibb}"
cd /opt/f-shop
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
npm ci --omit=dev
cp deploy/f-shop.service /etc/systemd/system/f-shop.service
systemctl daemon-reload
systemctl restart f-shop
echo "F-Shop mis à jour."
