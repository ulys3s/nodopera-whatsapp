// ============================================================================
// Bot DEMO de NodOpera: cualquiera escribe y prueba cómo un bot toma pedidos
// (Taquería El Nodo) o agenda citas (Barbería Nodo). Al final invita a
// cotizar uno propio y avisa a Ulises por correo (lead).
// ============================================================================

const DEMO = {
  negocioPedidos: 'Taquería El Nodo',
  negocioCitas: 'Barbería Nodo',
  envio: 30,
  menu: [
    // id, nombre, precio, descripción
    ['pastor', 'Tacos al pastor (5)', 95, 'Con piña, cebolla y cilantro'],
    ['asada', 'Tacos de asada (5)', 110, 'Arrachera, guacamole aparte'],
    ['gringa', 'Gringa de pastor', 85, 'Tortilla de harina con queso'],
    ['quesadilla', 'Quesadilla', 55, 'Queso Oaxaca, con o sin carne'],
    ['torta', 'Torta ahogada', 90, 'Clásica tapatía, picante a elegir'],
    ['horchata', 'Agua de horchata 1 L', 40, 'Natural, del día'],
    ['refresco', 'Refresco 600 ml', 30, 'Coca-Cola, Sprite o Fanta'],
  ],
  servicios: [
    ['corte', 'Corte de cabello', 180, 45],
    ['barba', 'Arreglo de barba', 120, 30],
    ['combo', 'Corte + barba', 270, 60],
    ['nino', 'Corte infantil', 140, 30],
  ],
  horas: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  ttlMin: 30,          // minutos sin actividad para reiniciar la conversación
  maxPorDia: 60,       // mensajes entrantes por persona al día
};

const MENU_KW = ['hola', 'menu', 'menú', 'inicio', 'empezar', 'reiniciar', 'buenas', 'buenos dias', 'buenas tardes', 'hi', 'start'];

function demoMenu(name) {
  const saludo = name ? `¡Hola, ${name.split(' ')[0]}! 👋` : '¡Hola! 👋';
  return buttons(
    `${saludo} Soy el *bot de demostración de NodOpera*.\n\n` +
    `Pruébame como si fueras cliente de un negocio real: puedo *tomar un pedido* en una taquería o *agendar una cita* en una barbería, las 24 horas.\n\n¿Qué quieres probar?`,
    [['pedido', '🛒 Hacer un pedido'], ['cita', '📅 Agendar una cita'], ['lead', '🚀 Quiero uno así']],
    'Demo · escribe "menú" para volver aquí',
  );
}

function demoListaMenu(cart) {
  const extra = cart.length ? `\n\nLlevas: ${cartLine(cart)}` : '';
  return list(
    `🌮 *${DEMO.negocioPedidos}*\nElige un producto del menú.${extra}`,
    'Ver menú',
    DEMO.menu.map(([id, n, p, d]) => [`it_${id}`, n, `${money(p)} · ${d}`]),
    'Menú',
  );
}

function cartLine(cart) {
  return cart.map((c) => `${c.q}× ${c.n}`).join(', ');
}
function cartTotal(cart) {
  return cart.reduce((a, c) => a + c.q * c.p, 0);
}

function demoResumen(s) {
  const lines = s.cart.map((c) => `• ${c.q}× ${c.n} — ${money(c.q * c.p)}`);
  const envio = s.entrega === 'dom' ? DEMO.envio : 0;
  if (envio) lines.push(`• Envío — ${money(envio)}`);
  const total = cartTotal(s.cart) + envio;
  const entrega = s.entrega === 'dom' ? `🛵 A domicilio: ${s.addr}` : '🏪 Pasas a recogerlo (listo en ~20 min)';
  return buttons(
    `🧾 *Tu pedido*\n${lines.join('\n')}\n\n*Total: ${money(total)}*\n${entrega}\n\n¿Lo confirmo?`,
    [['p_ok', '✅ Confirmar'], ['p_edit', '✏️ Empezar de nuevo'], ['cancel', '❌ Cancelar']],
  );
}

