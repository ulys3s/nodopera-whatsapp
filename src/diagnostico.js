// ============================================================================
// Diagnóstico NodOpera: recibe las respuestas del asistente de nodopera.com/diagnostico/
// (y, si hubo Excel, solo un RESUMEN agregado calculado en el navegador), valida todo
// fallando cerrado, pide el reporte a la API de Claude y avisa a Ulises por correo.
// Función pura: handleDiagnostico(req, ctx) → { status, body, notify[] }.
// La API de Claude, Turnstile y Odoo se llaman solo a través de ctx.http (simulable).
// ============================================================================

const DIAG = {
  origins: ['https://nodopera.com', 'https://www.nodopera.com'],
  maxBytes: 30 * 1024,
  maxExcelBytes: 20 * 1024,
  porCorreo: 2, diasCorreo: 30,
  porIp: 5,
  limiteMes: 300,
  historial: 500,
  modelo: 'claude-sonnet-5-5',
  etiquetas: ['Manual', 'Básico', 'Ordenado', 'Integrado', 'Inteligente'],
  niveles3: ['alto', 'medio', 'bajo'],
  servicios: ['Soporte TI', 'Infraestructura', 'Odoo Systems', 'Intelligence (tableros)', 'Automatización e IA'],
};

const R = (status, body, notify = []) => ({ status, body, notify });

/** Texto limpio de longitud acotada; null si no es string. */
function str(v, max, min = 0) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return s.length >= min && s.length <= max ? s : null;
}

/** Valida y normaliza el cuerpo. Devuelve { ok, data } o { ok:false, error }. */
function validarDiag(b) {
  const err = (e) => ({ ok: false, error: e });
  if (!b || typeof b !== 'object' || Array.isArray(b)) return err('cuerpo');
  const r = b.respuestas, c = b.contacto;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return err('respuestas');
  if (!c || typeof c !== 'object' || Array.isArray(c)) return err('contacto');
  const lista = (v, maxN, maxL) => Array.isArray(v) && v.length <= maxN && v.every((x) => str(x, maxL, 1) !== null) ? v.map((x) => str(x, maxL, 1)) : null;
  const resp = {
    giro: str(r.giro, 80, 2),
    sucursales: str(r.sucursales, 20, 1),
    empleados: str(r.empleados, 20, 1),
    canales: lista(r.canales, 8, 40),
    registro: str(r.registro, 60, 2),
    facturacion: str(r.facturacion, 200, 2),
    cobranza: str(r.cobranza, 200, 2),
    tarea: str(r.tarea, 400, 0),
    saber: str(r.saber, 400, 0),
  };
  for (const [k, v] of Object.entries(resp)) if (v === null) return err('respuestas.' + k);
  if (!resp.canales.length) return err('respuestas.canales');
  const con = {
    nombre: str(c.nombre, 80, 2),
    empresa: str(c.empresa, 100, 2),
    correo: str(c.correo, 120, 5),
    whatsapp: typeof c.whatsapp === 'string' ? c.whatsapp.replace(/\D/g, '') : null,
    acepto: c.acepto === true,
  };
  if (!con.nombre) return err('contacto.nombre');
  if (!con.empresa) return err('contacto.empresa');
  if (!con.correo || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(con.correo)) return err('contacto.correo');
  con.correo = con.correo.toLowerCase();
  if (!/^\d{10}$/.test(con.whatsapp || '')) return err('contacto.whatsapp');
  if (!con.acepto) return err('contacto.acepto');
  let excel = null;
  if (b.resumen_excel != null) {
    if (typeof b.resumen_excel !== 'object' || Array.isArray(b.resumen_excel)) return err('resumen_excel');
    if (JSON.stringify(b.resumen_excel).length > DIAG.maxExcelBytes) return err('resumen_excel.tamano');
    excel = b.resumen_excel;
  }
  const idioma = b.idioma === 'en' ? 'en' : 'es';
  return { ok: true, data: { respuestas: resp, contacto: con, resumen_excel: excel, idioma } };
}

