// Pruebas del Diagnóstico: ejecuta el código del nodo "Diagnóstico" tal como lo correría n8n,
// con la API de Claude, Turnstile y Odoo simulados. Uso: node test/diag.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'n8n/workflows/diagnostico.json'), 'utf8'));
const code = wf.nodes.find((n) => n.name === 'Diagnóstico').parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fn = new AsyncFunction('$input', '$getWorkflowStaticData', '$env', 'require', code);

const BUENO = {
  resumen: 'Tu ferretería vende en mostrador y a crédito, con inventario en Excel. La oportunidad principal es unir ventas, inventario y cobranza.',
  madurez: { nivel: 2, etiqueta: 'Básico', explicacion: 'Tienes registros, pero en hojas separadas.' },
  hallazgos: [1, 2, 3].map((i) => ({ titulo: 'Hallazgo ' + i, detalle: 'Detalle ' + i, evidencia: 'Respuesta ' + i })),
  mejoras: [1, 2, 3].map((i) => ({ titulo: 'Mejora ' + i, que_hacer: 'Hacer ' + i, beneficio: 'Beneficio ' + i, impacto: 'alto', esfuerzo: 'medio', servicio: 'Odoo Systems' })),
  primer_paso: 'Juntar en una sola hoja las ventas de la semana.',
  preguntas_para_llamada: ['¿Cuántas personas capturan?', '¿Qué reporte usas cada lunes?'],
};

function runner(envExtra = {}, claude = () => ({ content: [{ type: 'text', text: JSON.stringify(BUENO) }], stop_reason: 'end_turn' })) {
  const env = { ANTHROPIC_API_KEY: 'sk-test', TURNSTILE_SECRET: 'ts-secret', NOTIFY_TO: 'u@x', NOTIFY_FROM: 'b@x', ...envExtra };
  const state = {};
  const calls = { claude: 0, turnstile: 0, odoo: [] };
  async function httpRequest(o) {
    if (o.url.includes('challenges.cloudflare.com')) {
      calls.turnstile++;
      assert(o.body.includes('secret=ts-secret'));
      return { success: o.body.includes('response=TOKEN-OK') };
    }
    if (o.url === 'https://api.anthropic.com/v1/messages') {
      calls.claude++;
      assert.equal(o.headers['x-api-key'], 'sk-test');
      assert.equal(o.headers['anthropic-version'], '2023-06-01');
      assert.equal(o.body.max_tokens, 2000);
      assert.equal(o.body.model, env.DIAG_MODEL || 'claude-sonnet-5-5');
      assert(o.body.system.startsWith('Eres el consultor de operaciones de NodOpera'));
      const u = JSON.parse(o.body.messages[0].content);
      assert(u.respuestas && u.respuestas.giro);
      return claude(calls.claude, u);
    }
    if (o.url.endsWith('/jsonrpc')) {
      calls.odoo.push(o.body.params);
      return { result: o.body.params.service === 'common' ? 2 : 55 };
    }
    throw new Error('URL no simulada ' + o.url);
  }
  async function call(body, { origin = 'https://nodopera.com', ip = '1.2.3.4' } = {}) {
    const out = await fn.call({ helpers: { httpRequest } }, { first: () => ({ json: { headers: { origin, 'cf-connecting-ip': ip }, body } }) }, () => state, env, require);
    return out[0].json;
  }
  return { call, state, calls };
}

let n = 0;
const body = (o = {}) => ({
  turnstile: 'TOKEN-OK-0123456789',
  respuestas: { giro: 'Ferretería', sucursales: '2', empleados: '6 a 15', canales: ['Mostrador', 'A crédito'], registro: 'Excel',
    facturacion: 'CFDI con el portal del SAT', cobranza: 'Llamadas y libreta', tarea: 'Cuadrar inventario cada viernes', saber: 'Qué productos no se mueven' },
  contacto: { nombre: 'Laura Gómez', empresa: 'Ferretería Ejemplo', correo: `laura${++n}@ejemplo.com`, whatsapp: '33 1234 5678', acepto: true },
  resumen_excel: { filas: 1200, columnas: { fecha: 'Fecha', producto: 'Producto', importe: 'Total' }, ventas_por_mes: [['2026-09', 120000], ['2026-10', 131000]], ticket_promedio: 210.5 },
  ...o,
});

