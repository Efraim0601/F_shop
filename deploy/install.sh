#!/usr/bin/env bash
# Installation de F-Shop sur un serveur Ubuntu/Debian (à lancer en root).
#
#   bash install.sh
#
# Le script ne touche pas aux services déjà présents :
#  - l'application écoute sur un port interne libre (3000 si libre, sinon le suivant) ;
#  - si le port 80 est déjà pris par autre chose que nginx (Apache, Docker…),
#    F-Shop est publié sur un autre port libre (8080, 8081…) et le HTTPS est désactivé ;
#  - les sites nginx existants sont conservés.
#
# Variables facultatives :
#   DOMAIN=mon-domaine.cm   nom de domaine (défaut : <ip>.sslip.io, qui pointe vers ce serveur)
#   EMAIL=moi@exemple.com   email pour le certificat HTTPS Let's Encrypt
#   HTTPS=0                 ne pas installer de certificat HTTPS
#   SEED=1                  créer les comptes de démo (mot de passe demo123)
#   APP_PORT / PUBLIC_PORT  forcer les ports
#   REPO / BRANCH           dépôt et branche à déployer
set -euo pipefail

REPO="${REPO:-https://github.com/Efraim0601/F_shop.git}"
BRANCH="${BRANCH:-claude/meal-ordering-platform-c3oibb}"
APP_DIR=/opt/f-shop
DATA_DIR=/var/lib/f-shop
SERVICE_FILE=/etc/systemd/system/f-shop.service

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script en root (sudo)."; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git iproute2

# ---------- Ports ----------
# Programme qui écoute sur un port TCP (vide si libre)
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p' | head -1; }
# Occupé si ss le voit en écoute OU si une connexion locale aboutit (double vérification)
port_used() { [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ] || (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
first_free() { local p=$1; while port_used "$p"; do p=$((p + 1)); done; echo "$p"; }

# Port interne : on réutilise celui d'une installation précédente, sinon on en cherche un libre
if [ -z "${APP_PORT:-}" ] && [ -f "$SERVICE_FILE" ]; then
  APP_PORT="$(sed -n 's/^Environment=PORT=\([0-9]*\)$/\1/p' "$SERVICE_FILE")"
  systemctl stop f-shop 2>/dev/null || true
fi
APP_PORT="${APP_PORT:-$(first_free 3000)}"
if port_used "$APP_PORT"; then
  echo "!! Le port $APP_PORT est déjà utilisé par : $(port_owner "$APP_PORT")"; exit 1
fi

# Port public : 80 si libre ou tenu par nginx, sinon un port libre à partir de 8080
if [ -z "${PUBLIC_PORT:-}" ]; then
  OWNER80="$(port_owner 80)"
  if ! port_used 80 || [ "$OWNER80" = "nginx" ]; then
    PUBLIC_PORT=80
  else
    PUBLIC_PORT="$(first_free 8080)"
    echo "!! Le port 80 est déjà utilisé par « $OWNER80 » : il est laissé intact, F-Shop sera publié sur le port $PUBLIC_PORT."
  fi
fi
if [ "$PUBLIC_PORT" != "80" ]; then HTTPS=0; fi

IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')"
DOMAIN="${DOMAIN:-$IP.sslip.io}"
echo "==> Port interne de l'application : $APP_PORT — port public : $PUBLIC_PORT"

# ---------- Paquets ----------
echo "==> Paquets système"
apt-get install -y nginx
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# ---------- Application ----------
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
sed "s/__APP_PORT__/$APP_PORT/" deploy/f-shop.service > "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable f-shop
systemctl restart f-shop

# ---------- nginx ----------
echo "==> nginx"
# Si 80 est le port public et qu'aucun autre site n'existe, F-Shop devient le site par défaut (accès par IP)
OTHER_SITES="$(ls /etc/nginx/sites-enabled 2>/dev/null | grep -vxE 'default|f-shop' || true)"
SERVER_NAME="$DOMAIN $IP"
if [ "$PUBLIC_PORT" = "80" ] && [ -z "$OTHER_SITES" ]; then
  rm -f /etc/nginx/sites-enabled/default
  SERVER_NAME="$DOMAIN $IP _"
fi
sed -e "s/__SERVER_NAME__/$SERVER_NAME/" -e "s/__PUBLIC_PORT__/$PUBLIC_PORT/g" -e "s/__APP_PORT__/$APP_PORT/" \
  deploy/nginx.conf > /etc/nginx/sites-available/f-shop
ln -sf /etc/nginx/sites-available/f-shop /etc/nginx/sites-enabled/f-shop
nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$PUBLIC_PORT/tcp"
  [ "${HTTPS:-1}" = "1" ] && ufw allow 443/tcp
fi

SUFFIX=""; [ "$PUBLIC_PORT" != "80" ] && SUFFIX=":$PUBLIC_PORT"
URL="http://$DOMAIN$SUFFIX"
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

# ---------- Vérifications ----------
echo "==> Vérifications"
ok=1
check() { # libellé, url, [options curl]
  local label=$1 url=$2; shift 2
  local code; code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" "$url" || echo 000)"
  if [ "$code" = "200" ]; then echo "  OK   $label ($url)"; else echo "  ÉCHEC $label ($url) -> HTTP $code"; ok=0; fi
}
for _ in $(seq 1 15); do curl -fsS -o /dev/null "http://127.0.0.1:$APP_PORT/api/shops" && break; sleep 1; done
check "application"            "http://127.0.0.1:$APP_PORT/api/shops"
check "nginx (local)"          "http://127.0.0.1:$PUBLIC_PORT/api/shops" -H "Host: $DOMAIN" -L -k
check "adresse publique (IP)"  "http://$IP$SUFFIX/"
check "adresse finale"         "$URL/api/shops"

echo
echo "Ports en écoute :"
ss -ltnp | awk 'NR==1 || /:('"$APP_PORT"'|'"$PUBLIC_PORT"'|443) /'
echo
if [ "$ok" = "1" ]; then
  echo "✅ F-Shop est en ligne : $URL"
else
  echo "⚠️  Certaines vérifications ont échoué. Si seule l'adresse publique échoue,"
  echo "   ouvrez le port $PUBLIC_PORT (et 443) dans le pare-feu de votre hébergeur."
  echo "   Journaux : journalctl -u f-shop -n 50"
fi
