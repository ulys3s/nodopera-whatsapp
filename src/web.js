// ============================================================================
// Formularios y pagos de nodopera.com (tienda, contacto, agenda, instalación, chat).
//   handleWeb(req, ctx) → { status, body, notify[] }   webhook POST /webhook/web-…
//   handleMP(req, ctx)  → { status, body, notify[] }   webhook POST /webhook/mp-… (avisos de Mercado Pago)
// Funciones puras: Turnstile y Mercado Pago se llaman SOLO por ctx.http (simulable en test/web.js).
// Reglas: falla cerrado; el precio SIEMPRE sale de CATALOGO (src/catalogo-tienda.json), nunca del navegador;
// los datos de tarjeta nunca pasan por aquí (Mercado Pago los convierte en un token de un solo uso).
// notify[]: { subject, text, to? } — sin "to" va a Ulises (NOTIFY_TO); con to:'cliente' va al correo del cliente.
// ============================================================================

const WEB = {
  origins: ['https://nodopera.com', 'https://www.nodopera.com'],
  maxBytes: 12 * 1024,
  porIpHora: 10,          // formularios por IP por hora
  porCorreoDia: 6,        // formularios por correo por día
  porDia: 400,            // formularios totales por día (tope de seguridad)
  pagosPorFolio: 6,       // intentos de pago por folio
  pedidos: 1500,          // pedidos guardados en memoria del workflow
  tipos: ['contacto', 'pedido', 'pagar', 'estado'],
  origenes: ['portada', 'agenda', 'tienda-mensaje', 'tienda-medida', 'instalacion', 'chat', 'otro'],
  mp: 'https://api.mercadopago.com',
  sitio: 'https://nodopera.com',
};

const RW = (status, body, notify = []) => ({ status, body, notify });

function s_(v, max, min = 0) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return s.length >= min && s.length <= max ? s : null;
}
const opt = (v, max) => (v == null || v === '' ? '' : s_(v, max));
const correoOk = (c) => typeof c === 'string' && c.length <= 120 && /^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i.test(c);
const redondea = (n) => Math.round(n * 100) / 100;
const pesos = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function errW(state, now, where, detail) {
  state.errors = [{ at: now.toISOString(), where, detail: String(detail).slice(0, 300) }, ...(state.errors || [])].slice(0, 30);
}

async function turnstileOk(token, ip, ctx) {
  const secret = ctx.env.TURNSTILE_SECRET;
  if (!secret || typeof token !== 'string' || token.length < 10 || token.length > 4096) return false;
  try {
    const form = 'secret=' + encodeURIComponent(secret) + '&response=' + encodeURIComponent(token) + (ip ? '&remoteip=' + encodeURIComponent(ip) : '');
    const r = await ctx.http({ method: 'POST', url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify', body: form, json: true, timeout: 15000,
      headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const o = typeof r === 'string' ? JSON.parse(r) : r;
    return !!(o && o.success === true);
  } catch (e) { return false; }
}

/** Contacto común a todos los formularios. WhatsApp a 10 dígitos; correo obligatorio solo en la tienda. */
function contactoValido(c, correoObligatorio = true) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'contacto' };
  const o = {
    nombre: s_(c.nombre, 80, 2), empresa: opt(c.empresa, 100),
    correo: typeof c.correo === 'string' ? c.correo.trim().toLowerCase() : '',
    whatsapp: typeof c.whatsapp === 'string' ? c.whatsapp.replace(/\D/g, '').replace(/^52(?=\d{10}$)/, '') : '',
  };
  if (!o.nombre) return { error: 'contacto.nombre' };
  if (o.empresa === null) return { error: 'contacto.empresa' };
  if (correoObligatorio || o.correo) { if (!correoOk(o.correo)) return { error: 'contacto.correo' }; }
  if (o.whatsapp && !/^\d{10}$/.test(o.whatsapp)) return { error: 'contacto.whatsapp' };
  if (!o.whatsapp && !o.correo) return { error: 'contacto.medio' };
  if (c.acepto !== true) return { error: 'contacto.acepto' };
  return { ok: true, c: o };
}

/** Campos extra libres pero acotados (agenda, instalación…): máx. 12 pares texto/texto. */
function extrasValidos(x) {
  if (x == null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) return null;
  const e = Object.entries(x);
  if (e.length > 12) return null;
  const o = {};
  for (const [k, v] of e) {
    const kk = s_(k, 40, 1), vv = s_(v, 1500);
    if (kk === null || vv === null) return null;
    o[kk] = vv;
  }
  return o;
}