/** Valida el JSON que devuelve Claude contra la forma exacta pedida en el prompt. */
function reporteValido(x) {
  const s = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n;
  if (!x || typeof x !== 'object') return false;
  if (!s(x.resumen, 900) || !s(x.primer_paso, 600)) return false;
  const m = x.madurez;
  if (!m || !Number.isInteger(m.nivel) || m.nivel < 1 || m.nivel > 5) return false;
  if (DIAG.etiquetas[m.nivel - 1] !== m.etiqueta || !s(m.explicacion, 400)) return false;
  if (!Array.isArray(x.hallazgos) || x.hallazgos.length !== 3) return false;
  if (!x.hallazgos.every((h) => h && s(h.titulo, 90) && s(h.detalle, 500) && s(h.evidencia, 400))) return false;
  if (!Array.isArray(x.mejoras) || x.mejoras.length !== 3) return false;
  if (!x.mejoras.every((h) => h && s(h.titulo, 90) && s(h.que_hacer, 500) && s(h.beneficio, 300)
    && DIAG.niveles3.includes(h.impacto) && DIAG.niveles3.includes(h.esfuerzo) && DIAG.servicios.includes(h.servicio))) return false;
  if (!Array.isArray(x.preguntas_para_llamada) || x.preguntas_para_llamada.length < 2 || x.preguntas_para_llamada.length > 3) return false;
  if (!x.preguntas_para_llamada.every((q) => s(q, 300))) return false;
  return true;
}

/** Extrae el primer objeto JSON del texto (tolera ```json ... ```). */
function extraerJSON(t) {
  if (typeof t !== 'string') return null;
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(t.slice(a, z + 1)); } catch (e) { return null; }
}

/** Reporte genérico cuando la API falla dos veces o no hay llave. No inventa cifras. */
function reporteRespaldo(d) {
  const r = d.respuestas;
  const manual = /papel|nada|excel/i.test(r.registro);
  return {
    resumen: `Gracias por contarnos cómo opera ${d.contacto.empresa}. Con tus respuestas vemos oportunidades claras para ordenar la información de ventas e inventario y ahorrar tiempo en tareas repetitivas; en la llamada las aterrizamos a tu caso.`,
    madurez: manual ? { nivel: 2, etiqueta: 'Básico', explicacion: 'Parte de la operación depende de registros manuales u hojas sueltas.' }
      : { nivel: 3, etiqueta: 'Ordenado', explicacion: 'Ya tienes un sistema, pero todavía hay pasos que se hacen a mano.' },
    hallazgos: [
      { titulo: 'Información repartida en varias herramientas', detalle: `Hoy llevas ventas e inventario en: ${r.registro}. Cuando los datos viven en lugares distintos, cuadrar cifras toma tiempo.`, evidencia: `Registro: ${r.registro}` },
      { titulo: 'Tareas repetitivas que consumen la semana', detalle: r.tarea ? `Mencionaste: "${r.tarea.slice(0, 160)}". Es candidata a automatizarse.` : 'No nos contaste qué tarea te quita más tiempo; lo vemos en la llamada.', evidencia: 'Tarea que más tiempo quita' },
      { titulo: 'Cobranza y facturación por revisar', detalle: `Facturas con: ${r.facturacion}. Cobras así: ${r.cobranza}. Conectar ambas cosas evita olvidos y retrasos.`, evidencia: 'Facturación y cobranza' },
    ],
    mejoras: [
      { titulo: 'Centralizar ventas e inventario', que_hacer: 'Concentrar ventas, inventario y facturación en un solo sistema (Odoo) con tus datos actuales migrados.', beneficio: 'Un solo dato confiable para decidir.', impacto: 'alto', esfuerzo: 'medio', servicio: 'Odoo Systems' },
      { titulo: 'Automatizar la tarea más pesada', que_hacer: 'Revisar paso a paso la tarea que más tiempo te quita y automatizar las partes repetitivas (avisos, capturas, reportes).', beneficio: 'Horas libres cada semana para tu equipo.', impacto: 'medio', esfuerzo: 'bajo', servicio: 'Automatización e IA' },
      { titulo: 'Tablero con tus indicadores clave', que_hacer: 'Un tablero que muestre ventas, cobranza e inventario actualizados sin armar reportes a mano.', beneficio: 'Ver cómo va el negocio en minutos.', impacto: 'medio', esfuerzo: 'medio', servicio: 'Intelligence (tableros)' },
    ],
    primer_paso: 'Haz una lista de los reportes que armas cada semana y cuánto tiempo te toma cada uno; es el punto de partida para la llamada.',
    preguntas_para_llamada: ['¿Qué reporte te gustaría tener cada lunes sin armarlo a mano?', '¿Cuántas personas capturan ventas o inventario hoy?'],
    respaldo: true,
  };
}

