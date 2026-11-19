# n8n de NodOpera (bot demo de WhatsApp + Diagnóstico) — guía para Claude

- Edita solo `src/*.js` y `src/prompt-diagnostico.md`. Luego `node build.js` (regenera `n8n/workflows/bot-demo.json` y `diagnostico.json`), `node test/sim.js` y `node test/diag.js` (ambos deben terminar en "TODAS LAS PRUEBAS PASARON").
- Producción: PC de la oficina, WSL, `~/nodopera-whatsapp/n8n` → `./instalar.sh` (idempotente; reimporta y publica el workflow).
- Secretos (WA_TOKEN, WA_APP_SECRET, Gmail, ANTHROPIC_API_KEY, TURNSTILE_SECRET, ODOO_*) SOLO en `n8n/.env` (gitignored), leídos con `$env`. Nunca ponerlos en el workflow, en git ni en el chat.
- La firma `X-Hub-Signature-256` es obligatoria (falla cerrado). No la desactives.
- Diagnóstico (`src/diagnostico.js`, `handleDiagnostico`): por defecto SIN IA (`DIAG_MODO=reglas`, motor determinista en `src/reglas-diagnostico.js`; solo cita cifras del resumen del Excel). `DIAG_MODO=ia` usa la API de Claude con respaldo de reglas. Falla cerrado. Turnstile obligatorio (sin `TURNSTILE_SECRET` → 403), solo Origin nodopera.com / www.nodopera.com, cuerpo ≤ 30 KB con esquema estricto, límites 2/correo/30 días, 5/IP/día y `DIAG_MONTHLY_LIMIT` al mes. El Excel NUNCA llega: solo un resumen agregado ≤ 20 KB. No relajes nada de esto.
- Túnel: en wa.nodopera.com solo son públicas `^/webhook/wa-demo-0451174fb9$`, `^/webhook/guia-28232e0a5c$` (checklist de TI, workflow del repo nodopera-linkedin) y `^/webhook/diag-32990aa3fd$` (Diagnóstico); todo lo demás `http_status:404`. Otra ruta pública requiere permiso de Ulises.
- En la PC `~/nodopera-whatsapp` NO es un clon de git: se actualiza copiando `n8n/` (sin `.env`) y corriendo `./instalar.sh`. Ahí también viven archivos que no están en este repo (`docker-compose.override.yml`, `redes/`, `instalar-redes.sh`, `workflows/leads-guia.json`, `workflows/redes-*.json`): no los borres.
- No tocar los contenedores de Odoo (`nodopera-prod`) ni Celulares Futuro.