/** Límites por IP, correo y día. Devuelve el motivo si se pasa. */
function limites(W, req, correo, now) {
  const t = now.getTime(), hora = 3600000, dia = 86400000;
  for (const k of Object.keys(W.ips)) { W.ips[k] = W.ips[k].filter((x) => t - x < hora); if (!W.ips[k].length) delete W.ips[k]; }
  for (const k of Object.keys(W.correos)) { W.correos[k] = W.correos[k].filter((x) => t - x < dia); if (!W.correos[k].length) delete W.correos[k]; }
  W.dia = W.dia && W.dia.d === now.toISOString().slice(0, 10) ? W.dia : { d: now.toISOString().slice(0, 10), n: 0 };
  if (W.dia.n >= WEB.porDia) return 'tope';
  if (req.ip && (W.ips[req.ip] || []).length >= WEB.porIpHora) return 'ip';
  if (correo && (W.correos[correo] || []).length >= WEB.porCorreoDia) return 'correo';
  if (req.ip) (W.ips[req.ip] = W.ips[req.ip] || []).push(t);
  if (correo) (W.correos[correo] = W.correos[correo] || []).push(t);
  W.dia.n++;
  return null;
}

function nuevoFolio(W, now, pre) {
  const anio = (localParts(now).ym || now.toISOString().slice(0, 7)).slice(0, 4);
  W.folios[pre + anio] = (W.folios[pre + anio] || 0) + 1;
  return `${pre}-${anio}-${String(W.folios[pre + anio]).padStart(4, '0')}`;
}

function lineasContacto(c) {
  return [`Nombre: ${c.nombre}`, c.empresa ? `Empresa: ${c.empresa}` : '', c.correo ? `Correo: ${c.correo}` : '', c.whatsapp ? `WhatsApp: https://wa.me/52${c.whatsapp}` : ''].filter(Boolean);
}

// ------------------------------- Mercado Pago -------------------------------
function mpHeaders(ctx, idem) {
  const h = { Authorization: 'Bearer ' + ctx.env.MP_ACCESS_TOKEN, 'content-type': 'application/json' };
  if (idem) h['X-Idempotency-Key'] = idem;
  return h;
}
const webhookMP = (ctx) => (ctx.env.MP_NOTIFICATION_URL || '').trim();

async function mpPreferencia(p, ctx) {
  const body = {
    items: [{ id: `${p.slug}.${p.paquete}`, title: `${p.titulo} · ${p.paqueteNombre}`.slice(0, 250), quantity: 1, currency_id: 'MXN', unit_price: p.total }],
    payer: { name: p.contacto.nombre, email: p.contacto.correo },
    external_reference: p.folio,
    statement_descriptor: 'NODOPERA',
    back_urls: { success: `${WEB.sitio}/tienda/gracias.html?folio=${p.folio}`, pending: `${WEB.sitio}/tienda/gracias.html?folio=${p.folio}`, failure: `${WEB.sitio}/tienda/${p.slug}.html` },
    auto_return: 'approved',
    metadata: { folio: p.folio },
  };
  if (webhookMP(ctx)) body.notification_url = webhookMP(ctx);
  const r = await ctx.http({ method: 'POST', url: WEB.mp + '/checkout/preferences', json: true, timeout: 20000, headers: mpHeaders(ctx, 'pref-' + p.folio), body });
  if (!r || !r.id) throw new Error('preferencia sin id');
  return { preference_id: r.id, init_point: r.init_point };
}

async function mpSuscripcion(p, ctx) {
  const body = {
    reason: `${p.titulo} · ${p.paqueteNombre}`.slice(0, 250), external_reference: p.folio, payer_email: p.contacto.correo,
    auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: p.total, currency_id: 'MXN' },
    back_url: `${WEB.sitio}/tienda/gracias.html?folio=${p.folio}`, status: 'pending',
  };
  const r = await ctx.http({ method: 'POST', url: WEB.mp + '/preapproval', json: true, timeout: 20000, headers: mpHeaders(ctx, 'sub-' + p.folio), body });
  if (!r || !r.init_point) throw new Error('suscripción sin init_point');
  return { init_point: r.init_point, preapproval_id: r.id };
}

