// Dudas NodOpera · contesta preguntas de nodopera.com/dudas/ con reglas (sin IA, sin costo) y avisa a Ulises.
// Función pura: handleDuda(req, ctx) → { status, body, notify[] }. Turnstile solo se llama por ctx.http.
const DUDAS = {
  origins: ['https://nodopera.com', 'https://www.nodopera.com'],
  maxBytes: 4 * 1024,
  porIpHora: 8,
  porDia: 150,
  historial: 300,
};
const WA_LINK = 'https://wa.me/523322488131?text=';

// Base de respuestas: solo lo que el sitio ya publica (chat.js y /dudas/). k = palabras clave sin acentos.
const BASE = [
  { id: 'servicios', k: ['que hacen', 'a que se dedican', 'servicio', 'servicios', 'que ofrecen', 'ofrecen', 'ayudan'],
    r: 'Somos el área de TI de tu pyme sin que tengas que contratarla: soporte e infraestructura de TI con iguala mensual, cámaras y control de acceso, ERP y CRM a tu medida con automatización, y análisis de tus números con tableros.', l: 'https://nodopera.com/#servicios' },
  { id: 'precios', k: ['precio', 'precios', 'cuanto cuesta', 'cuanto cobran', 'costo', 'cotiza', 'cotizacion', 'tarifa', 'mensualidad', 'plan', 'planes', 'iguala', 'esencial', 'pro', 'total'],
    r: 'Hay tres planes con cuota mensual fija y horas del equipo incluidas: Esencial (hasta 5 equipos), Pro (hasta 15) y Total (hasta 30). Los precios vigentes están en la sección Planes, y los proyectos se cotizan aparte con precio cerrado.', l: 'https://nodopera.com/#planes' },
  { id: 'cobertura', k: ['donde', 'ciudad', 'estado', 'cdmx', 'guadalajara', 'monterrey', 'queretaro', 'puebla', 'en sitio', 'presencial', 'remoto', 'a domicilio', 'atienden en', 'foraneo', 'ubicacion'],
    r: 'Trabajamos con empresas en todo México de forma remota. Hay atención presencial en la CDMX y en la Zona Metropolitana de Guadalajara; en otras ciudades, si hace falta ir, la visita se agenda.' },
  { id: 'como', k: ['como trabajan', 'como funciona', 'proceso', 'pasos', 'empezar', 'contratar', 'primer paso', 'como le hago'],
    r: 'Trabajamos en cuatro pasos: diagnóstico, propuesta con alcance y precio claros, puesta en orden de lo crítico y operación con soporte continuo y reporte mensual.' },
  { id: 'diagnostico', k: ['diagnostico', 'evaluacion', 'auditoria', 'revision', 'gratis', '10 preguntas'],
    r: 'El diagnóstico gratis en línea son 10 preguntas en unos 5 minutos: recibes en pantalla tus 3 cuellos de botella, 3 mejoras y, si eliges tu archivo de ventas, un tablero con tus números. Tu archivo no se sube: se lee en tu navegador.', l: 'https://nodopera.com/diagnostico/' },
  { id: 'tiempos', k: ['cuanto tardan', 'tiempo de respuesta', 'que tan rapido', 'urgencia', 'urgente', 'emergencia', 'horario', 'sla', 'tardan'],
    r: 'Los mensajes del sitio, WhatsApp o correo se contestan en menos de un día hábil. En los planes Pro y Total, las fallas críticas tienen respuesta remota en 30 minutos de lunes a sábado de 7:00 a 21:00; los tiempos de visita quedan por escrito en el contrato.' },
  { id: 'migracion', k: ['migrar', 'migracion', 'pasar mis datos', 'desde excel', 'sistema anterior', 'importar', 'aspel', 'contpaq', 'cambiar de sistema'],
    r: 'Sí hacemos migraciones desde Excel o tu sistema anterior: limpiamos y validamos la información, respaldamos todo antes de empezar y tu sistema anterior sigue disponible hasta que los datos cuadren.' },
  { id: 'erp', k: ['erp', 'crm', 'inventario', 'punto de venta', 'facturacion', 'facturar', 'sistema administrativo', 'compras', 'software'],
    r: 'Montamos tu ERP y CRM a tu medida y con tus datos: ventas, inventario, compras, facturación electrónica, punto de venta y seguimiento de clientes en un solo sistema. Una pyme suele arrancar en 4 a 12 semanas.' },
  { id: 'camaras', k: ['camara', 'camaras', 'cctv', 'videovigilancia', 'control de acceso', 'acceso', 'checador', 'cableado'],
    r: 'Instalamos y damos mantenimiento a cámaras, control de acceso y cableado, y revisamos periódicamente que graben. La instalación se cotiza como proyecto con precio cerrado.', l: 'https://nodopera.com/servicios/cctv-control-acceso.html' },
  { id: 'soporte', k: ['soporte', 'tecnico', 'computadora', 'compu', 'laptop', 'impresora', 'red', 'wifi', 'internet', 'servidor', 'virus', 'respaldo', 'respaldos', 'mantenimiento'],
    r: 'Con la iguala de soporte tienes quien atienda tus equipos, red, servidores y respaldos, remoto o en sitio, con mantenimiento preventivo, monitoreo y un reporte cada mes.', l: 'https://nodopera.com/servicios/soporte-ti.html' },
  { id: 'automatizacion', k: ['automatizar', 'automatizacion', 'bot', 'bots', 'whatsapp', 'n8n', 'integrar', 'integracion', 'ia', 'inteligencia artificial'],
    r: 'Automatizamos tareas repetitivas e integramos tus sistemas (por ejemplo, recordatorios de cobranza o capturas que hoy se hacen a mano), y hacemos bots de WhatsApp y asistentes con IA que conocen tu negocio.' },
  { id: 'web', k: ['pagina web', 'paginas web', 'sitio web', 'tienda en linea', 'landing', 'dominio'],
    r: 'Sí hacemos páginas web como proyecto con precio cerrado; el alcance y los tiempos quedan por escrito antes de empezar.' },
  { id: 'datos', k: ['tablero', 'dashboard', 'reporte', 'reportes', 'finanzas', 'margen', 'cuanto gano', 'indicadores', 'numeros'],
    r: 'Ordenamos tus números para que veas cuánto ganas de verdad, con un tablero que se actualiza y un reporte mensual para decidir con datos.', l: 'https://nodopera.com/servicios/analisis-de-datos-y-finanzas.html' },
  { id: 'tengo_tecnico', k: ['ya tengo tecnico', 'tengo un tecnico', 'mi tecnico', 'tengo sistemas', 'area de ti'],
    r: 'Podemos trabajar con tu técnico: nos encargamos de la documentación, los respaldos y los proveedores, y tu técnico atiende el día a día.' },
];

