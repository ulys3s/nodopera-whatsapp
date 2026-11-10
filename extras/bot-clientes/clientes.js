// ============================================================================
// Bot de ATENCIÓN A CLIENTES de NodOpera
// - Menú: soporte (crea ticket en portal.nodopera.com), cotizar, estado de
//   tickets, hablar con Ulises (pase a humano), horario.
// - Pase a humano: los mensajes del cliente se reenvían al WhatsApp personal
//   de Ulises (ADMIN_WA). Ulises contesta deslizando "Responder" sobre el
//   mensaje reenviado y el bot se lo entrega al cliente.
// ============================================================================

const CLI = {
  ttlMin: 60,
  humanoHoras: 12,
  maxPorDia: 80,
  portal: 'https://portal.nodopera.com/my/tickets',
  horario: 'Lunes a viernes 9:00–18:00 · Sábado 9:00–14:00',
  areas: [
    ['infra', 'Redes y servidores', 'Cableado, Wi-Fi, servidores, nube, PCs'],
    ['cctv', 'Cámaras y accesos', 'CCTV, control de acceso, alarmas'],
    ['odoo', 'Odoo y procesos', 'Implementación, migración, capacitación'],
    ['bi', 'Reportes y dashboards', 'Power BI, Looker Studio, indicadores'],
    ['ia', 'Bots e IA', 'WhatsApp, automatización, n8n, IA'],
    ['iguala', 'Soporte mensual', 'Iguala de TI con visitas y mesa de ayuda'],
    ['otro', 'Otro', 'Cuéntanos qué necesitas'],
  ],
};
const ESTADOS = { new: 'Recibido', assigned: 'Asignado', in_progress: 'En atención', waiting: 'Esperando tu respuesta', done: 'Resuelto', cancel: 'Cancelado' };
const PRIORIDAD = { p0: ['0', 'Normal'], p1: ['1', 'Alta'], p2: ['2', 'Urgente'] };

function enHorario(now) {
  const p = localParts(now);
  if (p.wd >= 1 && p.wd <= 5) return p.hh >= 9 && p.hh < 18;
  if (p.wd === 6) return p.hh >= 9 && p.hh < 14;
  return false;
}

function cliMenu(name, now) {
  const saludo = name ? `¡Hola, ${name.split(' ')[0]}! 👋` : '¡Hola! 👋';
  const fuera = enHorario(now) ? '' : '\n\n🌙 Estamos fuera de horario, pero puedes levantar tu ticket ahora y lo atendemos a primera hora.';
  return list(
    `${saludo} Bienvenido a *NodOpera*, soporte y tecnología para tu negocio.${fuera}\n\n¿En qué te ayudamos?`,
    'Ver opciones',
    [
      ['sop', '🛠️ Reportar una falla', 'Levanta un ticket de soporte'],
      ['tk', '🔎 Estado de mis tickets', 'Consulta tus tickets abiertos'],
      ['cot', '💼 Cotizar un servicio', 'Infraestructura, Odoo, BI, IA'],
      ['hum', '👤 Hablar con Ulises', 'Te atiende una persona'],
      ['info', '🕘 Horario y contacto', 'Horario, correo y página web'],
    ],
    'NodOpera',
    'Escribe "menú" en cualquier momento',
  );
}

function volver(texto) {
  return buttons(texto, [['menu', '🏠 Menú'], ['hum', '👤 Hablar con Ulises']]);
}

