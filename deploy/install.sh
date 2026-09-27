#!/usr/bin/env bash
# Installation de F-Shop sur un serveur Ubuntu/Debian (à lancer en root).
#
#   bash install.sh
#
# Le script ne prend jamais un port déjà utilisé et ne modifie pas les services existants.
# Trois modes, choisis automatiquement selon ce qui occupe le port 80 :
#   nginx  : port 80 libre (ou déjà tenu par nginx) -> nginx + HTTPS Let's Encrypt
#   direct : port 80 pris par un autre serveur web (Caddy, Apache, Docker…)
#            -> F-Shop est publié directement sur un port libre (8080, 8081…), en HTTP
#   caddy  : Caddy tient le port 80 ET vous lancez avec CADDY=1
#            -> un bloc de site dédié à F-Shop est AJOUTÉ au Caddyfile (sauvegardé et
#               validé avant rechargement) ; Caddy fournit le HTTPS automatiquement
#
# Variables facultatives :
#   DOMAIN=mon-domaine.cm   nom de domaine (défaut : <ip>.sslip.io, qui pointe vers ce serveur)
#   EMAIL=moi@exemple.com   email pour le certificat Let's Encrypt (mode nginx)
#   HTTPS=0                 pas de certificat (mode nginx)
#   CADDY=1                 intégrer F-Shop au Caddy existant (HTTPS)
#   SEED=1                  créer les comptes de démo (mot de passe demo123)
#   APP_PORT / PUBLIC_PORT  forcer les ports
#   REPO / BRANCH           dépôt et branche à déployer
set -euo pipefail

REPO="${REPO:-https://github.com/Efraim0601/F_shop.git}"
BRANCH="${BRANCH:-claude/meal-ordering-platform-c3oibb}"
APP_DIR=/opt/f-shop
DATA_DIR=/var/lib/f-shop
SERVICE_FILE=/etc/systemd/system/f-shop.service
CADDYFILE=/etc/caddy/Caddyfile

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script en root (sudo)."; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git iproute2

# ---------- Ports ----------
# Programme qui écoute sur un port TCP (vide si libre ou inconnu)
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p' | head -1; }
# Occupé si ss le voit en écoute OU si une connexion locale aboutit (double vérification)
port_used() { [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ] || (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
first_free() { local p=$1; while port_used "$p"; do p=$((p + 1)); done; echo "$p"; }

# Une installation précédente est arrêtée pour libérer son propre port
PREV_PORT=""
if [ -f "$SERVICE_FILE" ]; then
  PREV_PORT="$(sed -n 's/^Environment=PORT=\([0-9]*\)$/\1/p' "$SERVICE_FILE")"
  systemctl stop f-shop 2>/dev/null || true
fi

OWNER80="$(port_owner 80)"
if ! port_used 80 || [ "$OWNER80" = "nginx" ]; then
  MODE=nginx
elif [ "$OWNER80" = "caddy" ] && [ "${CADDY:-0}" = "1" ] && [ -f "$CADDYFILE" ] && command -v caddy >/dev/null; then
  MODE=caddy
else
  MODE=direct
  echo "!! Le port 80 est déjà utilisé par « ${OWNER80:-programme inconnu} » : il est laissé intact."
fi

if [ "$MODE" = "direct" ]; then
  # L'application écoute elle-même sur le port public
  APP_PORT="${APP_PORT:-${PUBLIC_PORT:-${PREV_PORT:-}}}"
  if [ -z "$APP_PORT" ] || [ "$APP_PORT" -lt 8080 ] || port_used "$APP_PORT"; then APP_PORT="$(first_free 8080)"; fi
  PUBLIC_PORT="$APP_PORT"
  APP_HOST=0.0.0.0
else
  APP_PORT="${APP_PORT:-${PREV_PORT:-}}"
  if [ -z "$APP_PORT" ] || port_used "$APP_PORT"; then APP_PORT="$(first_free 3000)"; fi
  PUBLIC_PORT=80
  APP_HOST=127.0.0.1
fi
if port_used "$APP_PORT"; then echo "!! Le port $APP_PORT est déjà utilisé : $(port_owner "$APP_PORT")"; exit 1; fi

IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')"
DOMAIN="${DOMAIN:-$IP.sslip.io}"
echo "==> Mode : $MODE — port de l'application : $APP_PORT — port public : $PUBLIC_PORT"

# ---------- Nettoyage d'une tentative précédente (nginx installé alors que le port 80 était pris) ----------
if [ "$MODE" != "nginx" ] && dpkg -l nginx 2>/dev/null | grep -q '^.[^n]'; then
  OTHER_SITES="$(ls /etc/nginx/sites-enabled 2>/dev/null | grep -vxE 'default|f-shop' || true)"
  if [ -z "$OTHER_SITES" ] && ! systemctl is-active --quiet nginx; then
    echo "==> Suppression du nginx inutilisé installé lors d'une tentative précédente"
    systemctl disable --now nginx 2>/dev/null || true
    apt-get purge -y nginx nginx-common || true
    dpkg --configure -a || true
  fi
fi

# ---------- Paquets ----------
echo "==> Node.js"
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
sed -e "s/__APP_PORT__/$APP_PORT/" -e "s/__APP_HOST__/$APP_HOST/" deploy/f-shop.service > "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable f-shop
systemctl restart f-shop

open_fw() { if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then for p in "$@"; do ufw allow "$p/tcp"; done; fi; }

# ---------- Publication ----------
URL=""
case "$MODE" in
  nginx)
    echo "==> nginx"
    apt-get install -y nginx
    OTHER_SITES="$(ls /etc/nginx/sites-enabled 2>/dev/null | grep -vxE 'default|f-shop' || true)"
    SERVER_NAME="$DOMAIN $IP"
    if [ -z "$OTHER_SITES" ]; then rm -f /etc/nginx/sites-enabled/default; SERVER_NAME="$DOMAIN $IP _"; fi
    sed -e "s/__SERVER_NAME__/$SERVER_NAME/" -e "s/__PUBLIC_PORT__/80/g" -e "s/__APP_PORT__/$APP_PORT/" \
      deploy/nginx.conf > /etc/nginx/sites-available/f-shop
    ln -sf /etc/nginx/sites-available/f-shop /etc/nginx/sites-enabled/f-shop
    nginx -t
    systemctl enable nginx
    systemctl reload nginx || systemctl restart nginx
    open_fw 80 443
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
    ;;
  caddy)
    echo "==> Ajout d'un site F-Shop dans Caddy ($CADDYFILE)"
    BACKUP="$CADDYFILE.bak-fshop-$(date +%Y%m%d%H%M%S)"
    cp "$CADDYFILE" "$BACKUP"
    # Remplace un éventuel bloc F-Shop précédent, n'altère rien d'autre
    sed -i '/^# F-Shop BEGIN/,/^# F-Shop END/d' "$CADDYFILE"
    printf '\n# F-Shop BEGIN (ajouté par deploy/install.sh)\n%s {\n\trequest_body {\n\t\tmax_size 6MB\n\t}\n\treverse_proxy 127.0.0.1:%s\n}\n# F-Shop END\n' \
      "$DOMAIN" "$APP_PORT" >> "$CADDYFILE"
    if caddy validate --config "$CADDYFILE" --adapter caddyfile && systemctl reload caddy; then
      URL="https://$DOMAIN"
      echo "   Sauvegarde de l'ancien Caddyfile : $BACKUP"
    else
      echo "!! Caddyfile invalide : restauration de la sauvegarde, Caddy n'est pas modifié."
      cp "$BACKUP" "$CADDYFILE"
      MODE=caddy-failed
    fi
    open_fw 443
    ;;
  direct)
    open_fw "$APP_PORT"
    URL="http://$IP:$APP_PORT"
    ;;
