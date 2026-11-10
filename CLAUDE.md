# Bot demo de WhatsApp de NodOpera — guía para Claude

- Edita solo `src/*.js`. Luego `node build.js` (regenera `n8n/workflows/bot-demo.json`) y `node test/sim.js` (debe terminar en "TODAS LAS PRUEBAS PASARON").
- Producción: PC de la oficina, WSL, `~/nodopera-whatsapp/n8n` → `./instalar.sh` (idempotente; reimporta y publica el workflow).
- Secretos (WA_TOKEN, WA_APP_SECRET, Gmail) SOLO en `n8n/.env` (gitignored), leídos con `$env`. Nunca ponerlos en el workflow, en git ni en el chat.
- La firma `X-Hub-Signature-256` es obligatoria (falla cerrado). No la desactives.
- Túnel: solo `^/webhook/wa-demo-0451174fb9$` de wa.nodopera.com es público; todo lo demás `http_status:404`.
- No tocar los contenedores de Odoo (`nodopera-prod`) ni Celulares Futuro.
