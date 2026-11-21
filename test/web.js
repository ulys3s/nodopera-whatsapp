// Pruebas de "Formularios y pagos": ejecuta el código de los nodos tal como lo correría n8n,
// con Turnstile y Mercado Pago simulados. Uso: node test/web.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'n8n/workflows/formularios-pagos.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nodo = (n) => new AsyncFunction('$input', '$getWorkflowStaticData', '$env', 'require', wf.nodes.find((x) => x.name === n).parameters.jsCode);
const fWeb = nodo('Formularios'), fMP = nodo('Pagos');
const SECRETO_MP = 'whsec-prueba-123';

// Ningún secreto en el workflow
const json = JSON.stringify(wf);
for (const s of ['ts-secret', 'APP_USR-', 'TEST-', SECRETO_MP]) assert(!json.includes(s), 'secreto dentro del workflow: ' + s);
assert(wf.nodes.find((n) => n.name === 'Formulario (POST)').parameters.options.allowedOrigins === 'https://nodopera.com,https://www.nodopera.com');

function runner(envExtra = {}, mp = {}) {
  const env = { TURNSTILE_SECRET: 'ts-secret', MP_ACCESS_TOKEN: 'tok-prueba', MP_WEBHOOK_SECRET: SECRETO_MP, MP_NOTIFICATION_URL: 'https://wa.nodopera.com/webhook/mp-x',
    NOTIFY_TO: 'ulises@x', NOTIFY_FROM: 'bot@x', ...envExtra };
  const state = {};
  const calls = { turnstile: 0, pref: [], sub: [], pay: [], get: [] };
  const pagos = {};
  async function httpRequest(o) {
    if (o.url.includes('challenges.cloudflare.com')) { calls.turnstile++; assert(o.body.includes('secret=ts-secret')); return { success: o.body.includes('response=TOKEN-OK') }; }
    if (o.url.endsWith('/jsonrpc')) {
      calls.odoo = calls.odoo || []; const a = o.body.params.args;
      if (mp.odooFalla) throw new Error('odoo caído');
      if (o.body.params.method === 'login') return { result: 7 };
      calls.odoo.push(a[5][0]); return { result: { id: 1, number: a[5][0].folio, cuenta_nueva: calls.odoo.length === 1, url: 'https://portal.x/my/servicios/1', crear_clave: 'https://portal.x/web/signup?token=T', recuperar: 'https://portal.x/web/reset_password' } };
    }
    assert.equal(o.headers.Authorization, 'Bearer tok-prueba');
    if (o.url.endsWith('/checkout/preferences')) { calls.pref.push(o); if (mp.prefFalla) throw new Error('500'); return { id: 'PREF-1', init_point: 'https://mp/pref' }; }
    if (o.url.endsWith('/preapproval')) { calls.sub.push(o); return { id: 'SUB-1', init_point: 'https://mp/sub' }; }
    if (o.url.endsWith('/v1/payments') && o.method === 'POST') {
      calls.pay.push(o); assert(o.headers['X-Idempotency-Key']);
      const id = 9000 + calls.pay.length;
      const r = (mp.pago || (() => ({ status: 'approved', status_detail: 'accredited' })))(o.body);
      pagos[id] = { id, transaction_amount: o.body.transaction_amount, external_reference: o.body.external_reference, payment_method_id: o.body.payment_method_id, ...r };
      return pagos[id];
    }
    const m = /\/v1\/payments\/(\d+)$/.exec(o.url);
    if (m && o.method === 'GET') { calls.get.push(m[1]); return mp.consulta ? mp.consulta(m[1]) : pagos[m[1]]; }
    throw new Error('URL no simulada ' + o.url);
  }
  async function web(body, { origin = 'https://nodopera.com', ip = '1.2.3.4' } = {}) {
    const out = await fWeb.call({ helpers: { httpRequest } }, { first: () => ({ json: { headers: { origin, 'cf-connecting-ip': ip }, body } }) }, () => state, env, require);
    return out[0].json;
  }
  async function aviso(dataId, { secreto = SECRETO_MP, ts = Math.floor(Date.now() / 1000), rid = 'req-1', type = 'payment' } = {}) {
    const v1 = crypto.createHmac('sha256', secreto).update(`id:${dataId};request-id:${rid};ts:${ts};`).digest('hex');
    const out = await fMP.call({ helpers: { httpRequest } }, { first: () => ({ json: {
      headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': rid }, query: { 'data.id': String(dataId), type }, body: { type, data: { id: String(dataId) } } } }) }, () => state, env, require);
    return out[0].json;
  }
  return { web, aviso, state, calls, pagos };
}

let n = 0;
const contacto = (o = {}) => ({ nombre: 'Laura Gómez', empresa: 'Ferretería Ejemplo', correo: `laura${++n}@ejemplo.com`, whatsapp: '33 1234 5678', acepto: true, ...o });
const pedido = (o = {}) => ({ tipo: 'pedido', turnstile: 'TOKEN-OK-0123456789', servicio: 'landing-page', paquete: 'landing', detalle: 'Landing para mi ferretería',
  cuando: 'Esta semana', contacto: contacto(), ...o });
const tarjeta = { payment_method_id: 'visa', token: 'abc123TOKEN', installments: 1, issuer_id: '123', payer: { email: 'laura@ejemplo.com', identification: { type: 'RFC', number: 'XAXX010101000' } } };

(async () => {
  // ---------- contacto ----------
  {
    const R = runner();
    let r = await R.web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Quiero cotizar soporte para 8 equipos', contacto: contacto() });
    assert.equal(r.status, 200); assert(/^MSG-\d{4}-0001$/.test(r.body.folio));
    assert.equal(r.notify.length, 2);
    assert.equal(r.notify[0].to, 'ulises@x'); assert(r.notify[0].replyTo.startsWith('laura'));
    assert(r.notify[1].to.startsWith('laura')); assert.equal(r.notify[1].replyTo, 'ulises@nodopera.com');
    assert(r.notify[0].text.includes('wa.me/523312345678'));
    // Turnstile malo / sin secreto / origen ajeno / tamaño
    r = await R.web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-MALO-0123456', mensaje: 'Hola hola', contacto: contacto() }); assert.equal(r.status, 403);
    r = await runner({ TURNSTILE_SECRET: '' }).web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto() }); assert.equal(r.status, 403);
    r = await R.web({ tipo: 'contacto', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola', contacto: contacto() }, { origin: 'https://evil.com' }); assert.equal(r.status, 403);
    r = await R.web({ tipo: 'contacto', turnstile: 'TOKEN-OK-0123456789', mensaje: 'x'.repeat(13000), contacto: contacto() }); assert.equal(r.status, 400);
    // validaciones
    r = await R.web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto({ acepto: false }) }); assert.equal(r.body.error, 'contacto.acepto');
    r = await R.web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto({ correo: 'no-es-correo' }) }); assert.equal(r.body.error, 'contacto.correo');
    r = await R.web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto({ correo: '' }) }); assert.equal(r.status, 200);
    r = await R.web({ tipo: 'contacto', origen: 'tienda-mensaje', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto({ correo: '' }) }); assert.equal(r.body.error, 'contacto.correo');
    r = await R.web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto({ correo: '', whatsapp: '' }) }); assert.equal(r.body.error, 'contacto.medio');
    r = await R.web({ tipo: 'contacto', origen: 'chat', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto({ correo: '' }) }); assert.equal(r.status, 200); assert.equal(r.notify.length, 1);
    r = await R.web({ tipo: 'contacto', origen: 'agenda', turnstile: 'TOKEN-OK-0123456789', mensaje: '', extras: { Fecha: 'lunes 10:00', Tema: 'Odoo' }, contacto: contacto() });
    assert.equal(r.status, 200); assert(r.notify[0].text.includes('Fecha: lunes 10:00'));
    r = await R.web({ tipo: 'contacto', origen: 'agenda', turnstile: 'TOKEN-OK-0123456789', extras: { a: { b: 1 } }, contacto: contacto() }); assert.equal(r.body.error, 'campos');
    // límite por IP (10/hora)
    const L = runner(); let ult;
    for (let i = 0; i < 11; i++) ult = await L.web({ tipo: 'contacto', origen: 'portada', turnstile: 'TOKEN-OK-0123456789', mensaje: 'Hola hola', contacto: contacto() }, { ip: '9.9.9.9' });
    assert.equal(ult.status, 429); assert.equal(ult.body.error, 'ip');
    console.log('✓ contacto');
  }

  // ---------- pedido con pago en la página (Brick) ----------
  {
    const R = runner();
    let r = await R.web(pedido());
    assert.equal(r.status, 200); const { folio, clave } = r.body;
    assert(/^NOD-\d{4}-0001$/.test(folio)); assert(/^[a-f0-9]{32}$/.test(clave));
    assert.equal(r.body.total, 584.64); // 504 + 16 %
    assert.equal(r.body.pago.modo, 'brick'); assert.equal(r.body.pago.preference_id, 'PREF-1');
    assert.equal(R.calls.pref[0].body.items[0].unit_price, 584.64);
    assert.equal(R.calls.pref[0].body.external_reference, folio);
    assert.equal(R.calls.pref[0].body.notification_url, 'https://wa.nodopera.com/webhook/mp-x');
    assert.equal(r.notify.length, 2);
    // el precio del navegador se ignora
    r = await R.web(pedido({ precio: 1, total: 1 })); assert.equal(r.body.total, 584.64);
    // paquete inexistente / gratis / sin WhatsApp / RFC malo
    assert.equal((await R.web(pedido({ paquete: 'nada' }))).body.error, 'paquete');
    assert.equal((await R.web(pedido({ servicio: 'consultoria-gratis', paquete: 'llamada' }))).body.error, 'gratis');
    assert.equal((await R.web(pedido({ contacto: contacto({ whatsapp: '' }) }))).body.error, 'contacto.whatsapp');
    assert.equal((await R.web(pedido({ rfc: 'XYZ' }))).body.error, 'rfc');
    assert.equal((await R.web(pedido({ rfc: 'GOLA800101AB1' }))).status, 200);

    // pagar: clave mala → 404; sin formData → 400; aprobado → correos a ambos, una sola vez
    assert.equal((await R.web({ tipo: 'pagar', folio, clave: 'f'.repeat(32), formData: tarjeta })).status, 404);
    assert.equal((await R.web({ tipo: 'pagar', folio, clave, formData: { payment_method_id: 'visa' } })).body.error, 'formData');
    r = await R.web({ tipo: 'pagar', folio, clave, formData: { ...tarjeta, transaction_amount: 1 } });
    assert.equal(r.status, 200); assert.equal(r.body.status, 'approved');
    const pay = R.calls.pay[R.calls.pay.length - 1].body;
    assert.equal(pay.transaction_amount, 584.64); assert.equal(pay.token, 'abc123TOKEN'); assert.equal(pay.external_reference, folio);
    assert.equal(r.notify.length, 2); assert(r.notify[0].subject.startsWith('Pago recibido')); assert(r.notify[1].subject.startsWith('Recibimos tu pago'));
    r = await R.web({ tipo: 'pagar', folio, clave, formData: tarjeta }); assert.equal(r.body.ya, true); assert.equal(r.notify.length, 0);
    r = await R.web({ tipo: 'estado', folio, clave }); assert.equal(r.body.estado, 'Pagado');
    // aviso de MP del mismo pago: no repite correos
    const idPago = Object.keys(R.pagos)[0];
    r = await R.aviso(idPago); assert.equal(r.status, 200); assert.equal(r.notify.length, 0);
    console.log('✓ pedido + pago con tarjeta');
  }

  // ---------- OXXO pendiente → aviso de Mercado Pago lo acredita ----------
  {
    let acreditado = false;
    const R = runner({}, { pago: (b) => (b.payment_method_id === 'oxxo' ? { status: 'pending', status_detail: 'pending_waiting_payment', transaction_details: { external_resource_url: 'https://mp/ticket' } } : { status: 'approved' }),
      consulta: (id) => ({ id, transaction_amount: 584.64, external_reference: 'NOD-' + new Date().getFullYear() + '-0001', payment_method_id: 'oxxo', status: acreditado ? 'approved' : 'pending' }) });
    const { body: { folio, clave } } = await R.web(pedido());
    let r = await R.web({ tipo: 'pagar', folio, clave, formData: { payment_method_id: 'oxxo', payer: { email: 'laura@ejemplo.com' } } });
    assert.equal(r.body.status, 'pending'); assert.equal(r.body.ticket, 'https://mp/ticket'); assert.equal(r.notify.length, 1);
    assert.equal((await R.web({ tipo: 'pagar', folio, clave, formData: { payment_method_id: 'tarjeta_rara' } })).body.error, 'formData');
    acreditado = true;
    r = await R.aviso(9001); assert.equal(r.status, 200); assert.equal(r.notify.length, 2);
    r = await R.aviso(9001); assert.equal(r.notify.length, 0);
    // firmas
    assert.equal((await R.aviso(9001, { secreto: 'otro' })).status, 401);
    assert.equal((await R.aviso(9001, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
    assert.equal((await runner({ MP_WEBHOOK_SECRET: '' }).aviso(9001)).status, 401);
    assert.equal((await R.aviso(9001, { type: 'merchant_order' })).body.ignorado, 'merchant_order');
    console.log('✓ OXXO + aviso firmado');
  }

  // ---------- monto distinto → no marca pagado, avisa a Ulises ----------
  {
    const R = runner({}, { consulta: (id) => ({ id, transaction_amount: 10, external_reference: 'NOD-' + new Date().getFullYear() + '-0001', status: 'approved' }) });
    await R.web(pedido());
    const r = await R.aviso(555);
    assert.equal(r.notify.length, 1); assert(r.notify[0].subject.startsWith('REVISAR'));
    assert.equal(Object.values(R.state.web.pedidos)[0].estado, 'Pendiente de pago');
    console.log('✓ monto no coincide');
  }

  // ---------- rechazado, intentos, plan mensual, sin MP, cotizar ----------
  {
    const R = runner({}, { pago: () => ({ status: 'rejected', status_detail: 'cc_rejected_insufficient_amount' }) });
    const { body: { folio, clave } } = await R.web(pedido());
    let r;
    for (let i = 0; i < 6; i++) r = await R.web({ tipo: 'pagar', folio, clave, formData: tarjeta });
    assert.equal(r.body.status, 'rejected'); assert.equal(r.notify.length, 0);
    assert.equal((await R.web({ tipo: 'pagar', folio, clave, formData: tarjeta })).status, 429);

    r = await R.web(pedido({ servicio: 'equipo-ti-mensual', paquete: 'pro' }));
    assert.equal(r.body.mensual, true); assert.equal(r.body.pago.modo, 'suscripcion'); assert.equal(r.body.total, 4060);
    assert.equal(R.calls.sub[0].body.auto_recurring.transaction_amount, 4060);
    assert.equal((await R.web({ tipo: 'pagar', folio: r.body.folio, clave: r.body.clave, formData: tarjeta })).body.error, 'no_pagable');

    r = await R.web(pedido({ servicio: 'pagina-web', paquete: 'estandar' }));
    assert.equal(r.body.cotizar, true); assert.equal(r.body.pago, null); assert(r.notify[1].text.includes('propuesta'));

    const S = runner({ MP_ACCESS_TOKEN: '' });
    r = await S.web(pedido()); assert.equal(r.status, 200); assert.equal(r.body.pago, null); assert(r.notify[0].text.includes('manda la liga'));
    assert.equal((await S.web({ tipo: 'pagar', folio: r.body.folio, clave: r.body.clave, formData: tarjeta })).status, 503);

    const F = runner({}, { prefFalla: true });
    r = await F.web(pedido()); assert.equal(r.status, 200); assert.equal(r.body.pago, null); assert.equal(F.state.errors[0].where, 'mp.crear');
    const N = runner({}, { consulta: () => { const e = new Error('Request failed with status code 404'); e.httpCode = '404'; throw e; } });
    r = await N.aviso(123456); assert.equal(r.status, 200); assert.equal(r.body.ignorado, 'no-existe');
    const X = runner({}, { consulta: () => { throw new Error('timeout'); } });
    r = await X.aviso(123456); assert.equal(r.status, 500); assert.equal(X.state.errors[0].where, 'mp.consulta');
    const OD = { ODOO_URL: 'https://portal.x', ODOO_DB: 'nodopera', ODOO_USER: 'bot', ODOO_API_KEY: 'k' };
    const O = runner(OD);
    r = await O.web(pedido()); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(O.calls.odoo[0].pago, 'pending'); assert.equal(O.calls.odoo[0].pay_url, 'https://mp/pref'); assert.equal(O.calls.odoo[0].folio, r.body.folio);
    assert(r.notify[1].text.includes('Crea tu contraseña aquí: https://portal.x/web/signup?token=T'));
    const rp = await O.web({ tipo: 'pagar', folio: r.body.folio, clave: r.body.clave, formData: tarjeta });
    assert.equal(rp.body.status, 'approved'); assert.equal(O.calls.odoo[1].pago, 'paid');
    assert(rp.notify[1].text.includes('https://portal.x/web/signup?token=T'));
    const OF = runner(OD, { odooFalla: true });
    r = await OF.web(pedido()); assert.equal(r.status, 200); assert.equal(OF.state.errors[0].where, 'odoo'); assert(!r.notify[1].text.includes('contraseña'));
    console.log('✓ portal de clientes (Odoo): alta al pedir, pagado al cobrar, y el pedido sigue si Odoo falla');
    console.log('✓ rechazos, planes mensuales y modo sin Mercado Pago');
  }

  console.log('TODAS LAS PRUEBAS PASARON ✅');
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