const R = (status, body, notify = []) => ({ status, body, notify });
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ@. ]+/g, ' ').replace(/\s+/g, ' ').trim();
function str(v, max, min = 0) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s.length >= min && s.length <= max ? s : null;
}

/** Mejor respuesta por palabras clave (frases largas pesan más). null si nada coincide. */
function buscar(pregunta) {
  const q = ' ' + norm(pregunta) + ' ';
  let mejor = null, pts = 0;
  for (const x of BASE) {
    let p = 0;
    for (const k of x.k) if (q.includes(' ' + k + ' ') || (k.includes(' ') && q.includes(k))) p += k.split(' ').length * 2 + (k.length > 6 ? 1 : 0);
    if (p > pts) { pts = p; mejor = x; }
  }
  return pts >= 2 ? mejor : null;
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

async function handleDuda(req, ctx) {
  if (req.method !== 'POST') return R(405, { ok: false, error: 'metodo' });
  if (!DUDAS.origins.includes(req.origin)) return R(403, { ok: false, error: 'origen' });
  if (req.bytes > DUDAS.maxBytes) return R(413, { ok: false, error: 'tamano' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const pregunta = str(b.pregunta, 300, 3);
  const nombre = b.nombre ? str(b.nombre, 80) : '';
  const contacto = b.contacto ? str(b.contacto, 120) : '';
  if (!pregunta || nombre === null || contacto === null) return R(400, { ok: false, error: 'datos' });
  const tel = contacto.replace(/\D/g, '').replace(/^52(?=\d{10}$)/, '');
  const esCorreo = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(contacto);
  if (contacto && !esCorreo && tel.length !== 10) return R(400, { ok: false, error: 'contacto', mensaje: 'Escribe un correo o un WhatsApp de 10 dígitos (o déjalo vacío).' });

  // Límites antes de llamar a Turnstile (no gastar en abuso)
  const st = ctx.state, t = ctx.now.getTime(), dia = ctx.now.toISOString().slice(0, 10);
  st.ips = st.ips || {};
  for (const k of Object.keys(st.ips)) { st.ips[k] = st.ips[k].filter((x) => t - x < 3600e3); if (!st.ips[k].length) delete st.ips[k]; }
  if (st.dia !== dia) { st.dia = dia; st.hoy = 0; }
  if ((req.ip && (st.ips[req.ip] || []).length >= DUDAS.porIpHora) || st.hoy >= DUDAS.porDia)
    return R(429, { ok: false, error: 'limite', mensaje: 'Recibimos muchas preguntas seguidas. Escríbenos por WhatsApp y te contestamos.' });
  if (!(await turnstileValido(b.turnstile, req.ip, ctx))) return R(403, { ok: false, error: 'turnstile' });
  if (req.ip) (st.ips[req.ip] = st.ips[req.ip] || []).push(t);
  st.hoy++;

  const x = buscar(pregunta);
  const contactoTxt = esCorreo ? contacto : (tel ? tel.replace(/(\d{2})(\d{4})(\d{4})/, '$1 $2 $3') : '');
  const escalado = !x || !!contacto;
  let respuesta = x ? x.r : 'Buena pregunta. No la tengo en mis respuestas automáticas, así que se la pasé a una persona del equipo.';
  if (escalado && contactoTxt) respuesta += ` Te escribimos a ${contactoTxt} en menos de un día hábil.`;
  else if (!x) respuesta += ' Si nos dejas tu correo o WhatsApp te contestamos en menos de un día hábil, o escríbenos directo por WhatsApp.';
  const folio = 'DU-' + dia.replace(/-/g, '').slice(2) + '-' + String(st.hoy).padStart(3, '0');
  st.historial = [{ folio, fecha: ctx.now.toISOString(), pregunta, tema: x ? x.id : null, contacto: !!contacto }, ...(st.historial || [])].slice(0, DUDAS.historial);

  const notify = escalado ? [{
    subject: `Duda ${folio}${x ? '' : ' SIN RESPUESTA'} – ${pregunta.slice(0, 60)}`,
    text: `Pregunta desde ${req.pagina || 'nodopera.com/dudas/'}:\n\n${pregunta}\n\n` +
      `Nombre: ${nombre || '(no lo dejó)'}\nContacto: ${contactoTxt || '(no lo dejó)'}` +
      (tel && !esCorreo ? `\nWhatsApp: https://wa.me/52${tel}` : '') +
      `\n\nRespuesta automática: ${x ? `[${x.id}] ${x.r}` : '(ninguna: hay que contestar a mano)'}\n\nFolio ${folio}`,
  }] : [];
  return R(200, { ok: true, folio, respuesta, enlace: x && x.l || '', escalado,
    whatsapp: WA_LINK + encodeURIComponent('Hola NodOpera, tengo una duda (' + folio + '): ' + pregunta) }, notify);
}

// ---- Adaptador n8n ----
const _E = $env;
const _helpers = this.helpers;
const ctx = {
  env: { TURNSTILE_SECRET: _E.TURNSTILE_SECRET },
  state: $getWorkflowStaticData('global'),
  now: new Date(),
  http: (o) => _helpers.httpRequest(o),
};
const _it = $input.first().json;
const _h = _it.headers || {};
const _origin = String(_h.origin || '');
let _out;
try {
  _out = await handleDuda({ method: 'POST', origin: _origin, ip: String(_h['cf-connecting-ip'] || ''), pagina: String(_h.referer || '').slice(0, 120),
    body: _it.body, bytes: Buffer.byteLength(JSON.stringify(_it.body || '')) }, ctx);
} catch (e) {
  ctx.state.errors = [{ at: ctx.now.toISOString(), detail: String(e && e.message || e).slice(0, 300) }, ...(ctx.state.errors || [])].slice(0, 30);
  _out = { status: 500, body: { ok: false, error: 'interno' }, notify: [] };
}
return [{ json: { status: _out.status, body: _out.body,
  notify: (_out.notify || []).map((n) => ({ ...n, to: _E.NOTIFY_TO, from: _E.NOTIFY_FROM })) } }];
