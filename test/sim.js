// Simulador: ejecuta el código del nodo "Bot" tal como lo correría n8n.
// Uso: node test/sim.js  (corre conversaciones de ejemplo y valida)
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function loadCode(file) {
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'n8n/workflows', file), 'utf8'));
  return wf.nodes.find((n) => n.name === 'Bot').parameters.jsCode;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function makeRunner(file, cfg) {
  const fn = new AsyncFunction('$input', '$getWorkflowStaticData', '$env', 'require', loadCode(file));
  const crypto = require('crypto');
  const env = { WA_APP_SECRET: 'appsecret-test', ...cfg };
  const state = {};
  const sent = [];
  const db = { partners: [{ id: 7, name: 'Abarrotes Lupita', phone: '+52 33 1111 2222', commercial_partner_id: [7, 'Abarrotes Lupita'] }], tickets: [] };
  let n = 0;
  async function httpRequest(o) {
    if (o.url.includes('graph.facebook.com')) {
      if (o.body.status === 'read') return { success: true };
      if (o.body.to === 'FAIL') { const e = new Error('400'); e.response = { body: { error: { code: 131047, message: 'Re-engagement' } } }; throw e; }
      // valida límites de Meta
      const it = o.body.interactive;
      if (it?.type === 'button') { assert(it.action.buttons.length <= 3); it.action.buttons.forEach((b) => assert(b.reply.title.length <= 20, b.reply.title)); }
      if (it?.type === 'list') { const rows = it.action.sections[0].rows; assert(rows.length <= 10 && rows.length > 0); rows.forEach((r) => { assert(r.title.length <= 24, r.title); assert(!r.description || r.description.length <= 72); }); assert(it.action.button.length <= 20); }
      const id = 'wamid.OUT' + (++n);
      sent.push({ id, to: o.body.to, msg: o.body });
      return { messages: [{ id }] };
    }
    if (o.url.endsWith('/jsonrpc')) {
      const { service, method, args } = o.body.params;
      if (service === 'common') return { result: 2 };
      const [, , , model, m, a, kw] = args;
      if (model === 'res.partner' && m === 'search_read') {
        const pat = a[0][0][2].replace(/%/g, '');
        return { result: db.partners.filter((p) => p.phone.replace(/\D/g, '').includes(pat)).slice(0, 1) };
      }
      if (model === 'res.partner' && m === 'create') { const id = 100 + db.partners.length; db.partners.push({ id, ...a[0], commercial_partner_id: [id, a[0].name] }); return { result: id }; }
      if (model === 'nodopera.ticket' && m === 'create') { const id = db.tickets.length + 1; db.tickets.push({ id, number: `SOP-${String(id).padStart(4, '0')}`, state: 'new', ...a[0] }); return { result: id }; }
      if (model === 'nodopera.ticket' && m === 'read') return { result: db.tickets.filter((t) => a[0].includes(t.id)) };
      if (model === 'nodopera.ticket' && m === 'search_read') return { result: db.tickets.filter((t) => t.partner_id === a[0][0][2]) };
    }
    throw new Error('URL no simulada ' + o.url);
  }
  let seq = 0;
  async function msg(from, content, extra = {}) {
    const m = { from, id: 'wamid.IN' + (++seq), timestamp: String(Math.floor(Date.now() / 1000)), ...content };
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: cfg.DEMO_PHONE_ID || cfg.CLIENTES_PHONE_ID },
      contacts: [{ wa_id: from, profile: { name: extra.name || 'Juan Pérez' } }], messages: [m] } }] }] };
    const before = sent.length;
    const raw = Buffer.from(JSON.stringify(body));
    const sig = extra.sig !== undefined ? extra.sig : 'sha256=' + crypto.createHmac('sha256', env.WA_APP_SECRET).update(raw).digest('hex');
    const headers = sig === null ? {} : { 'x-hub-signature-256': sig };
    const out = await fn.call({ helpers: { httpRequest, getBinaryDataBuffer: async () => raw } },
      { all: () => [{ json: { headers, body } }] }, () => state, env, require);
    return { replies: sent.slice(before), notify: out };
  }
  const text = (from, body, extra) => msg(from, { type: 'text', text: { body } }, extra);
  const tap = (from, id, title = id) => msg(from, { type: 'interactive', interactive: { type: id.startsWith('x') ? 'list_reply' : 'button_reply', button_reply: { id, title } } });
  return { text, tap, msg, state, sent, db };
}