/** formData del Payment Brick → cuerpo de /v1/payments. El monto SIEMPRE es el del pedido guardado. */
function cuerpoPago(p, fd, ctx) {
  if (!fd || typeof fd !== 'object' || Array.isArray(fd)) return null;
  const metodo = s_(fd.payment_method_id, 40, 2);
  if (!metodo || !/^[a-z0-9_]+$/.test(metodo)) return null;
  const email = fd.payer && typeof fd.payer.email === 'string' && correoOk(fd.payer.email.trim()) ? fd.payer.email.trim().toLowerCase() : p.contacto.correo;
  const b = {
    transaction_amount: p.total, description: `${p.titulo} · ${p.paqueteNombre}`.slice(0, 250), payment_method_id: metodo,
    external_reference: p.folio, statement_descriptor: 'NODOPERA', metadata: { folio: p.folio },
    payer: { email, first_name: p.contacto.nombre.split(' ')[0].slice(0, 40) },
  };
  if (webhookMP(ctx)) b.notification_url = webhookMP(ctx);
  if (fd.token != null) {
    const token = s_(fd.token, 64, 8);
    if (!token || !/^[a-zA-Z0-9]+$/.test(token)) return null;
    const cuotas = Number(fd.installments || 1);
    if (!Number.isInteger(cuotas) || cuotas < 1 || cuotas > 24) return null;
    b.token = token; b.installments = cuotas;
    if (fd.issuer_id != null && /^\d{1,12}$/.test(String(fd.issuer_id))) b.issuer_id = String(fd.issuer_id);
    const id = fd.payer && fd.payer.identification;
    if (id && typeof id === 'object' && s_(id.type, 10, 2) && s_(String(id.number || ''), 20, 3)) b.payer.identification = { type: id.type, number: String(id.number) };
  } else if (!['oxxo', 'paycash', 'bancomer', 'banamex', 'serfin', 'debvisa', 'debmaster'].includes(metodo)) {
    return null; // sin token solo se aceptan pagos en efectivo / transferencia que no llevan tarjeta
  }
  return b;
}

function resumenPago(r) {
  const td = r && r.transaction_details || {};
  return { id: r && r.id, status: r && r.status, detalle: r && r.status_detail, metodo: r && r.payment_method_id,
    ticket: td.external_resource_url || (r && r.point_of_interaction && r.point_of_interaction.transaction_data && r.point_of_interaction.transaction_data.ticket_url) || '' };
}

const ESTADOS = { approved: 'Pagado', in_process: 'Pago en revisión', pending: 'Pago pendiente', authorized: 'Pago autorizado',
  rejected: 'Pago rechazado', cancelled: 'Pago cancelado', refunded: 'Pago devuelto', charged_back: 'Contracargo' };

/**
 * Registra (o actualiza) el pedido en el portal de clientes (Odoo): crea su cuenta y su servicio con avance.
 * Nunca tumba el pedido: si Odoo no está configurado o falla, se anota el error y el pedido sigue.
 * pago: 'pending' | 'paid' | 'quote'. Devuelve { url, crear_clave, recuperar, cuenta_nueva } o null.
 */
