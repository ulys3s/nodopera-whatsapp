// Genera los workflows de n8n a partir de src/. Uso: node build.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const read = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const cfgFile = path.join(__dirname, 'n8n', 'paths.json');
// Rutas del webhook con sufijo aleatorio (se generan una vez y se conservan)
const paths = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {
  demo: 'wa-demo-' + crypto.randomBytes(5).toString('hex'),
  clientes: 'wa-clientes-' + crypto.randomBytes(5).toString('hex'),
};
if (!paths.diagnostico) paths.diagnostico = 'diag-' + crypto.randomBytes(5).toString('hex');
if (!paths.web) paths.web = 'web-' + crypto.randomBytes(5).toString('hex');
if (!paths.mp) paths.mp = 'mp-' + crypto.randomBytes(6).toString('hex');
fs.writeFileSync(cfgFile, JSON.stringify(paths, null, 2));

const WRAPPER = `
// ---- Adaptador n8n: no editar ----
// Los secretos se leen SOLO de variables de entorno ($env, archivo .env del contenedor);
// nunca pasan por los datos de la ejecución ni quedan guardados en el workflow.
const _crypto = require('crypto');
const _E = $env;
const _pick = (keys) => Object.fromEntries(keys.map((k) => [k, _E[k]]));
const _helpers = this.helpers;
const ctx = {
  env: _pick(ENV_KEYS),
  state: $getWorkflowStaticData('global'),
  now: new Date(),
  http: (o) => _helpers.httpRequest(o),
};
ctx.state.rejected = ctx.state.rejected || 0;

/** Valida X-Hub-Signature-256 = HMAC-SHA256(cuerpo crudo, App Secret). Falla cerrado. */
function firmaValida(raw, header) {
  const secret = _E.WA_APP_SECRET;
  if (!secret) return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(header || '').trim());
  if (!m) return false;
  const esperado = _crypto.createHmac('sha256', secret).update(raw).digest();
  const recibido = Buffer.from(m[1], 'hex');
  return recibido.length === esperado.length && _crypto.timingSafeEqual(recibido, esperado);
}

const _items = $input.all();
const _notify = [];
for (let i = 0; i < _items.length; i++) {
  const it = _items[i];
  try {
    const raw = await _helpers.getBinaryDataBuffer(i, 'data');
    if (!firmaValida(raw, it.json.headers?.['x-hub-signature-256'])) {
      ctx.state.rejected++;
      ctx.state.errors = [{ at: ctx.now.toISOString(), where: 'firma', detail: _E.WA_APP_SECRET ? 'Firma X-Hub-Signature-256 inválida o ausente: mensaje descartado' : 'Falta WA_APP_SECRET en .env: todo se descarta' }, ...(ctx.state.errors || [])].slice(0, 30);
      continue;
    }
    _notify.push(...await handleWebhook(JSON.parse(raw.toString('utf8')), ctx));
  } catch (e) {
    ctx.state.errors = [{ at: ctx.now.toISOString(), where: 'handleWebhook', detail: String(e && e.message || e) }, ...(ctx.state.errors || [])].slice(0, 30);
  }
}
return _notify.map((n) => ({ json: { ...n, to: _E.NOTIFY_TO, from: _E.NOTIFY_FROM } }));
`;

const ENV = {
  demo: ['WA_TOKEN', 'WA_GRAPH_VERSION', 'WA_API_BASE', 'DEMO_PHONE_ID', 'DEMO_MONTHLY_LIMIT', 'NOTIFY_TO', 'NOTIFY_FROM'],
  clientes: ['WA_TOKEN', 'WA_GRAPH_VERSION', 'CLIENTES_PHONE_ID', 'ADMIN_WA', 'ODOO_URL', 'ODOO_DB', 'ODOO_USER', 'ODOO_API_KEY', 'NOTIFY_TO', 'NOTIFY_FROM'],
};