function show(label, r) {
  for (const s of r.replies) {
    const m = s.msg;
    const body = m.text?.body || m.interactive?.body?.text;
    const opts = m.interactive?.action?.buttons?.map((b) => `[${b.reply.title}]`).join(' ')
      || m.interactive?.action?.sections?.[0]?.rows.map((x) => `{${x.title}}`).join(' ') || '';
    console.log(`  🤖→${s.to}: ${body.replace(/\n+/g, ' ⏎ ').slice(0, 170)} ${opts}`);
  }
  for (const n of r.notify) console.log(`  ✉️  ${n.json.subject}`);
  if (label) console.log('');
}

(async () => {
  console.log('===== BOT DEMO =====');
  const d = makeRunner('bot-demo.json', { WA_TOKEN: 't', DEMO_PHONE_ID: '111', NOTIFY_TO: 'u@x', NOTIFY_FROM: 'b@x' });
  const U = '5213312345678';
  let r;
  // Firma: inválida, ausente o con otro secreto => se descarta sin contestar
  for (const sig of ['sha256=' + '0'.repeat(64), null, 'sha1=abc']) {
    r = await d.text(U, 'hola', { sig });
    assert.equal(r.replies.length, 0, 'contestó con firma inválida: ' + sig);
  }
  assert.equal(d.state.rejected, 3);
  console.log('✔ Firma inválida / ausente: descartado (3 de 3)');
  console.log('👤 hola'); show(1, r = await d.text(U, 'hola'));
  assert.equal(r.replies.length, 1);
  console.log('👤 [Hacer pedido]'); show(1, await d.tap(U, 'pedido'));
  console.log('👤 {Tacos al pastor}'); show(1, await d.tap(U, 'it_pastor'));
  console.log('👤 "2"'); show(1, await d.text(U, '2'));
  console.log('👤 [Agregar algo] → horchata → [1]'); await d.tap(U, 'p_mas'); await d.tap(U, 'it_horchata'); show(1, await d.tap(U, 'q_1'));
  console.log('👤 [Es todo]'); show(1, await d.tap(U, 'p_fin'));
  console.log('👤 [A domicilio]'); show(1, await d.tap(U, 'dom'));
  console.log('👤 "Av. Vallarta 1234, Arcos"'); show(1, r = await d.text(U, 'Av. Vallarta 1234, Arcos'));
  assert(r.replies[0].msg.interactive.body.text.includes('$260')); // 2*95+40+30
  console.log('👤 [Confirmar]'); show(1, await d.tap(U, 'p_ok'));
  console.log('👤 [Probar citas]'); show(1, await d.tap(U, 'cita'));
  console.log('👤 {Corte + barba}'); show(1, r = await d.tap(U, 'srv_combo'));
  const day = r.replies[0].msg.interactive.action.sections[0].rows[1].id;
  console.log('👤 {día 2}'); show(1, r = await d.tap(U, day));
  const hour = r.replies[0].msg.interactive.action.sections[0].rows[0].id;
  console.log('👤 {primer horario}'); show(1, await d.tap(U, hour));
  console.log('👤 [Confirmar]'); show(1, await d.tap(U, 'c_ok'));
  // otro usuario ya no ve ese horario
  const U2 = '5213399999999';
  await d.tap(U2, 'cita'); await d.tap(U2, 'srv_corte'); r = await d.tap(U2, day);
  assert(!r.replies[0].msg.interactive.action.sections[0].rows.some((x) => x.id === hour), 'horario apartado sigue visible');
  console.log('✔ El horario apartado ya no aparece para otro usuario\n');
  console.log('👤 [Quiero uno así]'); show(1, await d.tap(U, 'lead'));
  console.log('👤 lead'); show(1, r = await d.text(U, 'Tengo una pizzería en Zapopan, quiero tomar pedidos. Soy Carlos'));
  assert.equal(r.notify.length, 1);
  console.log('👤 (audio)'); show(1, await d.msg(U, { type: 'audio', audio: { id: 'a1' } }));
  // duplicado de Meta no se contesta dos veces
  const before = d.sent.length;
  const dup = { type: 'text', text: { body: 'hola' }, id: 'wamid.DUP' };
  await d.msg(U, dup); await d.msg(U, dup);
  assert.equal(d.sent.length - before, 1); console.log('✔ Mensaje duplicado ignorado');
  // límite mensual
  const ym = Object.keys(d.state.usage)[0]; d.state.usage[ym] = 950;
  r = await d.text(U, 'hola'); assert.equal(r.replies.length, 0); assert.equal(r.notify.length, 1);
  console.log('✔ Al llegar al límite mensual deja de contestar y avisa una vez:', r.notify[0].json.subject);
  console.log('   Mensajes del bot en la demo completa:', d.sent.length);

  console.log('\nTODAS LAS PRUEBAS PASARON ✅');
})().catch((e) => { console.error('❌', e); process.exit(1); });