async function odooServicio(p, ctx, pago, payUrl) {
  const e = ctx.env;
  if (!e.ODOO_URL || !e.ODOO_DB || !e.ODOO_USER || !e.ODOO_API_KEY) return null;
  try {
    const rpc = async (service, method, args) => {
      const r = await ctx.http({ method: 'POST', url: e.ODOO_URL.replace(/\/$/, '') + '/jsonrpc', json: true, timeout: 20000,
        body: { jsonrpc: '2.0', method: 'call', params: { service, method, args } } });
      if (r && r.error) throw new Error(r.error.data && r.error.data.message || r.error.message);
      return r && r.result;
    };
    const uid = await rpc('common', 'login', [e.ODOO_DB, e.ODOO_USER, e.ODOO_API_KEY]);
    if (!uid) throw new Error('login Odoo');
    const r = await rpc('object', 'execute_kw', [e.ODOO_DB, uid, e.ODOO_API_KEY, 'nodopera.service', 'create_from_shop', [{
      folio: p.folio, servicio: p.titulo, paquete: p.paqueteNombre, slug: p.slug, detalle: p.detalle || '', total: p.total, mensual: !!p.mensual,
      pago, pay_url: payUrl || '', contacto: { nombre: p.contacto.nombre, empresa: p.contacto.empresa || '', correo: p.contacto.correo, whatsapp: p.contacto.whatsapp || '' } }]]);
    if (r && r.url) {
      const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) ? u : '');
      p.portal = { url: https(r.url), crear_clave: https(r.crear_clave) || (p.portal && p.portal.crear_clave) || '', recuperar: https(r.recuperar), cuenta_nueva: !!r.cuenta_nueva || !!(p.portal && p.portal.cuenta_nueva) };
    }
    return p.portal || null;
  } catch (err) {
    errW(ctx.state, ctx.now, 'odoo', `${p.folio}: ${String(err && err.message || err)}`);
    return null;
  }
}
/** Descuento de miembro en la tienda (fracción). Lo decide el servidor: se pregunta a Odoo si ese correo es de un miembro vigente. */
const DESC_MIEMBRO = 0.10;
/** ¿El correo pertenece a un miembro vigente (servicio mensual pagado)? Si Odoo no está o falla → false (precio de lista). */
async function odooMiembro(correo, ctx) {
  const e = ctx.env;
  if (!correo || !e.ODOO_URL || !e.ODOO_DB || !e.ODOO_USER || !e.ODOO_API_KEY) return false;
  try {
    const rpc = async (service, method, args) => {
      const r = await ctx.http({ method: 'POST', url: e.ODOO_URL.replace(/\/$/, '') + '/jsonrpc', json: true, timeout: 8000,
        body: { jsonrpc: '2.0', method: 'call', params: { service, method, args } } });
      if (r && r.error) throw new Error(r.error.data && r.error.data.message || r.error.message);
      return r && r.result;
    };
    const uid = await rpc('common', 'login', [e.ODOO_DB, e.ODOO_USER, e.ODOO_API_KEY]);
    if (!uid) throw new Error('login Odoo');
    return (await rpc('object', 'execute_kw', [e.ODOO_DB, uid, e.ODOO_API_KEY, 'res.partner', 'nodopera_member_by_email', [correo]])) === true;
  } catch (err) {
    errW(ctx.state, ctx.now, 'odoo.miembro', String(err && err.message || err));
    return false;
  }
}
/** Avisa al portal que una suscripción se canceló (el servicio mensual deja de contar como membresía). Mejor esfuerzo. */
async function odooCancelaSuscripcion(folio, ctx) {
  const e = ctx.env;
  if (!e.ODOO_URL || !e.ODOO_DB || !e.ODOO_USER || !e.ODOO_API_KEY) return false;
  try {
    const rpc = async (service, method, args) => {
      const r = await ctx.http({ method: 'POST', url: e.ODOO_URL.replace(/\/$/, '') + '/jsonrpc', json: true, timeout: 20000,
        body: { jsonrpc: '2.0', method: 'call', params: { service, method, args } } });
      if (r && r.error) throw new Error(r.error.data && r.error.data.message || r.error.message);
      return r && r.result;
    };
    const uid = await rpc('common', 'login', [e.ODOO_DB, e.ODOO_USER, e.ODOO_API_KEY]);
    if (!uid) throw new Error('login Odoo');
    return (await rpc('object', 'execute_kw', [e.ODOO_DB, uid, e.ODOO_API_KEY, 'nodopera.service', 'cancel_subscription_from_shop', [folio]])) === true;
  } catch (err) {
    errW(ctx.state, ctx.now, 'odoo.cancelar', `${folio}: ${String(err && err.message || err)}`);
    return false;
  }
}

/**
 * Aviso de suscripción (Mercado Pago, tema "Planes y suscripciones"). Se re-consulta a la API:
 * authorized → el servicio mensual queda pagado en el portal; cancelled → se cancela en el portal; lo demás solo se avisa.
 */
async function avisoSuscripcion(dataId, ctx, W) {
  const st = ctx.state, now = ctx.now;
  let r;
  try { r = await ctx.http({ method: 'GET', url: `${WEB.mp}/preapproval/${dataId}`, json: true, timeout: 20000, headers: mpHeaders(ctx) }); }
  catch (e) {
    const code = Number(e && (e.httpCode || e.statusCode || (e.response && (e.response.status || e.response.statusCode)))) || 0;
    if (code === 404 || /\b404\b/.test(String(e && e.message || ''))) return RW(200, { ok: true, ignorado: 'no-existe' });
    errW(st, now, 'mp.suscripcion', `${dataId}: ${String(e && e.message || e)}`); return RW(500, { ok: false });
  }
  const folio = String(r && r.external_reference || ''), estado = String(r && r.status || '');
  if (!/^NOD-\d{4}-\d{4,6}$/.test(folio)) return RW(200, { ok: true, ignorado: 'folio' });
  const p = W.pedidos[folio];
  const notify = [];
  if (estado === 'authorized') {
    if (p && p.mensual && !p.avisoPagado) {
      p.avisoPagado = now.toISOString(); p.estado = 'Suscripción activa'; p.pago = { id: r.id, status: 'approved', metodo: 'suscripción mensual' };
      await odooServicio(p, ctx, 'paid'); notify.push(...correosPagado(p));
    }
  } else if (estado === 'cancelled') {
    if (p) p.estado = 'Suscripción cancelada';
    const ok = await odooCancelaSuscripcion(folio, ctx);
    notify.push({ subject: `Suscripción cancelada ${folio}`, text: `Mercado Pago reporta cancelada la suscripción ${dataId} del folio ${folio}.\nPortal actualizado: ${ok ? 'sí' : 'NO, revísalo a mano en NodOpera Soporte › Servicios'}.` });
  } else if (estado === 'paused') {
    if (p) p.estado = 'Suscripción en pausa';
    notify.push({ subject: `Suscripción en pausa ${folio}`, text: `Mercado Pago reporta en pausa la suscripción ${dataId} del folio ${folio}. Revisa el cobro con el cliente.` });
  }
  return RW(200, { ok: true }, notify);
}