function proximosDias(now) {
  const out = [];
  const p0 = localParts(now);
  for (let i = 0; out.length < 6 && i < 10; i++) {
    const d = new Date(now.getTime() + i * 864e5);
    const p = localParts(d);
    if (p.wd === 0) continue; // domingo cerrado
    if (i === 0 && p0.hh >= 18) continue; // hoy ya no hay espacio
    const key = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const label = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : DIAS[p.wd][0].toUpperCase() + DIAS[p.wd].slice(1);
    out.push([`day_${key}`, `${label} ${p.d} ${MESES[p.m - 1]}`, `${DIAS[p.wd]}`]);
  }
  return out;
}

function horasLibres(state, dayKey, now) {
  state.citas = state.citas || {};
  const tomadas = state.citas[dayKey] || [];
  const p = localParts(now);
  const hoy = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return DEMO.horas.filter((h) => !tomadas.includes(h) && !(dayKey === hoy && h <= p.hh));
}

function fechaBonita(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d, 18)).getUTCDay();
  return `${DIAS[wd]} ${d} de ${MESES[m - 1]}`;
}

function ctaFinal(texto, otro) {
  const btn = otro === 'cita' ? ['cita', '📅 Probar citas'] : ['pedido', '🛒 Probar pedidos'];
  return buttons(
    `${texto}\n\n💡 *Así de fácil lo harían tus clientes.* El negocio recibe cada pedido o cita en su celular, correo, hoja de cálculo u Odoo, sin que nadie tenga que contestar.`,
    [['lead', '🚀 Quiero uno así'], btn, ['menu', '🏠 Menú']],
    'Hecho por NodOpera · nodopera.com',
  );
}