function workflow(kind, title, file) {
  const p = paths[kind];
  const code = `// ${title} · generado por build.js desde src/core.js + src/${file}\n` + read('core.js') + '\n' + read(file) + '\n' + WRAPPER.replace('ENV_KEYS', JSON.stringify(ENV[kind].filter((k) => !k.startsWith('NOTIFY'))));
  return {
    id: kind === 'demo' ? 'nodoperaBotDemo1' : 'nodoperaBotClie1',
    name: title,
    nodes: [
      { id: crypto.randomUUID(), name: 'Meta verifica (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
        webhookId: crypto.randomUUID(), parameters: { httpMethod: 'GET', path: p, responseMode: 'responseNode', options: {} } },
      { id: crypto.randomUUID(), name: 'Responder challenge', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [260, 0],
        parameters: { respondWith: 'text', responseBody: "={{ $json.query['hub.verify_token'] === $env.WA_VERIFY_TOKEN ? $json.query['hub.challenge'] : 'forbidden' }}", options: {} } },
      { id: crypto.randomUUID(), name: 'Mensaje entrante (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 220],
        webhookId: crypto.randomUUID(), parameters: { httpMethod: 'POST', path: p, responseMode: 'onReceived', options: { rawBody: true } } },
      { id: crypto.randomUUID(), name: 'Bot', type: 'n8n-nodes-base.code', typeVersion: 2, position: [480, 220], parameters: { jsCode: code } },
      { id: crypto.randomUUID(), name: 'Avisar a Ulises (correo)', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [720, 220],
        parameters: { fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}', emailFormat: 'text', text: '={{ $json.text }}', options: {} },
        credentials: { smtp: { id: 'smtpNodOpera0001', name: 'SMTP Gmail NodOpera' } } },
    ],
    connections: {
      'Meta verifica (GET)': { main: [[{ node: 'Responder challenge', type: 'main', index: 0 }]] },
      'Mensaje entrante (POST)': { main: [[{ node: 'Bot', type: 'main', index: 0 }]] },
      Bot: { main: [[{ node: 'Avisar a Ulises (correo)', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', timezone: 'America/Mexico_City', saveDataSuccessExecution: 'none' },
    active: false,
    pinData: {},
  };
}
fs.writeFileSync(path.join(__dirname, 'n8n/workflows/bot-demo.json'), JSON.stringify(workflow('demo', 'NodOpera · Bot DEMO WhatsApp', 'demo.js'), null, 2));

// ---------------- Diagnóstico NodOpera (nodopera.com/diagnostico/) ----------------
const DIAG_ENV = ['DIAG_MODO', 'ANTHROPIC_API_KEY', 'DIAG_MODEL', 'TURNSTILE_SECRET', 'DIAG_MONTHLY_LIMIT', 'ODOO_URL', 'ODOO_DB', 'ODOO_USER', 'ODOO_API_KEY'];
const DIAG_WRAPPER = `
// ---- Adaptador n8n: no editar ----
// Secretos SOLO desde $env (.env del contenedor). Siempre devuelve UNA respuesta para "Responder".
const _E = $env;
const _helpers = this.helpers;
const ctx = {
  env: Object.fromEntries(ENV_KEYS.map((k) => [k, _E[k]])),
  state: $getWorkflowStaticData('global'),
  now: new Date(),
  http: (o) => _helpers.httpRequest(o),
};
const _it = $input.first().json;
const _h = _it.headers || {};
const _origin = String(_h.origin || '');
let _out;
try {
  _out = await handleDiagnostico({ method: 'POST', origin: _origin, ip: String(_h['cf-connecting-ip'] || ''),
    body: _it.body, bytes: Buffer.byteLength(JSON.stringify(_it.body || '')) }, ctx);
} catch (e) {
  ctx.state.errors = [{ at: ctx.now.toISOString(), where: 'handleDiagnostico', detail: String(e && e.message || e).slice(0, 300) }, ...(ctx.state.errors || [])].slice(0, 30);
  _out = { status: 500, body: { ok: false, error: 'interno' }, notify: [] };
}
const _cors = DIAG.origins.includes(_origin) ? _origin : DIAG.origins[0];
return [{ json: { status: _out.status, body: _out.body, cors: _cors,
  notify: (_out.notify || []).map((n) => ({ ...n, to: _E.NOTIFY_TO, from: _E.NOTIFY_FROM })) } }];
`;
function diagWorkflow() {
  const prompt = read('prompt-diagnostico.md').trim();
  const code = '// Diagnóstico NodOpera · generado por build.js desde src/core.js + src/reglas-diagnostico.js + src/diagnostico.js + src/prompt-diagnostico.md\n'
    + read('core.js') + '\nconst PROMPT_DIAGNOSTICO = ' + JSON.stringify(prompt) + ';\n' + read('reglas-diagnostico.js') + '\n' + read('diagnostico.js') + '\n'
    + DIAG_WRAPPER.replace('ENV_KEYS', JSON.stringify(DIAG_ENV));
  return {
    id: 'nodoperaDiagnostico1',
    name: 'NodOpera · Diagnóstico (nodopera.com/diagnostico)',
    nodes: [
      { id: crypto.randomUUID(), name: 'Diagnóstico (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: crypto.randomUUID(),
        parameters: { httpMethod: 'POST', path: paths.diagnostico, responseMode: 'responseNode', options: { allowedOrigins: 'https://nodopera.com,https://www.nodopera.com' } } },
      { id: crypto.randomUUID(), name: 'Diagnóstico', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 0], parameters: { jsCode: code } },
      { id: crypto.randomUUID(), name: 'Responder', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [480, 0],
        parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}',
          options: { responseCode: '={{ $json.status }}', responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }, { name: 'Vary', value: 'Origin' }] } } } },
      { id: crypto.randomUUID(), name: 'Solo correos', type: 'n8n-nodes-base.code', typeVersion: 2, position: [720, 0],
        parameters: { jsCode: 'return $input.all().flatMap((i) => (i.json.notify || []).filter((n) => n.to && n.from).map((n) => ({ json: n })));' } },
      { id: crypto.randomUUID(), name: 'Avisar a Ulises (correo)', type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [960, 0], onError: 'continueRegularOutput',
        parameters: { fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}', emailFormat: 'text', text: '={{ $json.text }}', options: {} },
        credentials: { smtp: { id: 'smtpNodOpera0001', name: 'SMTP Gmail NodOpera' } } },
    ],
    connections: {
      'Diagnóstico (POST)': { main: [[{ node: 'Diagnóstico', type: 'main', index: 0 }]] },
      'Diagnóstico': { main: [[{ node: 'Responder', type: 'main', index: 0 }]] },
      Responder: { main: [[{ node: 'Solo correos', type: 'main', index: 0 }]] },
      'Solo correos': { main: [[{ node: 'Avisar a Ulises (correo)', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', timezone: 'America/Mexico_City', saveDataSuccessExecution: 'none' },
    active: false,
    pinData: {},
  };
}
fs.writeFileSync(path.join(__dirname, 'n8n/workflows/diagnostico.json'), JSON.stringify(diagWorkflow(), null, 2));

// ---------------- Formularios y pagos (nodopera.com: tienda, contacto, agenda, instalación, chat) ----------------
const WEB_ENV = ['TURNSTILE_SECRET', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'MP_NOTIFICATION_URL'];
const WEB_WRAPPER = `
// ---- Adaptador n8n: no editar ----
// Secretos SOLO desde $env (.env del contenedor). Siempre devuelve UNA respuesta para "Responder".
const _crypto = require('crypto');
const _E = $env;
const _helpers = this.helpers;
/** Comparación en tiempo constante (claves de pedido). */
function _timingEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && _crypto.timingSafeEqual(x, y);
}
/** Clave secreta de un pedido: 32 caracteres hex aleatorios. */
function _clave() { return _crypto.randomBytes(16).toString('hex'); }
/** x-signature de Mercado Pago: v1 = HMAC-SHA256(secreto, manifiesto) en hex. */
function _hmacEq(secret, manifest, v1) {
  const esperado = _crypto.createHmac('sha256', secret).update(manifest).digest();
  const recibido = Buffer.from(String(v1), 'hex');
  return recibido.length === esperado.length && _crypto.timingSafeEqual(recibido, esperado);
}
const ctx = {
  env: Object.fromEntries(ENV_KEYS.map((k) => [k, _E[k]])),
  state: $getWorkflowStaticData('global'),
  now: new Date(),
  http: (o) => _helpers.httpRequest(o),
};
const _it = $input.first().json;
const _h = _it.headers || {};
const _origin = String(_h.origin || '');
let _out;
try {
  _out = HANDLER_CALL;
} catch (e) {
  ctx.state.errors = [{ at: ctx.now.toISOString(), where: 'HANDLER_NAME', detail: String(e && e.message || e).slice(0, 300) }, ...(ctx.state.errors || [])].slice(0, 30);
  _out = { status: 500, body: { ok: false, error: 'interno' }, notify: [] };
}
return [{ json: { status: _out.status, body: _out.body,
  notify: (_out.notify || []).map((n) => ({ subject: n.subject, text: n.text, to: n.to === 'cliente' ? n.correo : _E.NOTIFY_TO, from: _E.NOTIFY_FROM,
    replyTo: n.to === 'cliente' ? 'ulises@nodopera.com' : (n.replyTo || _E.NOTIFY_TO) })) } }];
`;
const CALLS = {
  web: "await handleWeb({ origin: _origin, ip: String(_h['cf-connecting-ip'] || ''), body: _it.body, bytes: Buffer.byteLength(JSON.stringify(_it.body || '')) }, ctx)",
  mp: 'await handleMP({ headers: _h, query: _it.query || {}, body: _it.body }, ctx)',
};
function webWorkflow() {
  const catalogo = JSON.parse(read('catalogo-tienda.json'));
  const base = '// Formularios y pagos NodOpera · generado por build.js desde src/core.js + src/web.js + src/catalogo-tienda.json\n'
    + read('core.js') + '\nconst CATALOGO = ' + JSON.stringify(catalogo) + ';\n' + read('web.js') + '\n';
  const code = (k, name) => base + WEB_WRAPPER.replace('ENV_KEYS', JSON.stringify(WEB_ENV)).replace('HANDLER_CALL', CALLS[k]).replace('HANDLER_NAME', name);
  const responder = (name, y) => ({ id: crypto.randomUUID(), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [480, y],
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}',
      options: { responseCode: '={{ $json.status }}', responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }, { name: 'Vary', value: 'Origin' }] } } } });
  const correos = (name, y) => ({ id: crypto.randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [720, y],
    parameters: { jsCode: 'return $input.all().flatMap((i) => (i.json.notify || []).filter((n) => n.to && n.from).map((n) => ({ json: n })));' } });
  const mail = (name, y) => ({ id: crypto.randomUUID(), name, type: 'n8n-nodes-base.emailSend', typeVersion: 2.1, position: [960, y], onError: 'continueRegularOutput',
    parameters: { fromEmail: '={{ $json.from }}', toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}', emailFormat: 'text', text: '={{ $json.text }}', options: { appendAttribution: false, replyTo: '={{ $json.replyTo }}' } },
    credentials: { smtp: { id: 'smtpNodOpera0001', name: 'SMTP Gmail NodOpera' } } });
  return {
    id: 'nodoperaWebPagos1',
    name: 'NodOpera · Formularios y pagos (nodopera.com)',
    nodes: [
      { id: crypto.randomUUID(), name: 'Formulario (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: crypto.randomUUID(),
        parameters: { httpMethod: 'POST', path: paths.web, responseMode: 'responseNode', options: { allowedOrigins: 'https://nodopera.com,https://www.nodopera.com' } } },
      { id: crypto.randomUUID(), name: 'Formularios', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 0], parameters: { jsCode: code('web', 'handleWeb') } },
      responder('Responder', 0), correos('Solo correos', 0), mail('Enviar correos', 0),
      { id: crypto.randomUUID(), name: 'Aviso Mercado Pago (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 260], webhookId: crypto.randomUUID(),
        parameters: { httpMethod: 'POST', path: paths.mp, responseMode: 'responseNode', options: {} } },
      { id: crypto.randomUUID(), name: 'Pagos', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 260], parameters: { jsCode: code('mp', 'handleMP') } },
      responder('Responder MP', 260), correos('Solo correos MP', 260), mail('Enviar correos MP', 260),
    ],
    connections: {
      'Formulario (POST)': { main: [[{ node: 'Formularios', type: 'main', index: 0 }]] },
      Formularios: { main: [[{ node: 'Responder', type: 'main', index: 0 }]] },
      Responder: { main: [[{ node: 'Solo correos', type: 'main', index: 0 }]] },
      'Solo correos': { main: [[{ node: 'Enviar correos', type: 'main', index: 0 }]] },
      'Aviso Mercado Pago (POST)': { main: [[{ node: 'Pagos', type: 'main', index: 0 }]] },
      Pagos: { main: [[{ node: 'Responder MP', type: 'main', index: 0 }]] },
      'Responder MP': { main: [[{ node: 'Solo correos MP', type: 'main', index: 0 }]] },
      'Solo correos MP': { main: [[{ node: 'Enviar correos MP', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', timezone: 'America/Mexico_City', saveDataSuccessExecution: 'none' },
    active: false,
    pinData: {},
  };
}
fs.writeFileSync(path.join(__dirname, 'n8n/workflows/formularios-pagos.json'), JSON.stringify(webWorkflow(), null, 2));

console.log('Listo. Rutas de webhook:', paths);
module.exports = { WRAPPER, DIAG_WRAPPER, WEB_WRAPPER };