/** Renglones del correo al cliente que lo llevan a su cuenta del portal. */
function lineasPortal(p) {
  const o = p.portal;
  if (!o || !o.url) return [];
  return ['', 'Sigue el avance de tu servicio y escríbenos desde tu cuenta de NodOpera:',
    o.cuenta_nueva && o.crear_clave ? `Crea tu contraseña aquí: ${o.crear_clave}` : o.cuenta_nueva && o.recuperar ? `Crea tu contraseña aquí (usa este mismo correo): ${o.recuperar}` : `Entra aquí: ${o.url}`];
}

function correosPagado(p) {
  const txt = [`Folio: ${p.folio}`, `Servicio: ${p.titulo} · ${p.paqueteNombre}`, `Total: ${pesos(p.total)} MXN (IVA incluido)${p.mensual ? ' al mes' : ''}`,
    `Pago Mercado Pago: ${p.pago && p.pago.id} (${p.pago && p.pago.metodo})`, '', ...lineasContacto(p.contacto)].join('\n');
  return [
    { replyTo: p.contacto.correo, subject: `Pago recibido ${p.folio} – ${p.titulo}`, text: txt + `\n\nProyecto: ${p.detalle || '—'}` },
    { to: 'cliente', correo: p.contacto.correo, subject: `Recibimos tu pago · ${p.folio} · NodOpera`,
      text: [`Hola ${p.contacto.nombre.split(' ')[0]},`, '', `Recibimos tu pago de ${pesos(p.total)} MXN por ${p.titulo} (${p.paqueteNombre}).`,
        `Tu folio es ${p.folio}. Te escribimos en menos de un día hábil para arrancar.`, ...lineasPortal(p), '', 'Si necesitas factura (CFDI), responde este correo con tu constancia de situación fiscal.', '',
        'NodOpera · ulises@nodopera.com · WhatsApp 33 2248 8131', 'https://nodopera.com'].join('\n') },
  ];
}

// --------------------------------- Handlers ---------------------------------
/**
 * req: { origin, ip, body, bytes }
 * body.tipo: 'contacto' | 'pedido' | 'pagar' | 'estado'
 */