/** Lógica de un mensaje. Regresa la lista de mensajes a enviar y avisos internos. */
async function demoStep(m, s, ctx) {
  const say = [];
  const notify = [];
  const t = norm(m.text);
  let c = m.choice;

  // Atajos globales
  if (!c && MENU_KW.includes(t)) c = 'menu';
  if (!c && ['cancelar', 'salir', 'cancel'].includes(t)) c = 'cancel';
  if (!c && ['pedido', 'pedir', 'ordenar'].includes(t)) c = 'pedido';
  if (!c && ['cita', 'agendar', 'reservar'].includes(t)) c = 'cita';

  if (c === 'menu' || (s.isNew && !c)) {
    s.step = 'start';
    say.push(demoMenu(m.name));
    return { say, notify };
  }
  if (c === 'cancel') {
    s.step = 'start'; s.cart = [];
    say.push(buttons('Listo, cancelé lo que llevábamos. ¿Probamos otra cosa?',
      [['pedido', '🛒 Hacer un pedido'], ['cita', '📅 Agendar una cita'], ['lead', '🚀 Quiero uno así']]));
    return { say, notify };
  }
  if (c === 'pedido') {
    s.step = 'p_item'; s.cart = []; s.entrega = null; s.addr = null;
    say.push(demoListaMenu(s.cart));
    return { say, notify };
  }
  if (c === 'cita') {
    s.step = 'c_srv'; s.cita = {};
    say.push(list(`💈 *${DEMO.negocioCitas}*\n¿Qué servicio quieres agendar?`, 'Ver servicios',
      DEMO.servicios.map(([id, n, p, min]) => [`srv_${id}`, n, `${money(p)} · ${min} min`]), 'Servicios'));
    return { say, notify };
  }
  if (c === 'lead') {
    s.step = 'lead';
    say.push(txt('¡Va! 🙌 Cuéntame en *un solo mensaje*:\n\n1. Nombre de tu negocio y giro\n2. Qué te gustaría que hiciera tu bot (pedidos, citas, cotizaciones, soporte…)\n3. Tu nombre\n\nUlises, de NodOpera, te contacta personalmente.'));
    return { say, notify };
  }

  switch (s.step) {
    // ------------------------------ PEDIDOS ------------------------------
    case 'p_item': {
      const item = DEMO.menu.find(([id]) => c === `it_${id}`)
        || DEMO.menu.find(([, n]) => t && norm(n).includes(t) && t.length >= 4);
      if (!item) { say.push(demoListaMenu(s.cart)); break; }
      s.cur = { id: item[0], n: item[1], p: item[2] };
      s.step = 'p_qty';
      say.push(buttons(`¿Cuántas de *${item[1]}*?\nToca un botón o escribe el número.`,
        [['q_1', '1'], ['q_2', '2'], ['q_3', '3']]));
      break;
    }
    case 'p_qty': {
      const q = c?.startsWith('q_') ? Number(c.slice(2)) : parseInt(t, 10);
      if (!q || q < 1 || q > 30) {
        say.push(buttons('Escribe una cantidad entre 1 y 30, o toca un botón.', [['q_1', '1'], ['q_2', '2'], ['q_3', '3']]));
        break;
      }
      const prev = s.cart.find((x) => x.id === s.cur.id);
      if (prev) prev.q += q; else s.cart.push({ ...s.cur, q });
      s.step = 'p_more';
      say.push(buttons(`Agregado ✅\n🛒 ${cartLine(s.cart)}\nSubtotal: *${money(cartTotal(s.cart))}*\n\n¿Algo más?`,
        [['p_mas', '➕ Agregar algo'], ['p_fin', '✅ Es todo'], ['cancel', '❌ Cancelar']]));
      break;
    }
    case 'p_more': {
      if (c === 'p_mas' || ['si', 'sí', 'mas', 'más'].includes(t)) { s.step = 'p_item'; say.push(demoListaMenu(s.cart)); break; }
      if (c === 'p_fin' || ['no', 'es todo', 'listo', 'ya'].includes(t)) {
        s.step = 'p_entrega';
        say.push(buttons(`¿Cómo lo quieres? El envío cuesta ${money(DEMO.envio)}.`,
          [['dom', '🛵 A domicilio'], ['rec', '🏪 Paso por él']]));
        break;
      }
      say.push(buttons('¿Agregas algo más o cerramos el pedido?',
        [['p_mas', '➕ Agregar algo'], ['p_fin', '✅ Es todo'], ['cancel', '❌ Cancelar']]));
      break;
    }
    case 'p_entrega': {
      if (c === 'dom' || t.includes('domicilio')) {
        s.entrega = 'dom'; s.step = 'p_dir';
        say.push(txt('📍 Escríbeme la dirección de entrega (calle, número y colonia).\n_Es una demo: puedes inventarla._'));
      } else if (c === 'rec' || t.includes('recoger') || t.includes('paso')) {
        s.entrega = 'rec'; s.step = 'p_conf';
        say.push(demoResumen(s));
      } else {
        say.push(buttons('¿A domicilio o pasas por él?', [['dom', '🛵 A domicilio'], ['rec', '🏪 Paso por él']]));
      }
      break;
    }
    case 'p_dir': {
      if (m.type === 'location') { s.addr = 'Ubicación compartida 📍'; } else if (t.length < 5) {
        say.push(txt('Necesito un poco más de detalle: calle, número y colonia.'));
        break;
      } else s.addr = cut(m.text, 120);
      s.step = 'p_conf';
      say.push(demoResumen(s));
      break;
    }
    case 'p_conf': {
      if (c === 'p_edit') { s.cart = []; s.step = 'p_item'; say.push(demoListaMenu(s.cart)); break; }
      if (c !== 'p_ok' && !['si', 'sí', 'confirmar', 'ok'].includes(t)) { say.push(demoResumen(s)); break; }
      const f = folio('PED', ctx.now);
      const total = cartTotal(s.cart) + (s.entrega === 'dom' ? DEMO.envio : 0);
      ctx.state.stats = ctx.state.stats || { pedidos: 0, citas: 0, leads: 0 };
      ctx.state.stats.pedidos++;
      s.step = 'start';
      say.push(ctaFinal(
        `🎉 *¡Pedido confirmado!* Folio *${f}*\nTotal: ${money(total)} · ${s.entrega === 'dom' ? 'llega en 35–45 min' : 'listo en ~20 min'}\n\nTe avisaría por aquí cuando salga a entrega. _(Demo: no se preparará nada 😄)_`,
        'cita'));
      s.cart = [];
      break;
    }

    // ------------------------------- CITAS -------------------------------
    case 'c_srv': {
      const sv = DEMO.servicios.find(([id]) => c === `srv_${id}`);
      if (!sv) {
        say.push(list('Elige un servicio de la lista 👇', 'Ver servicios',
          DEMO.servicios.map(([id, n, p, min]) => [`srv_${id}`, n, `${money(p)} · ${min} min`]), 'Servicios'));
        break;
      }
      s.cita = { srv: sv[1], precio: sv[2], min: sv[3] };
      s.step = 'c_day';
      say.push(list(`*${sv[1]}* (${money(sv[2])}). ¿Qué día te acomoda?`, 'Ver días', proximosDias(ctx.now), 'Días disponibles', 'Abrimos lunes a sábado, 10:00 a 20:00'));
      break;
    }
    case 'c_day': {
      if (!c?.startsWith('day_')) { say.push(list('Elige un día de la lista 👇', 'Ver días', proximosDias(ctx.now), 'Días disponibles')); break; }
      const day = c.slice(4);
      const libres = horasLibres(ctx.state, day, ctx.now);
      if (!libres.length) {
        say.push(list('Ese día ya está lleno 😅 Elige otro:', 'Ver días', proximosDias(ctx.now), 'Días disponibles'));
        break;
      }
      s.cita.day = day;
      s.step = 'c_hora';
      say.push(list(`Horarios libres para el *${fechaBonita(day)}*:`, 'Ver horarios',
        libres.map((h) => [`h_${h}`, `${h}:00 hrs`, h < 12 ? 'Mañana' : h < 16 ? 'Mediodía' : 'Tarde']), 'Horarios'));
      break;
    }
    case 'c_hora': {
      const h = c?.startsWith('h_') ? Number(c.slice(2)) : null;
      const libres = horasLibres(ctx.state, s.cita.day, ctx.now);
      if (!h || !libres.includes(h)) {
        say.push(list('Ese horario ya no está disponible. Elige otro 👇', 'Ver horarios',
          libres.map((x) => [`h_${x}`, `${x}:00 hrs`]), 'Horarios'));
        break;
      }
      s.cita.h = h;
      s.step = 'c_conf';
      say.push(buttons(`📅 *Confirma tu cita*\n${s.cita.srv} · ${money(s.cita.precio)}\n${fechaBonita(s.cita.day)}, ${h}:00 hrs\n📍 ${DEMO.negocioCitas}`,
        [['c_ok', '✅ Confirmar'], ['cita', '🔄 Cambiar'], ['cancel', '❌ Cancelar']]));
      break;
    }
    case 'c_conf': {
      if (c !== 'c_ok' && !['si', 'sí', 'confirmar', 'ok'].includes(t)) {
        say.push(buttons('¿Confirmo la cita?', [['c_ok', '✅ Confirmar'], ['cita', '🔄 Cambiar'], ['cancel', '❌ Cancelar']]));
        break;
      }
      // apartar el horario para todos (así otro usuario ya no lo ve libre)
      const st = ctx.state;
      st.citas = st.citas || {};
      const libres = horasLibres(st, s.cita.day, ctx.now);
      if (!libres.includes(s.cita.h)) {
        s.step = 'c_hora';
        say.push(list('¡Uy! Alguien acaba de ganar ese horario. Elige otro 👇', 'Ver horarios', libres.map((x) => [`h_${x}`, `${x}:00 hrs`]), 'Horarios'));
        break;
      }
      (st.citas[s.cita.day] = st.citas[s.cita.day] || []).push(s.cita.h);
      // limpia días pasados
      const p = localParts(ctx.now);
      const hoy = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
      for (const k of Object.keys(st.citas)) if (k < hoy) delete st.citas[k];
      st.stats = st.stats || { pedidos: 0, citas: 0, leads: 0 };
      st.stats.citas++;
      const f = folio('CITA', ctx.now);
      s.step = 'start';
      say.push(ctaFinal(
        `✅ *¡Cita agendada!* Folio *${f}*\n${s.cita.srv}\n${fechaBonita(s.cita.day)}, ${s.cita.h}:00 hrs\n\nUn día antes te mandaría un recordatorio con opción de confirmar o reagendar. _(Demo: no hay barbero esperando 😄)_`,
        'pedido'));
      break;
    }

    // ------------------------------- LEAD --------------------------------
    case 'lead': {
      if (t.length < 8) { say.push(txt('Cuéntame un poquito más de tu negocio y qué necesitas 🙂')); break; }
      ctx.state.stats = ctx.state.stats || { pedidos: 0, citas: 0, leads: 0 };
      ctx.state.stats.leads++;
      notify.push({
        subject: `🚀 Lead desde el bot demo: ${m.name || prettyPhone(m.from)}`,
        text: `Nuevo interesado desde el bot demo de WhatsApp.\n\nNombre de perfil: ${m.name || '(sin nombre)'}\nWhatsApp: +${m.from}\nEscríbele: https://wa.me/${m.from}\n\nMensaje:\n${m.text}\n\nFecha: ${ctx.now.toLocaleString('es-MX', { timeZone: TZ })}`,
      });
      s.step = 'start';
      say.push(buttons('¡Gracias! 🙌 Ya le pasé tus datos a Ulises. Te escribe en horario laboral (L–V 9:00–18:00).\n\n¿Prefieres adelantarte? Escríbele directo: wa.me/523322488131\n🌐 nodopera.com',
        [['pedido', '🛒 Probar pedidos'], ['cita', '📅 Probar citas']]));
      break;
    }

    default: // 'start' u otro: cualquier cosa muestra el menú
      say.push(demoMenu(m.name));
  }
  return { say, notify };
}