// ----------------------------- Odoo (JSON-RPC) -----------------------------
function makeOdoo(env, ctx) {
  const url = `${String(env.ODOO_URL || '').replace(/\/$/, '')}/jsonrpc`;
  async function rpc(service, method, args) {
    const res = await ctx.http({ method: 'POST', url, json: true,
      body: { jsonrpc: '2.0', method: 'call', params: { service, method, args } } });
    if (res?.error) throw new Error(res.error.data?.message || res.error.message || 'Error de Odoo');
    return res.result;
  }
  async function uid() {
    const st = ctx.state;
    if (st.odooUid && st.odooUidFor === env.ODOO_USER) return st.odooUid;
    const id = await rpc('common', 'authenticate', [env.ODOO_DB, env.ODOO_USER, env.ODOO_API_KEY, {}]);
    if (!id) throw new Error('Odoo: usuario o API key inválidos');
    st.odooUid = id; st.odooUidFor = env.ODOO_USER;
    return id;
  }
  async function call(model, method, args, kwargs = {}) {
    return rpc('object', 'execute_kw', [env.ODOO_DB, await uid(), env.ODOO_API_KEY, model, method, args, kwargs]);
  }
  return {
    enabled: Boolean(env.ODOO_URL && env.ODOO_DB && env.ODOO_USER && env.ODOO_API_KEY),
    /** Busca el contacto por los últimos 10 dígitos, sin importar espacios o guiones. */
    async findPartner(wa) {
      const pat = '%' + last10(wa).split('').join('%') + '%';
      const r = await call('res.partner', 'search_read', [[['phone', '=ilike', pat]]],
        { fields: ['id', 'name', 'commercial_partner_id'], limit: 1, order: 'id desc' });
      if (!r.length) return null;
      return { id: r[0].id, name: r[0].name, companyId: r[0].commercial_partner_id?.[0] || r[0].id };
    },
    async createPartner(name, wa, contacto) {
      const id = await call('res.partner', 'create', [{
        name, phone: `+52 ${prettyPhone(wa)}`,
        comment: `Creado por el bot de WhatsApp. Contacto: ${contacto || '(sin nombre)'}`,
      }]);
      return { id, name, companyId: id };
    },
    async createTicket({ partner, asunto, descripcion, prioridad }) {
      const vals = {
        name: cut(asunto, 80),
        description: descripcion,
        partner_id: partner.companyId,
        priority: prioridad,
        channel: 'whatsapp',
      };
      if (partner.id !== partner.companyId) vals.contact_id = partner.id;
      const id = await call('nodopera.ticket', 'create', [vals]);
      const [t] = await call('nodopera.ticket', 'read', [[id], ['number']]);
      return { id, number: t?.number || `#${id}` };
    },
    async openTickets(partner) {
      return call('nodopera.ticket', 'search_read',
        [[['partner_id', 'child_of', partner.companyId], ['state', 'not in', ['done', 'cancel']]]],
        { fields: ['number', 'name', 'state', 'priority'], limit: 5, order: 'create_date desc' });
    },
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --------------------------- Pase a humano (relay) ---------------------------
async function forwardToAdmin(ctx, wa, env, m, header) {
  if (!env.ADMIN_WA) return false;
  const body = `${header || '💬'} *${m.name || 'Cliente'}* (${prettyPhone(m.from)})\n${m.text || `[${m.type}]`}\n\n↩️ _Desliza "Responder" sobre este mensaje para contestarle. Escribe /fin respondiendo aquí para regresarlo al bot._`;
  const id = await wa.send(env.ADMIN_WA, txt(body));
  if (id) {
    ctx.state.fwd = ctx.state.fwd || {};
    ctx.state.fwd[id] = m.from;
    const keys = Object.keys(ctx.state.fwd);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete ctx.state.fwd[k];
  }
  return Boolean(id);
}

async function adminCommand(m, ctx, wa, env) {
  const st = ctx.state;
  st.human = st.human || {};
  const t = m.text || '';
  let target = m.contextId ? st.fwd?.[m.contextId] : null;
  const explicit = t.match(/^\/(r|fin)\s+(\+?[\d\s-]{10,16})\s*(.*)$/s);
  if (explicit) target = Object.keys(st.human).find((k) => last10(k) === last10(explicit[2])) || `521${last10(explicit[2])}`;
  const cmd = norm(t.split(/\s/)[0]);

  if (cmd === '/estado') {
    const abiertos = Object.entries(st.human).filter(([, until]) => until > +ctx.now).map(([k]) => `• ${prettyPhone(k)}`);
    await wa.send(env.ADMIN_WA, txt(`📊 Mensajes enviados este mes: ${wa.usedThisMonth()} de 1,000 gratis.\nConversaciones con humano abiertas:\n${abiertos.join('\n') || '• ninguna'}\nÚltimo error: ${st.errors?.[0]?.detail || 'ninguno'}`));
    return;
  }
  if (!target) {
    await wa.send(env.ADMIN_WA, txt('🤖 Modo administrador.\n• Responde (deslizar) a un mensaje reenviado para contestarle al cliente.\n• /fin (respondiendo) para regresarlo al bot.\n• /r 33XXXXXXXX texto para escribirle directo.\n• /estado para ver uso del mes.'));
    return;
  }
  if (cmd === '/fin') {
    delete st.human[target];
    await wa.send(target, buttons('Gracias por escribirnos 🙌 Te regreso con el asistente de NodOpera. Si necesitas algo más, aquí estamos.', [['menu', '🏠 Menú']]));
    return;
  }
  const texto = explicit ? explicit[3] : t;
  if (!texto.trim()) return;
  st.human[target] = +ctx.now + CLI.humanoHoras * 3600e3; // mantener abierta la atención humana
  const ok = await wa.send(target, txt(texto));
  if (!ok) await wa.send(env.ADMIN_WA, txt(`⚠️ No se pudo entregar al cliente ${prettyPhone(target)}. Si pasaron más de 24 h desde su último mensaje, WhatsApp no deja escribirle sin plantilla. Error: ${st.errors?.[0]?.detail || '?'}`));
}

// ------------------------------- Conversación -------------------------------
async function clienteStep(m, s, ctx, wa, odoo, env) {
  const say = [];
  const notify = [];
  const st = ctx.state;
  st.human = st.human || {};
  const t = norm(m.text);
  let c = m.choice;
  if (!c && ['hola', 'menu', 'inicio', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'bot'].includes(t)) c = 'menu';
  if (!c && ['cancelar', 'salir'].includes(t)) c = 'menu';

  // Conversación en manos de Ulises: solo reenviar
  if (st.human[m.from] > +ctx.now && c !== 'menu') {
    const ok = await forwardToAdmin(ctx, wa, env, m);
    if (!ok && !s.avisoMail) {
      s.avisoMail = true;
      notify.push({ subject: `💬 Cliente esperando respuesta: ${m.name || prettyPhone(m.from)}`,
        text: `No pude reenviarte el mensaje por WhatsApp (abre la ventana escribiéndole cualquier cosa al número del bot).\n\nCliente: ${m.name}\nWhatsApp: https://wa.me/${m.from}\nMensaje: ${m.text}` });
    }
    return { say, notify };
  }
  if (c === 'menu' && st.human[m.from]) delete st.human[m.from];

  if (c === 'menu' || (s.isNew && !c)) { s.step = 'start'; say.push(cliMenu(m.name, ctx.now)); return { say, notify }; }

  switch (c || '') {
    case 'sop':
      s.step = 'sop_desc'; s.sop = {};
      say.push(txt('🛠️ Cuéntanos qué está fallando en *un mensaje*: qué equipo o sistema, en qué sucursal y desde cuándo.\n\nPuedes mandar una foto con descripción.'));
      return { say, notify };
    case 'cot':
      s.step = 'cot_area';
      say.push(list('💼 ¿Qué te gustaría cotizar?', 'Ver servicios', CLI.areas.map(([id, n, d]) => [`area_${id}`, n, d]), 'Servicios'));
      return { say, notify };
    case 'tk':
      return { say: [await estadoTickets(m, odoo, ctx)], notify };
    case 'info':
      s.step = 'start';
      say.push(volver(`🕘 *Horario:* ${CLI.horario}\n📍 Guadalajara y Zapopan, atención en sitio y remota\n✉️ ulises@nodopera.com\n🌐 nodopera.com\n\nLos tickets urgentes de clientes con póliza se atienden también fuera de horario.`));
      return { say, notify };
    case 'hum': {
      s.step = 'start';
      st.human[m.from] = +ctx.now + CLI.humanoHoras * 3600e3;
      const ok = await forwardToAdmin(ctx, wa, env, { ...m, text: 'Pidió hablar con una persona.' }, '🙋');
      notify.push({ subject: `🙋 ${m.name || prettyPhone(m.from)} quiere hablar contigo`,
        text: `Un cliente pidió atención humana en el WhatsApp de NodOpera.\n\nCliente: ${m.name}\nWhatsApp: https://wa.me/${m.from}\nReenvío por WhatsApp: ${ok ? 'sí' : 'NO (escríbele al bot para abrir la ventana de 24 h)'}` });
      say.push(txt(enHorario(ctx.now)
        ? '👤 Listo, ya le avisé a Ulises. Te contesta por aquí en unos minutos. Puedes ir escribiendo tu duda.'
        : '👤 Ya le avisé a Ulises. Estamos fuera de horario, así que te responde a primera hora. Si es una falla, también puedes escribir *menú* y levantar un ticket.'));
      return { say, notify };
    }
  }

  switch (s.step) {
    case 'sop_desc': {
      const desc = m.text || (m.mediaId ? '[foto sin descripción]' : '');
      if (desc.length < 6) { say.push(txt('Dame un poco más de detalle, por favor: ¿qué equipo o sistema falla y qué pasa?')); break; }
      s.sop.desc = desc;
      if (m.mediaId) s.sop.media = m.mediaId;
      s.step = 'sop_pri';
      say.push(buttons('¿Qué tan urgente es?\n\n*Normal:* puede esperar a la visita o atención remota.\n*Alta:* afecta a varias personas.\n*Urgente:* el negocio está detenido.',
        [['p0', 'Normal'], ['p1', 'Alta'], ['p2', '🚨 Urgente']]));
      break;
    }
    case 'sop_pri': {
      if (!PRIORIDAD[c]) { say.push(buttons('Elige la urgencia con un botón:', [['p0', 'Normal'], ['p1', 'Alta'], ['p2', '🚨 Urgente']])); break; }
      s.sop.pri = c;
      let partner = null;
      if (odoo.enabled) {
        try { partner = await odoo.findPartner(m.from); } catch (e) { wa.logError('odoo:findPartner', e); }
      }
      if (partner || !odoo.enabled) { s.step = 'start'; return crearTicket(m, s, ctx, wa, odoo, partner); }
      s.step = 'sop_emp';
      say.push(txt('Es la primera vez que nos escribes desde este número 🙂 ¿De qué *empresa o negocio* nos escribes? (Si es personal, escribe tu nombre completo.)'));
      break;
    }
    case 'sop_emp': {
      if (t.length < 2) { say.push(txt('¿Nombre de la empresa o negocio?')); break; }
      let partner = null;
      try { partner = await odoo.createPartner(cut(m.text, 80), m.from, m.name); } catch (e) { wa.logError('odoo:createPartner', e); }
      s.step = 'start';
      return crearTicket(m, s, ctx, wa, odoo, partner, m.text);
    }
    case 'cot_area': {
      const a = CLI.areas.find(([id]) => c === `area_${id}`);
      if (!a) { say.push(list('Elige una opción de la lista 👇', 'Ver servicios', CLI.areas.map(([id, n, d]) => [`area_${id}`, n, d]), 'Servicios')); break; }
      s.cot = { area: a[1] };
      s.step = 'cot_desc';
      say.push(txt(`*${a[1]}* 👍 Cuéntanos en un mensaje qué necesitas: tamaño del negocio, número de sucursales o equipos, y si tienes fecha en mente.`));
      break;
    }
    case 'cot_desc': {
      if (t.length < 8) { say.push(txt('Cuéntanos un poco más para cotizar bien 🙂')); break; }
      notify.push({ subject: `💼 Cotización por WhatsApp: ${s.cot.area} · ${m.name || prettyPhone(m.from)}`,
        text: `Solicitud de cotización desde el WhatsApp de NodOpera.\n\nServicio: ${s.cot.area}\nCliente: ${m.name}\nWhatsApp: https://wa.me/${m.from}\n\nDetalle:\n${m.text}` });
      await forwardToAdmin(ctx, wa, env, { ...m, text: `[Cotización · ${s.cot.area}] ${m.text}` }, '💼');
      s.step = 'start';
      say.push(volver('¡Gracias! 🙌 Recibimos tu solicitud. Te enviamos una propuesta en máximo 1 día hábil. Si quieres adelantar detalles, toca *Hablar con Ulises*.'));
      break;
    }
    default:
      say.push(cliMenu(m.name, ctx.now));
  }
  return { say, notify };
}

async function crearTicket(m, s, ctx, wa, odoo, partner, empresa) {
  const say = [];
  const notify = [];
  const [pri, priLabel] = PRIORIDAD[s.sop.pri] || PRIORIDAD.p0;
  const descripcion = `<p>${esc(s.sop.desc).replace(/\n/g, '<br/>')}</p><p><b>Reportado por WhatsApp</b>: ${esc(m.name || '')} · +${m.from}${s.sop.media ? '<br/>Incluye foto (ver WhatsApp).' : ''}</p>`;
  let ticket = null;
  if (partner) {
    try {
      ticket = await odoo.createTicket({ partner, asunto: s.sop.desc.split('\n')[0], descripcion, prioridad: pri });
    } catch (e) { wa.logError('odoo:createTicket', e); }
  }
  notify.push({
    subject: `🛠️ ${ticket ? ticket.number : 'Ticket SIN registrar'} · ${priLabel} · ${partner?.name || empresa || m.name || prettyPhone(m.from)}`,
    text: `${ticket ? `Ticket ${ticket.number} creado en el portal.` : '⚠️ No se pudo crear en Odoo: regístralo a mano.'}\n\nPrioridad: ${priLabel}\nCliente: ${partner?.name || empresa || '(desconocido)'}\nContacto: ${m.name}\nWhatsApp: https://wa.me/${m.from}\n\nProblema:\n${s.sop.desc}`,
  });
  await forwardToAdmin(ctx, wa, ctx.env, { ...m, text: `[${ticket?.number || 'Ticket'} · ${priLabel}] ${s.sop.desc}` }, '🛠️');
  if (ticket) {
    say.push(volver(`✅ Ticket *${ticket.number}* registrado con prioridad *${priLabel}*.\n\nYa avisamos al equipo; te contactamos por aquí. Seguimiento en ${CLI.portal}`));
  } else {
    say.push(volver(`✅ Recibimos tu reporte con prioridad *${priLabel}*. Ulises ya fue notificado y te confirma el folio en breve.`));
  }
  if (pri === '2' && !enHorario(ctx.now)) say.push(txt('🚨 Como es urgente y estamos fuera de horario, también puedes llamar al 33 2248 8131.'));
  s.sop = {};
  return { say, notify };
}

async function estadoTickets(m, odoo, ctx) {
  if (!odoo.enabled) return volver('Por ahora consulta tus tickets en ' + CLI.portal);
  try {
    const partner = await odoo.findPartner(m.from);
    if (!partner) return volver('No encontré tickets ligados a este número 🤔 Si ya eres cliente, pide a Ulises que registre este WhatsApp en tu cuenta.');
    const tks = await odoo.openTickets(partner);
    if (!tks.length) return volver(`No tienes tickets abiertos, *${partner.name}* 🎉`);
    const lines = tks.map((k) => `• *${k.number}* · ${cut(k.name, 40)}\n   ${ESTADOS[k.state] || k.state}`);
    return volver(`🔎 Tickets abiertos de *${partner.name}*:\n\n${lines.join('\n')}\n\nDetalle en ${CLI.portal}`);
  } catch (e) {
    return volver('No pude consultar el portal en este momento 😓 Intenta en unos minutos o escribe a Ulises.');
  }
}

async function handleWebhook(body, ctx) {
  const env = ctx.env;
  const wa = makeWA({ token: env.WA_TOKEN, phoneId: env.CLIENTES_PHONE_ID, version: env.WA_GRAPH_VERSION, monthlyLimit: 0 }, ctx);
  const odoo = makeOdoo(env, ctx);
  const st = ctx.state;
  const notify = [];

  for (const m of parseIncoming(body)) {
    if (m.phoneNumberId && env.CLIENTES_PHONE_ID && m.phoneNumberId !== String(env.CLIENTES_PHONE_ID)) continue;
    if (seenBefore(st, m.id)) continue;
    if (m.ts && ctx.now - m.ts > 30 * 60e3) continue;
    await wa.read(m.id);

    if (env.ADMIN_WA && last10(m.from) === last10(env.ADMIN_WA)) {
      // Ulises desde su celular: respuestas (deslizar) y comandos "/" son de administrador; texto normal = prueba el bot como cliente
      if (m.contextId || (m.text || '').startsWith('/')) { await adminCommand(m, ctx, wa, env); continue; }
    }
    if (rateLimited(st, m.from, ctx.now, CLI.maxPorDia)) continue;

    const s = getSession(st, m.from, ctx.now, CLI.ttlMin);
    let r;
    if (['sticker', 'reaction', 'unsupported'].includes(m.type)) continue;
    if (m.type === 'audio' && !(st.human?.[m.from] > +ctx.now)) {
      r = { say: [volver('Todavía no puedo escuchar audios 🙈 ¿Me lo escribes? O toca *Hablar con Ulises*.')], notify: [] };
    } else {
      r = await clienteStep(m, s, ctx, wa, odoo, env);
    }
    for (const p of r.say) await wa.send(m.from, p);
    notify.push(...r.notify);
  }
  return notify;
}