(async () => {
  let r, t;

  // 1) OK completo (con Excel) + Odoo opcional
  t = runner({ ODOO_URL: 'https://odoo.x', ODOO_DB: 'db', ODOO_USER: 'u', ODOO_API_KEY: 'k' });
  r = await t.call(body());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.folio, `DX-${new Date().getFullYear()}-0001`);
  assert.deepEqual(r.body.reporte.hallazgos.length, 3);
  assert.equal(r.cors, 'https://nodopera.com');
  assert.equal(r.notify.length, 1); assert(r.notify[0].subject.startsWith('Nuevo diagnóstico DX-'));
  assert(r.notify[0].subject.endsWith('– Ferretería Ejemplo'));
  assert(r.notify[0].text.includes('https://wa.me/523312345678'));
  assert.equal(t.calls.odoo.length, 2); assert.equal(t.calls.odoo[1].args[3], 'crm.lead');
  assert.equal(t.state.historial.length, 1);
  console.log('✔ OK completo con Excel:', r.body.folio, '· correo:', r.notify[0].subject, '· Odoo crm.lead creado');

  // 2) Sin Excel, sin Odoo, desde www
  t = runner();
  r = await t.call(body({ resumen_excel: undefined }), { origin: 'https://www.nodopera.com' });
  assert.equal(r.status, 200); assert.equal(r.cors, 'https://www.nodopera.com'); assert(r.notify[0].text.includes('Odoo: omitido'));
  console.log('✔ Sin Excel y sin Odoo: 200, Odoo omitido sin error');

  // 3) Turnstile inválido / sin token / sin secreto → 403, sin llamar a Claude
  t = runner();
  r = await t.call(body({ turnstile: 'TOKEN-MALO-123' })); assert.equal(r.status, 403);
  r = await t.call(body({ turnstile: undefined })); assert.equal(r.status, 403);
  assert.equal(t.calls.claude, 0);
  t = runner({ TURNSTILE_SECRET: '' });
  r = await t.call(body()); assert.equal(r.status, 403); assert.equal(t.calls.turnstile, 0);
  assert(t.state.errors[0].detail.includes('TURNSTILE_SECRET'));
  console.log('✔ Turnstile inválido, ausente o sin secreto: 403 (falla cerrado)');

  // 4) Origin ajeno → 403
  t = runner();
  for (const origin of ['https://evil.com', '', 'https://nodopera.com.evil.com', 'http://nodopera.com']) {
    r = await t.call(body(), { origin }); assert.equal(r.status, 403, origin);
  }
  assert.equal(t.calls.turnstile, 0);
  console.log('✔ Origin ajeno: 403 (4 de 4)');

  // 5) Cuerpo gigante / inválido → 400
  t = runner();
  r = await t.call(body({ relleno: 'x'.repeat(31 * 1024) })); assert.equal(r.status, 400); assert.equal(r.body.error, 'tamano');
  r = await t.call(body({ resumen_excel: { x: 'y'.repeat(21 * 1024) } })); assert.equal(r.status, 400);
  r = await t.call(body({ contacto: { nombre: 'A', empresa: 'B', correo: 'no', whatsapp: '1', acepto: false } })); assert.equal(r.status, 400);
  r = await t.call(body({ contacto: { ...body().contacto, acepto: false } })); assert.equal(r.status, 400); assert.equal(r.body.error, 'contacto.acepto');
  r = await t.call(body({ respuestas: { ...body().respuestas, tarea: 't'.repeat(401) } })); assert.equal(r.status, 400);
  r = await t.call(body({ respuestas: { ...body().respuestas, canales: 'Mostrador' } })); assert.equal(r.status, 400);
  assert.equal(t.calls.claude, 0);
  console.log('✔ Cuerpo gigante o con datos inválidos: 400 (6 de 6)');

  // 6) JSON de Claude inválido → un reintento → respaldo genérico y error registrado
  t = runner({}, () => ({ content: [{ type: 'text', text: 'Claro, aquí está tu diagnóstico: {"resumen": "x"}' }], stop_reason: 'end_turn' }));
  r = await t.call(body());
  assert.equal(r.status, 200); assert.equal(t.calls.claude, 2); assert.equal(r.body.reporte.respaldo, true);
  assert(t.state.errors[0].where === 'claude'); assert(r.notify[0].text.includes('RESPALDO'));
  // primer intento malo, segundo bueno (con ```json)
  t = runner({}, (i) => ({ content: [{ type: 'text', text: i === 1 ? 'nada' : '```json\n' + JSON.stringify(BUENO) + '\n```' }] }));
  r = await t.call(body()); assert.equal(r.status, 200); assert.equal(t.calls.claude, 2); assert(!r.body.reporte.respaldo);
  // API caída y sin llave
  t = runner({}, () => { throw new Error('529 overloaded'); });
  r = await t.call(body()); assert.equal(r.status, 200); assert.equal(r.body.reporte.respaldo, true);
  t = runner({ ANTHROPIC_API_KEY: '' }); r = await t.call(body()); assert.equal(r.body.reporte.respaldo, true); assert.equal(t.calls.claude, 0);
  // esquema estricto: etiqueta que no corresponde al nivel, 2 mejoras, servicio desconocido
  for (const malo of [{ ...BUENO, madurez: { nivel: 1, etiqueta: 'Básico', explicacion: 'x' } }, { ...BUENO, mejoras: BUENO.mejoras.slice(0, 2) },
    { ...BUENO, mejoras: [{ ...BUENO.mejoras[0], servicio: 'Marketing' }, ...BUENO.mejoras.slice(1)] }]) {
    t = runner({}, () => ({ content: [{ type: 'text', text: JSON.stringify(malo) }] }));
    r = await t.call(body()); assert.equal(r.body.reporte.respaldo, true);
  }
  console.log('✔ JSON de Claude inválido: reintenta una vez y responde el respaldo genérico (también con API caída o sin llave)');

  // 7) Límites: 2 por correo cada 30 días, 5 por IP al día, tope mensual con aviso una sola vez
  t = runner();
  const mismo = { ...body().contacto, correo: 'repite@ejemplo.com' };
  r = await t.call(body({ contacto: mismo }), { ip: '9.9.9.1' }); assert.equal(r.status, 200);
  r = await t.call(body({ contacto: mismo }), { ip: '9.9.9.2' }); assert.equal(r.status, 200);
  r = await t.call(body({ contacto: mismo }), { ip: '9.9.9.3' }); assert.equal(r.status, 429); assert.equal(r.body.error, 'correo'); assert(r.body.mensaje.includes('Te contactamos'));
  console.log('✔ Límite por correo: el 3.º en 30 días recibe 429 amable');
  t = runner();
  for (let i = 0; i < 5; i++) { r = await t.call(body(), { ip: '8.8.8.8' }); assert.equal(r.status, 200); }
  r = await t.call(body(), { ip: '8.8.8.8' }); assert.equal(r.status, 429); assert.equal(r.body.error, 'ip');
  r = await t.call(body(), { ip: '8.8.4.4' }); assert.equal(r.status, 200);
  console.log('✔ Límite por IP: el 6.º del día recibe 429; otra IP sigue pasando');
  t = runner({ DIAG_MONTHLY_LIMIT: '3' });
  for (let i = 0; i < 3; i++) { r = await t.call(body(), { ip: '7.7.7.' + i }); assert.equal(r.status, 200); }
  const claudeAntes = t.calls.claude;
  r = await t.call(body(), { ip: '7.7.7.10' }); assert.equal(r.status, 429); assert.equal(r.body.error, 'tope'); assert.equal(r.notify.length, 1);
  assert(r.notify[0].subject.includes('tope mensual'));
  r = await t.call(body(), { ip: '7.7.7.11' }); assert.equal(r.status, 429); assert.equal(r.notify.length, 0);
  assert.equal(t.calls.claude, claudeAntes);
  assert.equal(r.body.reporte, undefined);
  console.log('✔ Tope mensual: 429 "te contactamos", aviso por correo una sola vez y sin gastar API');

  // 8) Folios consecutivos e historial ligero
  t = runner();
  const f1 = (await t.call(body())).body.folio, f2 = (await t.call(body())).body.folio;
  assert(/^DX-\d{4}-0001$/.test(f1) && /^DX-\d{4}-0002$/.test(f2));
  assert.deepEqual(Object.keys(t.state.historial[0]).sort(), ['correo', 'empresa', 'fecha', 'folio', 'giro', 'respaldo']);
  console.log('✔ Folios consecutivos', f1, f2, '· historial sin datos de más');

  console.log('\nTODAS LAS PRUEBAS PASARON ✅');
})().catch((e) => { console.error('❌', e); process.exit(1); });