async function pedirReporte(d, ctx) {
  const key = ctx.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'Falta ANTHROPIC_API_KEY en .env' };
  const user = JSON.stringify({ respuestas: d.respuestas, resumen_excel: d.resumen_excel || undefined });
  let ultimo = '';
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const res = await ctx.http({
        method: 'POST', url: 'https://api.anthropic.com/v1/messages', json: true, timeout: 90000,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: {
          model: ctx.env.DIAG_MODEL || DIAG.modelo, max_tokens: 2000, system: PROMPT_DIAGNOSTICO,
          messages: [{ role: 'user', content: user }],
        },
      });
      const texto = (res && Array.isArray(res.content) ? res.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const rep = extraerJSON(texto);
      if (reporteValido(rep)) return { reporte: rep, intentos: intento };
      ultimo = 'JSON inválido (intento ' + intento + ', stop_reason ' + (res && res.stop_reason) + ')';
    } catch (e) {
      ultimo = 'API (intento ' + intento + '): ' + String(e && (e.response && e.response.status) || '') + ' ' + String(e && e.message || e).slice(0, 200);
    }
  }
  return { error: ultimo };
}

async function turnstileValido(token, ip, ctx) {
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

async function crearLeadOdoo(d, folio, rep, ctx) {
  const e = ctx.env;
  if (!e.ODOO_URL || !e.ODOO_DB || !e.ODOO_USER || !e.ODOO_API_KEY) return 'omitido';
  const rpc = async (service, method, args) => {
    const r = await ctx.http({ method: 'POST', url: e.ODOO_URL.replace(/\/$/, '') + '/jsonrpc', json: true, timeout: 20000,
      body: { jsonrpc: '2.0', method: 'call', params: { service, method, args } } });
    if (r && r.error) throw new Error(r.error.data && r.error.data.message || r.error.message);
    return r.result;
  };
  const uid = await rpc('common', 'login', [e.ODOO_DB, e.ODOO_USER, e.ODOO_API_KEY]);
  if (!uid) throw new Error('login Odoo');
  const c = d.contacto;
  await rpc('object', 'execute_kw', [e.ODOO_DB, uid, e.ODOO_API_KEY, 'crm.lead', 'create', [{
    name: `${folio} · Diagnóstico · ${c.empresa}`, contact_name: c.nombre, partner_name: c.empresa, email_from: c.correo, phone: '+52' + c.whatsapp,
    description: `Giro: ${d.respuestas.giro}\nResumen: ${rep.resumen}\nPrimer paso: ${rep.primer_paso}`,
  }]]);
  return 'creado';
}

function textoCorreo(d, folio, rep, extra) {
  const c = d.contacto, r = d.respuestas;
  const l = [];
  l.push(`Folio: ${folio}`, `Empresa: ${c.empresa}`, `Nombre: ${c.nombre}`, `Correo: ${c.correo}`, `WhatsApp: https://wa.me/52${c.whatsapp}`, '');
  l.push('— Respuestas —', `Giro: ${r.giro}`, `Sucursales: ${r.sucursales} · Empleados: ${r.empleados}`, `Venden: ${r.canales.join(', ')}`,
    `Registro: ${r.registro}`, `Facturación: ${r.facturacion}`, `Cobranza: ${r.cobranza}`, `Tarea que más tiempo quita: ${r.tarea || '—'}`, `Quiere saber: ${r.saber || '—'}`,
    `Excel: ${d.resumen_excel ? 'sí (resumen agregado)' : 'no'}`, '');
  l.push('— Reporte' + (rep.respaldo ? ' (RESPALDO GENÉRICO: la API falló)' : '') + ' —', rep.resumen, `Madurez: ${rep.madurez.nivel} · ${rep.madurez.etiqueta}`, '');
  rep.hallazgos.forEach((h, i) => l.push(`Hallazgo ${i + 1}: ${h.titulo} — ${h.detalle}`));
  rep.mejoras.forEach((m, i) => l.push(`Mejora ${i + 1}: ${m.titulo} [${m.servicio} · impacto ${m.impacto} · esfuerzo ${m.esfuerzo}] — ${m.que_hacer}`));
  l.push('', `Primer paso: ${rep.primer_paso}`, 'Preguntas para la llamada:', ...rep.preguntas_para_llamada.map((q) => '• ' + q));
  if (extra) l.push('', extra);
  return l.join('\n');
}

function anotarError(state, now, where, detail) {
  state.errors = [{ at: now.toISOString(), where, detail: String(detail).slice(0, 300) }, ...(state.errors || [])].slice(0, 30);
}

/**
 * req: { method, origin, ip, body, bytes }
 * Respuestas: 200 reporte · 400 datos inválidos · 403 origen/Turnstile · 429 límites.
 */
async function handleDiagnostico(req, ctx) {
  const st = ctx.state, now = ctx.now;
  st.diag = st.diag || { correos: {}, ips: {}, meses: {}, folios: {}, avisoTope: '' };
  const D = st.diag;
  if (!DIAG.origins.includes(req.origin)) return R(403, { ok: false, error: 'origen' });
  if (!(req.bytes > 0) || req.bytes > DIAG.maxBytes) return R(400, { ok: false, error: 'tamano' });
  const b = req.body;
  if (!b || typeof b !== 'object') return R(400, { ok: false, error: 'cuerpo' });
  if (!(await turnstileValido(b.turnstile, req.ip, ctx))) {
    if (!ctx.env.TURNSTILE_SECRET) anotarError(st, now, 'turnstile', 'Falta TURNSTILE_SECRET en .env: todo se rechaza');
    return R(403, { ok: false, error: 'verificacion' });
  }
  const v = validarDiag(b);
  if (!v.ok) return R(400, { ok: false, error: v.error });
  const d = v.data;

  // ---- límites ----
  const t = now.getTime(), dia = 86400000;
  const ym = localParts(now).ym || now.toISOString().slice(0, 7);
  const limiteMes = Number(ctx.env.DIAG_MONTHLY_LIMIT) || DIAG.limiteMes;
  for (const k of Object.keys(D.correos)) { D.correos[k] = D.correos[k].filter((x) => t - x < DIAG.diasCorreo * dia); if (!D.correos[k].length) delete D.correos[k]; }
  for (const k of Object.keys(D.ips)) { D.ips[k] = D.ips[k].filter((x) => t - x < dia); if (!D.ips[k].length) delete D.ips[k]; }
  const amable = (motivo) => R(429, { ok: false, error: motivo, mensaje: d.idioma === 'en'
    ? 'We have received many requests. We will contact you to review your case personally.'
    : 'Hoy recibimos muchas solicitudes. Te contactamos para revisar tu caso de manera personal.' });
  if ((D.meses[ym] || 0) >= limiteMes) {
    const notify = [];
    if (D.avisoTope !== ym) {
      D.avisoTope = ym;
      notify.push({ subject: `Diagnóstico NodOpera: se llegó al tope mensual (${limiteMes})`, text: `El diagnóstico llegó a ${limiteMes} reportes en ${ym}. Los siguientes reciben "te contactamos".\nÚltimo que lo intentó: ${d.contacto.empresa} · ${d.contacto.correo} · https://wa.me/52${d.contacto.whatsapp}\nSube DIAG_MONTHLY_LIMIT en .env si quieres más.` });
    }
    return { ...amable('tope'), notify };
  }
  if ((D.correos[d.contacto.correo] || []).length >= DIAG.porCorreo) return amable('correo');
  if (req.ip && (D.ips[req.ip] || []).length >= DIAG.porIp) return amable('ip');
  (D.correos[d.contacto.correo] = D.correos[d.contacto.correo] || []).push(t);
  if (req.ip) (D.ips[req.ip] = D.ips[req.ip] || []).push(t);
  D.meses[ym] = (D.meses[ym] || 0) + 1;

  // ---- folio ----
  const anio = ym.slice(0, 4);
  D.folios[anio] = (D.folios[anio] || 0) + 1;
  const folioDX = `DX-${anio}-${String(D.folios[anio]).padStart(4, '0')}`;

  // ---- reporte ----
  const p = await pedirReporte(d, ctx);
  let rep = p.reporte;
  if (!rep) { anotarError(st, now, 'claude', p.error); rep = reporteRespaldo(d); }

  st.historial = [{ folio: folioDX, fecha: now.toISOString(), empresa: d.contacto.empresa, correo: d.contacto.correo, giro: d.respuestas.giro, respaldo: !!rep.respaldo },
    ...(st.historial || [])].slice(0, DIAG.historial);

  let odoo = 'omitido';
  try { odoo = await crearLeadOdoo(d, folioDX, rep, ctx); } catch (e) { odoo = 'error'; anotarError(st, now, 'odoo', e && e.message || e); }

  const notify = [{ subject: `Nuevo diagnóstico ${folioDX} – ${d.contacto.empresa}`, text: textoCorreo(d, folioDX, rep, `Odoo: ${odoo}`) }];
  return R(200, { ok: true, folio: folioDX, reporte: rep }, notify);
}
