#!/usr/bin/env bash
# Instala o actualiza el bot demo de WhatsApp en la PC de la oficina (WSL Ubuntu).
# Idempotente: se puede correr las veces que sea; reimporta el workflow con lo último.
set -euo pipefail
cd "$(dirname "$0")"
C="docker compose"

# 1) .env con secretos aleatorios la primera vez
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^N8N_ENCRYPTION_KEY=.*|N8N_ENCRYPTION_KEY=$(openssl rand -hex 24)|" .env
  sed -i "s|^WA_VERIFY_TOKEN=.*|WA_VERIFY_TOKEN=nodopera-$(openssl rand -hex 8)|" .env
  chmod 600 .env
  echo "Creé $(pwd)/.env con llaves aleatorias."
fi
set -a; . ./.env; set +a
faltan=()
for v in WA_TOKEN WA_APP_SECRET DEMO_PHONE_ID; do
  [ -n "${!v:-}" ] || faltan+=("$v")
done
if [ ${#faltan[@]} -gt 0 ]; then
  echo "⚠️  Faltan en $(pwd)/.env: ${faltan[*]}"
  echo "    n8n se instala igual y ya responde la verificación de Meta, pero el bot DESCARTA todos los mensajes"
  echo "    hasta que pegues esos valores y vuelvas a correr ./instalar.sh"
fi

# 2) levantar n8n
$C up -d
echo -n "Esperando a n8n"; for i in $(seq 1 60); do curl -fs http://127.0.0.1:5678/healthz >/dev/null && break; echo -n .; sleep 2; done; echo

# 3) credencial SMTP de Gmail (n8n la cifra al importar; el archivo temporal se borra)
#    Opcional: sin GMAIL_* el bot funciona igual, solo no llegan los correos de leads.
if [ -z "${GMAIL_USER:-}" ] || [ -z "${GMAIL_APP_PASSWORD:-}" ]; then
  echo "⚠️  Sin GMAIL_USER/GMAIL_APP_PASSWORD: los avisos de leads por correo no se enviarán (el bot sí contesta)."
  GMAIL_USER=sin-configurar@example.com; GMAIL_APP_PASSWORD=x
fi
TMP=$(mktemp)
trap 'rm -f "$TMP"; $C exec -T n8n rm -f /tmp/cred.json >/dev/null 2>&1 || true' EXIT
printf '[{"id":"smtpNodOpera0001","name":"SMTP Gmail NodOpera","type":"smtp","data":{"user":"%s","password":"%s","host":"smtp.gmail.com","port":465,"secure":true}}]' \
  "$GMAIL_USER" "$GMAIL_APP_PASSWORD" > "$TMP"
$C cp "$TMP" n8n:/tmp/cred.json
$C exec -T n8n n8n import:credentials --input=/tmp/cred.json

# 4) workflow del bot (mismo id: reemplaza la versión anterior) y publicarlo
$C exec -T n8n n8n import:workflow --input=/import/workflows/bot-demo.json
$C exec -T n8n n8n publish:workflow --id=nodoperaBotDemo1
$C restart n8n >/dev/null

RUTA=$(python3 -c "import json;print(json.load(open('paths.json'))['demo'])")
echo
echo "✅ Bot demo instalado."
echo "   URL de devolución de llamada (Meta): https://wa.nodopera.com/webhook/$RUTA"
echo "   Token de verificación (Meta):        $WA_VERIFY_TOKEN"
echo "   Prueba local: curl \"http://127.0.0.1:5678/webhook/$RUTA?hub.verify_token=$WA_VERIFY_TOKEN&hub.challenge=ok\"  → debe responder ok"