async function handleWeb(req, ctx) {
  const st = ctx.state, now = ctx.now;
  st.web = st.web || { ips: {}, correos: {}, folios: {}, pedidos: {}, orden: [] };
  const W = st.web;
  if (!WEB.origins.includes(req.origin)) return RW(403, { ok: false, error: 'origen' });
  if (!(req.bytes > 0) || req.bytes > WEB.maxBytes) return RW(400, { ok: false, error: 'tamano' });
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b) || !WEB.tipos.includes(b.tipo)) return RW(400, { ok: false, error: 'tipo' });

  // ---- pagar / estado: no llevan Turnstile; se autentican con folio + clave secreta del pedido ----
  if (b.tipo === 'pagar' || b.tipo === 'estado') {
    const folio = s_(b.folio, 20, 8), clave = s_(b.clave, 64, 16);
    const p = folio && W.pedidos[folio];
    if (!p || !clave || clave.length !== p.clave.length || !_timingEq(clave, p.clave)) return RW(404, { ok: false, error: 'pedido' });
    if (b.tipo === 'estado') return RW(200, { ok: true, folio, estado: p.estado, pago: p.pago ? { status: p.pago.status, ticket: p.pago.ticket || '' } : null });
    if (!ctx.env.MP_ACCESS_TOKEN) return RW(503, { ok: false, error: 'pagos_apagados' });
    if (!(p.total > 0) || p.mensual) return RW(400, { ok: false, error: 'no_pagable' });
    if (p.pago && p.pago.status === 'approved') return RW(200, { ok: true, folio, status: 'approved', ya: true });
    p.intentos = (p.intentos || 0) + 1;
    if (p.intentos > WEB.pagosPorFolio) return RW(429, { ok: false, error: 'intentos' });
    const cuerpo = cuerpoPago(p, b.formData, ctx);
    if (!cuerpo) return RW(400, { ok: false, error: 'formData' });
    let r;
    try {
      r = await ctx.http({ method: 'POST', url: WEB.mp + '/v1/payments', json: true, timeout: 30000,
        headers: mpHeaders(ctx, `pay-${p.folio}-${p.intentos}`), body: cuerpo });
    } catch (e) {
      const det = e && e.response && e.response.body;
      errW(st, now, 'mp.pago', `${p.folio}: ${String(e && e.message || e)} ${det ? JSON.stringify(det).slice(0, 200) : ''}`);
      return RW(502, { ok: false, error: 'mp' });
    }
    p.pago = resumenPago(r);
    p.estado = ESTADOS[p.pago.status] || p.pago.status || 'Pago enviado';
    const notify = [];
    if (p.pago.status === 'approved' && !p.avisoPagado) { p.avisoPagado = now.toISOString(); await odooServicio(p, ctx, 'paid'); notify.push(...correosPagado(p)); }
    else if (p.pago.status === 'pending' || p.pago.status === 'in_process') notify.push({ subject: `Pago pendiente ${p.folio} (${p.pago.metodo})`, text: `El cliente eligió ${p.pago.metodo}; Mercado Pago avisará cuando se acredite.\n\n${lineasContacto(p.contacto).join('\n')}` });
    return RW(200, { ok: true, folio: p.folio, status: p.pago.status, detalle: p.pago.detalle, ticket: p.pago.ticket }, notify);
  }

  // ---- contacto / pedido: Turnstile + límites ----
  if (!(await turnstileOk(b.turnstile, req.ip, ctx))) {
    if (!ctx.env.TURNSTILE_SECRET) errW(st, now, 'turnstile', 'Falta TURNSTILE_SECRET en .env: todo se rechaza');
    return RW(403, { ok: false, error: 'verificacion' });
  }
  // Correo obligatorio en la tienda (ahí llega su confirmación y el recibo); en los demás basta WhatsApp o correo
  const cv = contactoValido(b.contacto, b.tipo === 'pedido' || /^tienda/.test(String(b.origen || '')));
  if (!cv.ok) return RW(400, { ok: false, error: cv.error });
  const c = cv.c;

  if (b.tipo === 'contacto') {
    const origen = WEB.origenes.includes(b.origen) ? b.origen : 'otro';
    const mensaje = s_(b.mensaje == null ? '' : b.mensaje, 2000, origen === 'agenda' || origen === 'instalacion' ? 0 : 2);
    const asunto = opt(b.asunto, 120);
    const extras = extrasValidos(b.extras);
    if (mensaje === null) return RW(400, { ok: false, error: 'mensaje' });
    if (asunto === null || extras === null) return RW(400, { ok: false, error: 'campos' });
    const lim = limites(W, req, c.correo, now);
    if (lim) return RW(429, { ok: false, error: lim, mensaje: 'Recibimos muchos mensajes. Escríbenos por WhatsApp al 33 2248 8131.' });
    const folio = nuevoFolio(W, now, 'MSG');
    const ex = Object.entries(extras).map(([k, v]) => `${k}: ${v}`);
    const notify = [{ replyTo: c.correo || undefined, subject: `${asunto || 'Mensaje desde nodopera.com'} · ${folio} · ${c.nombre}${c.empresa ? ' (' + c.empresa + ')' : ''}`,
      text: [`Folio: ${folio}`, `Formulario: ${origen}`, '', ...lineasContacto(c), '', ...(ex.length ? [...ex, ''] : []), mensaje || '—'].join('\n') }];
    if (c.correo) notify.push({ to: 'cliente', correo: c.correo, subject: `Recibimos tu mensaje · ${folio} · NodOpera`,
      text: [`Hola ${c.nombre.split(' ')[0]},`, '', `Recibimos tu mensaje en nodopera.com (folio ${folio}). Te respondemos en menos de un día hábil.`,
        'Si es urgente, escríbenos por WhatsApp: https://wa.me/523322488131', '', 'NodOpera · ulises@nodopera.com', 'https://nodopera.com'].join('\n') });
    return RW(200, { ok: true, folio }, notify);
  }

  // ---- pedido de la tienda ----
  const slug = s_(b.servicio, 60, 2), paq = s_(b.paquete, 40, 2);
  const srv = slug && CATALOGO.servicios[slug];
  const pk = srv && paq && srv.paquetes[paq];
  if (!pk) return RW(400, { ok: false, error: 'paquete' });
  if (pk.precio === 0) return RW(400, { ok: false, error: 'gratis' });
  const detalle = s_(b.detalle, 1500, 2), cuando = opt(b.cuando, 40);
  const rfc = b.rfc ? s_(String(b.rfc).toUpperCase(), 13, 12) : '';
  if (detalle === null) return RW(400, { ok: false, error: 'detalle' });
  if (cuando === null) return RW(400, { ok: false, error: 'cuando' });
  if (rfc === null || (rfc && !/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc))) return RW(400, { ok: false, error: 'rfc' });
  if (!c.whatsapp) return RW(400, { ok: false, error: 'contacto.whatsapp' });
  const lim = limites(W, req, c.correo, now);
  if (lim) return RW(429, { ok: false, error: lim, mensaje: 'Recibimos muchos pedidos. Escríbenos por WhatsApp al 33 2248 8131.' });

  const folio = nuevoFolio(W, now, 'NOD');
  const cotizar = pk.precio == null;
  // Descuento de miembro: solo en pagos únicos con precio; el precio base SIEMPRE es el del catálogo.
  const descuento = !cotizar && !pk.mensual && await odooMiembro(c.correo, ctx) ? DESC_MIEMBRO : 0;
  const precio = cotizar ? null : redondea(pk.precio * (1 - descuento));
  const total = cotizar ? 0 : redondea(precio * (1 + CATALOGO.iva));
  const p = { folio, clave: _clave(), fecha: now.toISOString(), slug, paquete: paq, titulo: srv.titulo, paqueteNombre: pk.n, precio, precioLista: pk.precio, descuento, total,
    mensual: !!pk.mensual, cotizar, contacto: c, detalle, cuando, rfc, estado: cotizar ? 'Cotización solicitada' : 'Pendiente de pago' };
  W.pedidos[folio] = p; W.orden.push(folio);
  while (W.orden.length > WEB.pedidos) delete W.pedidos[W.orden.shift()];

  const resp = { ok: true, folio, clave: p.clave, total, cotizar, mensual: p.mensual, descuento, pago: null };
  if (!cotizar && ctx.env.MP_ACCESS_TOKEN) {
    try {
      if (p.mensual) { const s = await mpSuscripcion(p, ctx); resp.pago = { modo: 'suscripcion', init_point: s.init_point }; }
      else { const pr = await mpPreferencia(p, ctx); resp.pago = { modo: 'brick', preference_id: pr.preference_id, init_point: pr.init_point }; }
    } catch (e) {
      errW(st, now, 'mp.crear', `${folio}: ${String(e && e.message || e)}`);
    }
  }
  await odooServicio(p, ctx, cotizar ? 'quote' : 'pending', resp.pago && resp.pago.init_point);
  const lineas = [`Folio: ${folio}`, `Servicio: ${srv.titulo}`, `Paquete: ${pk.n}${pk.t ? ' (' + pk.t + ')' : ''}`,
    cotizar ? 'Precio: cotización' : `Total: ${pesos(total)} MXN IVA incluido${p.mensual ? ' al mes' : ''}`,
    descuento ? `Descuento de miembro: ${Math.round(descuento * 100)}% (precio de lista ${pesos(pk.precio)} + IVA)` : '',
    `Pago en línea: ${resp.pago ? resp.pago.modo : cotizar ? 'no aplica' : 'NO (falta MP_ACCESS_TOKEN o falló Mercado Pago): manda la liga'}`, '',
    ...lineasContacto(c), rfc ? `RFC: ${rfc}` : '', `Para cuándo: ${cuando || '—'}`, '', `Proyecto: ${detalle}`].filter((x) => x !== '');
  const notify = [{ replyTo: c.correo, subject: `${cotizar ? 'Cotización' : 'Pedido'} ${folio} – ${srv.titulo} · ${c.nombre}`, text: lineas.join('\n') },
    { to: 'cliente', correo: c.correo, subject: `Tu ${cotizar ? 'solicitud' : 'pedido'} ${folio} · NodOpera`,
      text: [`Hola ${c.nombre.split(' ')[0]},`, '', `Recibimos tu ${cotizar ? 'solicitud de cotización' : 'pedido'} de ${srv.titulo} (${pk.n}). Tu folio es ${folio}.`,
        cotizar ? 'Te mandamos la propuesta con alcance, tiempos y precio cerrado en menos de un día hábil.'
          : resp.pago ? `Total: ${pesos(total)} MXN IVA incluido${p.mensual ? ' al mes' : ''}. Si no terminaste el pago, responde este correo y te ayudamos.`
            : `Total: ${pesos(total)} MXN IVA incluido${p.mensual ? ' al mes' : ''}. Te enviamos el enlace de pago de Mercado Pago en menos de un día hábil.`,
        ...lineasPortal(p), '', 'NodOpera · ulises@nodopera.com · WhatsApp 33 2248 8131', 'https://nodopera.com'].join('\n') }];
  return RW(200, resp, notify);
}

