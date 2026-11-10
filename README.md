# Bot demo de WhatsApp · NodOpera

Número del bot: **33 1387 1940**. Cualquiera le escribe y prueba, desde su celular, cómo un bot
**toma un pedido** (Taquería El Nodo) o **agenda una cita** (Barbería Nodo). Al final puede tocar
**"Quiero uno así"** y te llega el lead por correo con su liga de WhatsApp.

Tu número **33 2248 8131** se queda como contacto humano, sin bot. El bot solo lo menciona como
"escríbele directo a Ulises".

---

## 1. Cómo funciona

```
Cliente en WhatsApp ──► Meta (WhatsApp Cloud API, oficial y gratis)
                              │  webhook HTTPS
                              ▼
         wa.nodopera.com (Cloudflare Tunnel "nodopera", solo /webhook/*)
                              ▼
     PC de la oficina · WSL · Docker · n8n 2.47.3 · workflow "Bot DEMO"
                              │
                 ┌────────────┴─────────────┐
                 ▼                          ▼
     Responde por la API de Meta     Correo a ulises@nodopera.com (leads)
```

| Pieza | Costo | Nota |
|---|---|---|
| WhatsApp Cloud API (Meta) | $0 hasta 1,000 mensajes/mes por número | Desde el 1-oct-2026 Meta cobra las respuestas pasando de 1,000 al mes. |
| n8n autoalojado | $0 | Corre junto al Odoo de producción, en otro contenedor. |
| Cloudflare Tunnel + WAF | $0 | Ya lo tienes; solo se agrega `wa.nodopera.com`. |
| Chip Telcel 33 1387 1940 | recarga mínima | Recárgalo de vez en cuando para que Telcel no recicle el número. |

**¿Cuánto alcanza gratis?** Una demo completa (pedido o cita) gasta de 9 a 12 mensajes del bot,
así que salen **unas 80 o 90 demos completas al mes**. El bot cuenta sus mensajes y **se calla solo
al llegar a 950** (`DEMO_MONTHLY_LIMIT`). Te manda un correo de aviso y vuelve a contestar el día 1.
Además, cada persona tiene un tope de 60 mensajes al día para que nadie se acabe el cupo.

**La "ventana de 24 horas", en corto:** cuando alguien le escribe al bot, durante las siguientes
24 horas el bot puede contestarle lo que sea. Pasadas 24 horas sin que la persona escriba, el bot ya
no puede mandarle nada, salvo con plantillas aprobadas y pagadas. **Al demo no le afecta**, porque
solo contesta cuando le escriben.

---

## 2. Lo que haces tú en Meta (unos 30 minutos)

> Requisitos: el chip 33 1387 1940 **sin WhatsApp instalado** (si lo tiene: WhatsApp → Ajustes →
> Cuenta → Eliminar cuenta) y en un celular que reciba SMS o llamadas.

1. **Portafolio de negocio:** en business.facebook.com crea "NodOpera" con ulises@nodopera.com.
2. **App:** en developers.facebook.com → *Mis apps* → *Crear app* → caso de uso **"Conectar con
   clientes a través de WhatsApp"** → nombre "NodOpera Bot" → vincúlala al portafolio NodOpera.
3. **Agregar el número:** en la app ve a *WhatsApp → Configuración de la API* → *Agregar número de
   teléfono*.
   - Nombre para mostrar: **NodOpera Demo**. Debe parecerse al nombre del negocio; Meta lo revisa.
   - Categoría: Servicios profesionales. Descripción: "Demostración de bots de WhatsApp de NodOpera".
   - Verifica con SMS o llamada al 33 1387 1940.
   - Copia el **Identificador del número de teléfono** (un número largo, no el teléfono) y el
     **Identificador de la cuenta de WhatsApp Business** (WABA ID).
4. **Token permanente:** business.facebook.com → *Configuración* → *Usuarios del sistema* →
   *Agregar* ("bot-nodopera", rol Administrador).
   - *Asignar activos*: la app (control total) y la cuenta de WhatsApp (control total).
   - *Generar token*: elige la app, caducidad **Nunca**, permisos `whatsapp_business_messaging` y
     `whatsapp_business_management`.
   - Guárdalo: solo se muestra una vez. **No lo mandes por chat**: va directo al `.env` de la PC.
5. **Política de privacidad y modo Live:** en la app, *Configuración → Básica*, pon
   `https://nodopera.com/aviso-privacidad.html` y cambia la app a **Live / Publicada**. En modo
   desarrollo Meta no manda los mensajes reales al webhook.
6. **Webhook** (esto va después de instalar n8n, en el paso 3):
   - *WhatsApp → Configuración* → URL de devolución de llamada y token de verificación (los imprime
     `instalar.sh`) → *Verificar y guardar*.
   - En *Campos del webhook*, suscribe **messages**.

**Comandos de registro.** Si el número aparece como "Pendiente", córrelos una sola vez desde la
terminal de la PC; ya con el `.env` lleno se cargan con `set -a; . ./.env; set +a`. En `pin` va un
PIN de 6 dígitos que tú eliges; guárdalo.
```bash
curl -X POST "https://graph.facebook.com/v23.0/$DEMO_PHONE_ID/register" \
  -H "Authorization: Bearer $WA_TOKEN" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"123456"}'
curl -X POST "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer $WA_TOKEN"
```

**Hoy (10-nov-2026)** el bot usa el **número de prueba** +1 555 159 1885 (Phone ID 1444195448783425):
solo contesta a los destinatarios registrados (tu 33 2248 8131). El 33 1387 1940 quedó bloqueado con
el error #2494070 (negocio sin verificar); si Meta lo libera, cambia `DEMO_PHONE_ID` y corre `./instalar.sh`.
Si sigue bloqueado, el camino es la **verificación del negocio** (Centro de seguridad del portafolio:
constancia de situación fiscal o comprobante de domicilio a nombre del negocio, más el dominio nodopera.com).

