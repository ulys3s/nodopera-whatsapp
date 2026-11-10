// ============================================================================
// NodOpera · Núcleo común para bots de WhatsApp Cloud API (n8n Code node)
// Se concatena antes de demo.js / clientes.js con build.js. No editar dentro de n8n:
// edita aquí, corre `node build.js` y vuelve a importar el workflow.
// ============================================================================

const TZ = 'America/Mexico_City';

/** Recorta un texto al límite que impone WhatsApp para cada campo. */
function cut(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------- Constructores de mensajes (respetan límites de Meta) ----------
function txt(body) {
  return { type: 'text', text: { body: cut(body, 4096), preview_url: false } };
}

/** Hasta 3 botones. btns = [[id, título≤20], ...] */
function buttons(body, btns, footer) {
  const m = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: cut(body, 1024) },
      action: {
        buttons: btns.slice(0, 3).map(([id, title]) => ({ type: 'reply', reply: { id, title: cut(title, 20) } })),
      },
    },
  };
  if (footer) m.interactive.footer = { text: cut(footer, 60) };
  return m;
}

/** Lista desplegable, hasta 10 filas. rows = [[id, título≤24, descripción≤72], ...] */
function list(body, buttonText, rows, sectionTitle, footer) {
  const m = {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: cut(body, 4096) },
      action: {
        button: cut(buttonText, 20),
        sections: [{
          title: cut(sectionTitle || 'Opciones', 24),
          rows: rows.slice(0, 10).map(([id, title, description]) => {
            const r = { id, title: cut(title, 24) };
            if (description) r.description = cut(description, 72);
            return r;
          }),
        }],
      },
    },
  };
  if (footer) m.interactive.footer = { text: cut(footer, 60) };
  return m;
}

// ---------- Fechas en hora de Guadalajara ----------
function localParts(date) {
  const f = new Intl.DateTimeFormat('es-MX', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = new Date(date.toLocaleString('en-US', { timeZone: TZ })).getDay(); // 0=domingo
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, wd, ym: `${p.year}-${p.month}` };
}
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Normaliza texto para comparar palabras clave (sin acentos, minúsculas). */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** Últimos 10 dígitos de un número mexicano (5213312345678 -> 3312345678). */
function last10(wa) {
  return String(wa || '').replace(/\D/g, '').slice(-10);
}
function prettyPhone(wa) {
  const d = last10(wa);
  return `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
}

// ---------- Lectura del webhook de Meta ----------
/** Devuelve los mensajes entrantes ya simplificados. Ignora "statuses" (entregado/leído). */
function parseIncoming(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const msg of v.messages || []) {
        const it = msg.interactive || {};
        const choice = it.button_reply?.id || it.list_reply?.id || msg.button?.payload || null;
        const text = msg.text?.body
          || it.button_reply?.title || it.list_reply?.title || msg.button?.text
          || msg.image?.caption || msg.document?.caption || msg.video?.caption || '';
        out.push({
          id: msg.id,
          from: msg.from,
          name: names[msg.from] || '',
          phoneNumberId: v.metadata?.phone_number_id,
          type: msg.type,
          text: String(text).trim(),
          choice,
          contextId: msg.context?.id || null,
          mediaId: msg.image?.id || msg.document?.id || msg.audio?.id || msg.video?.id || null,
          ts: Number(msg.timestamp || 0) * 1000,
        });
      }
    }
  }
  return out;
}

// ---------- Cliente de WhatsApp Cloud API ----------
/**
 * cfg = { token, phoneId, version, monthlyLimit }
 * ctx = { http, state, now }
 * Lleva el conteo mensual de mensajes enviados en state.usage para no pasar
 * de los 1,000 mensajes de servicio gratuitos por número al mes (desde oct-2026).
 */
function makeWA(cfg, ctx) {
  const base = `${cfg.apiBase || 'https://graph.facebook.com'}/${cfg.version || 'v23.0'}/${cfg.phoneId}/messages`;
  const headers = { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };
  const st = ctx.state;
  st.usage = st.usage || {};
  st.errors = st.errors || [];

  function logError(where, e) {
    const detail = e?.response?.body?.error || e?.cause?.response?.body?.error || e?.description || e?.message || String(e);
    st.errors.unshift({ at: ctx.now.toISOString(), where, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    st.errors = st.errors.slice(0, 30);
    return detail;
  }

  return {
    usedThisMonth() { return st.usage[localParts(ctx.now).ym] || 0; },
    overLimit() { return cfg.monthlyLimit > 0 && this.usedThisMonth() >= cfg.monthlyLimit; },

    /** Envía un mensaje. Regresa el id del mensaje (wamid) o null si falló. */
    async send(to, payload) {
      const ym = localParts(ctx.now).ym;
      // México: WhatsApp entrega el remitente como 521XXXXXXXXXX, pero Meta espera 52XXXXXXXXXX
      // al enviar (si no, el número de prueba responde "not in allowed list").
      if (/^521\d{10}$/.test(to)) to = '52' + to.slice(3);
      try {
        const res = await ctx.http({
          method: 'POST', url: base, headers, json: true,
          body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
        });
        st.usage[ym] = (st.usage[ym] || 0) + 1;
        return res?.messages?.[0]?.id || null;
      } catch (e) {
        logError(`send:${to}`, e);
        return null;
      }
    },

    /** Marca como leído (palomitas azules). No cuenta como mensaje cobrable. */
    async read(messageId) {
      try {
        await ctx.http({ method: 'POST', url: base, headers, json: true,
          body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId } });
      } catch (e) { logError('read', e); }
    },
    logError,
  };
}

/** Evita procesar dos veces el mismo mensaje (Meta reintenta si tardamos). */
function seenBefore(state, id) {
  state.seen = state.seen || [];
  if (state.seen.includes(id)) return true;
  state.seen.unshift(id);
  state.seen = state.seen.slice(0, 300);
  return false;
}

/** Límite por usuario y día, para que nadie se coma el cupo gratuito. */
function rateLimited(state, wa, now, maxPerDay) {
  const p = localParts(now);
  const day = `${p.ym}-${p.d}`;
  state.rl = state.rl && state.rl.day === day ? state.rl : { day, n: {} };
  state.rl.n[wa] = (state.rl.n[wa] || 0) + 1;
  return state.rl.n[wa] > maxPerDay;
}

/** Sesiones de conversación con caducidad. */
function getSession(state, wa, now, ttlMin) {
  state.s = state.s || {};
  // limpieza de sesiones viejas (más de 7 días)
  for (const k of Object.keys(state.s)) if (now - (state.s[k].t || 0) > 7 * 864e5) delete state.s[k];
  let s = state.s[wa];
  if (!s || now - (s.t || 0) > ttlMin * 60e3) s = state.s[wa] = { step: 'start', t: +now, isNew: true, keep: s?.keep || {} };
  else s.isNew = false;
  s.t = +now;
  return s;
}

function folio(prefix, now) {
  const p = localParts(now);
  return `${prefix}-${String(p.d).padStart(2, '0')}${String(p.hh).padStart(2, '0')}${String(p.mm).padStart(2, '0')}-${Math.floor(Math.random() * 90 + 10)}`;
}

const money = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