/**
 * Aviso de Mercado Pago (webhook). Valida x-signature = HMAC-SHA256(secret, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;").
 * req: { headers, query, body }. Siempre responde rápido; consulta el pago a la API (no confía en el cuerpo).
 */
async function handleMP(req, ctx) {
  const st = ctx.state, now = ctx.now;
  st.web = st.web || { ips: {}, correos: {}, folios: {}, pedidos: {}, orden: [] };
  const W = st.web;
  const secret = ctx.env.MP_WEBHOOK_SECRET;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const q = req.query || {};
  const dataId = String((q['data.id'] != null ? q['data.id'] : b.data && b.data.id) || '').toLowerCase();
  const tipo = String(q.type || b.type || q.topic || '');
  const sig = String(req.headers && req.headers['x-signature'] || '');
  const rid = String(req.headers && req.headers['x-request-id'] || '');
  const m = { ts: (/(?:^|,)\s*ts=([^,]+)/.exec(sig) || [])[1], v1: (/(?:^|,)\s*v1=([a-f0-9]{64})/i.exec(sig) || [])[1] };
  if (!secret) { errW(st, now, 'mp.webhook', 'Falta MP_WEBHOOK_SECRET en .env: avisos descartados'); return RW(401, { ok: false }); }
  if (!m.ts || !m.v1 || !/^[a-z0-9-]{1,40}$/.test(dataId)) return RW(401, { ok: false });
  const manifest = `id:${dataId};${rid ? `request-id:${rid};` : ''}ts:${m.ts};`;
  if (!_hmacEq(secret, manifest, m.v1)) { W.firmasMalas = (W.firmasMalas || 0) + 1; return RW(401, { ok: false }); }
  const tsMs = Number(m.ts) > 1e12 ? Number(m.ts) : Number(m.ts) * 1000;
  if (!(Math.abs(now.getTime() - tsMs) < 15 * 60000)) return RW(401, { ok: false, error: 'viejo' });
  if (tipo === 'subscription_preapproval') return ctx.env.MP_ACCESS_TOKEN ? avisoSuscripcion(dataId, ctx, W) : RW(200, { ok: true });
  if (tipo !== 'payment' || !/^\d+$/.test(dataId)) return RW(200, { ok: true, ignorado: tipo });
  if (!ctx.env.MP_ACCESS_TOKEN) return RW(200, { ok: true });
  let r;
  try { r = await ctx.http({ method: 'GET', url: `${WEB.mp}/v1/payments/${dataId}`, json: true, timeout: 20000, headers: mpHeaders(ctx) }); }
  catch (e) {
    // Pago inexistente (p. ej. "Simular notificación" con un Data ID inventado): se acepta y se ignora,
    // para que Mercado Pago no reintente. Cualquier otro error → 500 (MP reintenta más tarde).
    const code = Number(e && (e.httpCode || e.statusCode || (e.response && (e.response.status || e.response.statusCode)))) || 0;
    if (code === 404 || /\b404\b/.test(String(e && e.message || ''))) return RW(200, { ok: true, ignorado: 'no-existe' });
    errW(st, now, 'mp.consulta', `${dataId}: ${String(e && e.message || e)}`); return RW(500, { ok: false });
  }
  const folio = r && r.external_reference;
  const p = folio && W.pedidos[folio];
  if (!p) { errW(st, now, 'mp.webhook', `Pago ${dataId} con folio desconocido ${folio}`); return RW(200, { ok: true }); }
  if (r.transaction_amount != null && Math.abs(Number(r.transaction_amount) - p.total) > 0.01) {
    errW(st, now, 'mp.monto', `${folio}: monto ${r.transaction_amount} ≠ ${p.total}`);
    return RW(200, { ok: true }, [{ subject: `REVISAR pago ${folio}: el monto no coincide`, text: `Mercado Pago reporta ${r.transaction_amount} y el pedido es ${p.total}. Pago ${dataId}.` }]);
  }
  p.pago = resumenPago(r);
  p.estado = ESTADOS[p.pago.status] || p.pago.status;
  const notify = [];
  if (p.pago.status === 'approved' && !p.avisoPagado) { p.avisoPagado = now.toISOString(); await odooServicio(p, ctx, 'paid'); notify.push(...correosPagado(p)); }
  return RW(200, { ok: true }, notify);
}