/** Punto de entrada: procesa un webhook completo de Meta. */
async function handleWebhook(body, ctx) {
  const env = ctx.env;
  const wa = makeWA({
    token: env.WA_TOKEN, phoneId: env.DEMO_PHONE_ID, version: env.WA_GRAPH_VERSION, apiBase: env.WA_API_BASE,
    monthlyLimit: Number(env.DEMO_MONTHLY_LIMIT || 950),
  }, ctx);
  const st = ctx.state;
  const notify = [];

  for (const m of parseIncoming(body)) {
    if (m.phoneNumberId && env.DEMO_PHONE_ID && m.phoneNumberId !== String(env.DEMO_PHONE_ID)) continue; // no es de este número
    if (seenBefore(st, m.id)) continue;
    if (m.ts && ctx.now - m.ts > 10 * 60e3) continue; // mensaje viejo reentregado: no contestar

    if (wa.overLimit()) {
      const ym = localParts(ctx.now).ym;
      if (st.limitWarned !== ym) {
        st.limitWarned = ym;
        notify.push({ subject: '⚠️ Bot demo: se alcanzó el límite mensual', text: `El bot demo dejó de contestar este mes porque llegó a ${wa.usedThisMonth()} mensajes enviados (límite DEMO_MONTHLY_LIMIT). Se reactiva solo el día 1.` });
      }
      continue;
    }
    if (rateLimited(st, m.from, ctx.now, DEMO.maxPorDia)) continue;

    await wa.read(m.id);
    const s = getSession(st, m.from, ctx.now, DEMO.ttlMin);

    let r;
    if (!['text', 'interactive', 'button', 'location'].includes(m.type)) {
      r = { say: [txt('Por ahora entiendo texto y botones 🙂 Escribe *menú* para empezar.')], notify: [] };
    } else {
      r = await demoStep(m, s, ctx);
    }
    for (const p of r.say) await wa.send(m.from, p);
    notify.push(...r.notify);
  }
  return notify;
}