esac

# ---------- Vérifications ----------
echo "==> Vérifications"
ok=1
check() { # libellé, url, [options curl]
  local label=$1 url=$2; shift 2
  local code; code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" "$url" 2>/dev/null)" || true
  if [ "$code" = "200" ]; then echo "  OK    $label ($url)"; else echo "  ÉCHEC $label ($url) -> HTTP ${code:-000}"; ok=0; fi
}
for _ in $(seq 1 15); do curl -fsS -o /dev/null "http://127.0.0.1:$APP_PORT/api/shops" 2>/dev/null && break; sleep 1; done
check "application"      "http://127.0.0.1:$APP_PORT/api/shops"
[ "$MODE" = "direct" ] && check "adresse publique" "http://$IP:$APP_PORT/api/shops"
if [ "$MODE" = "caddy" ]; then
  echo "   Attente du certificat HTTPS de Caddy (jusqu'à 90 s)…"
  for _ in $(seq 1 30); do curl -fsS -o /dev/null --max-time 5 "$URL/api/shops" 2>/dev/null && break; sleep 3; done
fi
[ -n "$URL" ] && check "adresse finale" "$URL/api/shops" -L

echo
echo "Ports en écoute :"
ss -ltnp | awk -v a=":$APP_PORT" 'NR==1 || index($4, a) || $4 ~ /:(80|443)$/'
echo
if [ "$ok" = "1" ]; then
  echo "✅ F-Shop est en ligne : $URL"
  [ "$MODE" = "direct" ] && echo "   Pour le HTTPS (géolocalisation sur téléphone), relancez avec : CADDY=1 bash install.sh"
else
  echo "⚠️  Certaines vérifications ont échoué."
  if [ "$MODE" = "direct" ]; then FW="$PUBLIC_PORT"; else FW="80 et 443"; fi
  echo "   Si seule l'adresse publique échoue, ouvrez le(s) port(s) $FW dans le pare-feu de votre hébergeur."
  [ "$MODE" = "caddy" ] && echo "   Certificat HTTPS : journalctl -u caddy -n 50 --no-pager | grep -i -E 'sslip|error'"
  echo "   Journaux : journalctl -u f-shop -n 50"
fi