IDs (no secretos): App 1451063716386265 · Portafolio 1381685630607928 · WABA 2458693167871717.

---

## 3. Instalación en la PC de la oficina (lo hago yo por Remote Control con tu OK)

```bash
# En WSL Ubuntu de la PC de la oficina
mkdir -p ~/nodopera-whatsapp && cd ~/nodopera-whatsapp   # copiar aquí la carpeta n8n/
./instalar.sh          # 1ª vez: crea .env con llaves aleatorias y levanta n8n (descarta todo hasta tener secretos)
nano .env              # pegar WA_TOKEN, WA_APP_SECRET (y opcional Gmail + contraseña de aplicación)
./instalar.sh          # levanta n8n, crea la credencial SMTP, importa y publica el bot
```

**Correo de avisos:** usa una *contraseña de aplicación* de Google. Se crea en
myaccount.google.com → Seguridad → Verificación en 2 pasos → Contraseñas de aplicaciones. No uses
tu contraseña normal.

**Publicar el webhook (aprobado por Ulises el 10-nov-2026 con 3 condiciones):**
1. *Solo la ruta del webhook es pública; todo lo demás da 404.* En el `config.yml` de cloudflared de
   la PC (`C:\Windows\System32\config\systemprofile\.cloudflared\config.yml`), antes de la regla final:
   ```yaml
     - hostname: wa.nodopera.com
       path: ^/webhook/wa-demo-0451174fb9$
       service: http://localhost:5678
     - hostname: wa.nodopera.com
       service: http_status:404
   ```
   Más `cloudflared tunnel route dns nodopera wa.nodopera.com` y reiniciar el servicio "Cloudflared".
   El editor de n8n, `/rest`, `/healthz` y cualquier otra ruta responden 404 desde internet.
2. *Firma de Meta.* Cada POST se valida con `X-Hub-Signature-256` = HMAC-SHA256(cuerpo crudo, App Secret)
   en comparación de tiempo constante. Si la firma es inválida, falta, o no hay `WA_APP_SECRET`, el
   mensaje se descarta sin contestar (falla cerrado) y se cuenta en `rejected`.
3. *Secretos solo en `.env`.* El nodo Bot los lee con `$env` en el momento; no están en el workflow, ni en
   los datos de ejecución, ni en git (verificado exportando el workflow y revisando la base de n8n).

**Abrir el editor de n8n desde tu Mac:**
```bash
ssh -L 5678:localhost:5678 'admin\ulises'@100.99.12.106   # Mac → PC por Tailscale
# luego abre http://localhost:5678 (la 1ª vez te pide crear el usuario dueño)
```

---

## 4. Probarlo y ponerlo en la web

- Desde tu celular escribe "hola" al 33 1387 1940. Recorre pedido, cita y "Quiero uno así";
  te debe llegar el correo del lead.
- Liga para la página: `https://wa.me/523313871940?text=Hola%2C%20quiero%20probar%20el%20bot`.
  Va en un botón "Pruébalo en WhatsApp", más un QR para tarjetas y presentaciones.
- En n8n → *Executions* ves cada conversación. Los errores de Meta se guardan en los datos estáticos
  del workflow (`errors`).

---

## 5. Cambiar textos, menú o precios

Todo vive en `src/demo.js`; los productos, servicios y horarios están en el objeto `DEMO`.
**No edites el código dentro de n8n.** El flujo es:
```bash
node build.js        # regenera n8n/workflows/bot-demo.json
node test/sim.js     # simulador: conversación completa + validación de límites de Meta
./instalar.sh        # en la PC: reimporta y publica
```

---

## 6. Riesgos y límites (léelos)

| Riesgo | Qué pasa | Mitigación |
|---|---|---|
| La PC de la oficina se apaga o pierde internet | El bot no contesta; Meta reintenta varias horas | Energía/UPS. El bot ignora mensajes de más de 10 min para no contestar fuera de contexto. A futuro: moverlo a un Cloudflare Worker (gratis, siempre encendido). |
| Pasar de 1,000 mensajes/mes | Meta cobraría por mensaje (tarifa de México, centavos de dólar) | El bot se detiene en 950. Sin tarjeta registrada en Meta no hay cargos sorpresa. |
| Nombre "NodOpera Demo" rechazado | El número funciona con límites hasta aprobarlo | Usa "NodOpera" a secas, o verifica el negocio (RFC o comprobante). |
| Mensajes falsos al webhook | Alguien intenta hacerse pasar por Meta | Firma `X-Hub-Signature-256` obligatoria, ruta con sufijo aleatorio, solo su Phone ID, topes por usuario y por mes. |
| Telcel recicla el chip por falta de recarga | Pierdes el número del bot | Recarga mínima cada 2 o 3 meses. |
| Meta retira la versión v23.0 de la API (aprox. 2027) | Los envíos fallan | Cambiar `WA_GRAPH_VERSION` en `.env`. |

---

## Archivos

```
README.md                 esta guía
src/core.js               utilidades: envío por la API de Meta, límites, sesiones, conteo mensual
src/demo.js               conversación del demo (pedidos, citas, lead)
build.js                  genera el workflow importable de n8n
test/sim.js               simulador de conversaciones (node test/sim.js)
n8n/docker-compose.yml    n8n 2.47.3
n8n/.env.example          variables (el .env real nunca va a git)
n8n/instalar.sh           instalación/actualización en la PC
n8n/paths.json            ruta secreta del webhook
n8n/workflows/bot-demo.json  workflow listo para importar
extras/bot-clientes/      bot de soporte con tickets de Odoo (programado, no se usa por ahora)
```
