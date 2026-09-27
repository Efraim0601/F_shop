#!/usr/bin/env bash
# Installation de F-Shop sur un serveur Ubuntu/Debian (à lancer en root).
#
#   bash install.sh
#
# Variables facultatives :
#   DOMAIN=mon-domaine.cm   nom de domaine (défaut : <ip>.sslip.io, qui pointe vers ce serveur)
#   EMAIL=moi@exemple.com   email pour le certificat HTTPS Let's Encrypt
#   HTTPS=0                 ne pas installer de certificat HTTPS
#   SEED=1                  créer les comptes de démo (mot de passe demo123)
#   REPO / BRANCH           dépôt et branche à déployer
set -euo pipefail

REPO="${REPO:-https://github.com/Efraim0601/F_shop.git}"
BRANCH="${BRANCH:-claude/meal-ordering-platform-c3oibb}"
APP_DIR=/opt/f-shop
DATA_DIR=/var/lib/f-shop

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script en root (sudo)."; exit 1; }

IP="$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')"
DOMAIN="${DOMAIN:-$IP.sslip.io}"

echo "==> Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git nginx
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Utilisateur et dossiers"
id fshop >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin fshop
mkdir -p "$DATA_DIR/uploads"
chown -R fshop:fshop "$DATA_DIR"

echo "==> Code de l'application"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

if [ "${SEED:-0}" = "1" ]; then
  echo "==> Données de démonstration"
  sudo -u fshop env DB_FILE="$DATA_DIR/fshop.db" node --disable-warning=ExperimentalWarning scripts/seed.js
fi

echo "==> Service systemd"
cp deploy/f-shop.service /etc/systemd/system/f-shop.service
systemctl daemon-reload
systemctl enable --now f-shop
systemctl restart f-shop

echo "==> nginx"
sed "s/__SERVER_NAME__/$DOMAIN $IP/g" deploy/nginx.conf > /etc/nginx/sites-available/f-shop
ln -sf /etc/nginx/sites-available/f-shop /etc/nginx/sites-enabled/f-shop
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 'Nginx Full'
fi

URL="http://$DOMAIN"
if [ "${HTTPS:-1}" = "1" ]; then
  echo "==> Certificat HTTPS (nécessaire pour la géolocalisation sur téléphone)"
  apt-get install -y certbot python3-certbot-nginx
  if [ -n "${EMAIL:-}" ]; then MAIL_OPT=(-m "$EMAIL"); else MAIL_OPT=(--register-unsafely-without-email); fi
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${MAIL_OPT[@]}"; then
    URL="https://$DOMAIN"
  else
    echo "!! Certificat non obtenu : l'application reste accessible en HTTP."
  fi
fi

sleep 1
curl -fsS -o /dev/null http://127.0.0.1:3000/api/shops && echo "==> Application démarrée"
echo
echo "F-Shop est en ligne : $URL   (aussi : http://$IP)"
