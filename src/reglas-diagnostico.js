// ============================================================================
// Motor de reglas del Diagnóstico NodOpera (SIN IA). Determinista y sin costo:
// convierte las respuestas + el resumen agregado del Excel en el mismo JSON que
// pedía el prompt (resumen, madurez, 3 hallazgos, 3 mejoras, primer paso, preguntas).
// Regla de oro: solo cita cifras que vienen en resumen_excel; nunca inventa números.
// ============================================================================

const RG_ETQ = ['Manual', 'Básico', 'Ordenado', 'Integrado', 'Inteligente'];
const RG_IMP = { alto: 3, medio: 2, bajo: 1 };
const rgMoney = (n) => '$' + Math.round(Number(n)).toLocaleString('es-MX');
const rgNum = (n) => Number(n).toLocaleString('es-MX', { maximumFractionDigits: 1 });
const rgNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const rgCut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const RG_PROPIOS = /^(Excel|WhatsApp|Odoo|CFDI|SAT|ERP|CRM|Aspel|SAP|PDF)\b/;
/** Primera letra en minúscula, salvo nombres propios (Excel, WhatsApp, Odoo…). */
const rgMin = (s) => (RG_PROPIOS.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
const rgList = (a) => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' y ' + a[a.length - 1];

/** Temas que se detectan en los textos libres (tarea y lo que quiere saber). */
const RG_TEMAS = {
  inventario: /inventari|existenc|conteo|contar|almacen|bodega|stock|faltante|surtir|resurt|caducid/,
  factura: /factur|cfdi|timbr|xml|sat\b|complemento de pago/,
  cobranza: /cobr|cartera|credito|deud|adeud|pagos? pendiente|vencid/,
  reportes: /report|cuadrar|concili|excel|hoja|cierre|corte de caja|numeros|cifras/,
  pedidos: /pedido|whatsapp|mensaje|cotiz|orden(es)? de venta|apartad/,
  captura: /captur|teclear|pasar a mano|transcrib|vaciar|copiar|duplic/,
  margen: /margen|ganan|utilidad|rentab|costo|precio/,
  rotacion: /no se mueve|rotaci|lento|muert|sin movimiento|que se vende|mas vendid|menos vendid/,
  sucursal: /sucursal|tienda|por punto/,
  personal: /nomina|asistencia|empleado|vendedor|comision|turno/,
  ti: /internet|red\b|wifi|computador|equipo|impresor|virus|respaldo|camara|servidor|lent[oa]s? (la|el) (sistema|compu)/,
};
function rgTemas(texto) {
  const t = rgNorm(texto); const out = {};
  for (const [k, re] of Object.entries(RG_TEMAS)) if (re.test(t)) out[k] = true;
  return out;
}

/** Lecturas del Excel (solo con cifras del resumen). */
function rgExcel(x) {
  const o = { sinMov: null, critico: null, tendencia: null, concentracion: null, sucursales: null, margen: null };
  if (!x || typeof x !== 'object') return o;
  if (x.sin_movimiento && Number(x.sin_movimiento.total) > 0) o.sinMov = x.sin_movimiento;
  if (x.stock_critico && Number(x.stock_critico.total) > 0) o.critico = x.stock_critico;
  if (typeof x.margen_bruto_pct === 'number') o.margen = x.margen_bruto_pct;
  const m = Array.isArray(x.ventas_por_mes) ? x.ventas_por_mes.filter((r) => Array.isArray(r) && typeof r[1] === 'number') : [];
  if (m.length >= 4) {
    // el último mes suele venir incompleto: comparamos los 3 meses completos más recientes contra los 3 anteriores
    const c = m.slice(0, -1), a = c.slice(-3), b = c.slice(-6, -3);
    if (b.length === 3) {
      const sa = a.reduce((s, r) => s + r[1], 0), sb = b.reduce((s, r) => s + r[1], 0);
      if (sb > 0) o.tendencia = { pct: Math.round((sa / sb - 1) * 1000) / 10, de: `${b[0][0]} a ${b[2][0]}`, a: `${a[0][0]} a ${a[2][0]}`, va: sa, vb: sb };
    }
    const mx = m.reduce((p, r) => (r[1] > p[1] ? r : p)), mn = c.length ? c.reduce((p, r) => (r[1] < p[1] ? r : p)) : null;
    o.mejorMes = mx; o.peorMes = mn;
  }
  if (Array.isArray(x.top_productos) && x.top_productos.length && Number(x.ventas_totales) > 0) {
    const top3 = x.top_productos.slice(0, 3), s3 = top3.reduce((s, p) => s + (Number(p.importe) || 0), 0);
    const pct = Math.round(s3 / x.ventas_totales * 1000) / 10;
    if (pct >= 40) o.concentracion = { pct, nombres: top3.map((p) => p.producto) };
  }
  if (Array.isArray(x.ventas_por_sucursal) && x.ventas_por_sucursal.length >= 2) {
    const s = x.ventas_por_sucursal, tot = s.reduce((a, r) => a + r[1], 0);
    if (tot > 0) o.sucursales = { mayor: s[0], menor: s[s.length - 1], pctMayor: Math.round(s[0][1] / tot * 1000) / 10, pctMenor: Math.round(s[s.length - 1][1] / tot * 1000) / 10, n: s.length };
  }
  return o;
}

/**
 * Motor principal. d = { respuestas, resumen_excel, contacto }.
 * Cada regla que aplica suma un candidato a hallazgo y otro a mejora con un puntaje;
 * se eligen los 3 mejores de cada uno (sin repetir tema) y se ordenan por impacto.
 */
function reporteReglas(d) {
  const r = d.respuestas, x = d.resumen_excel || null, emp = d.contacto && d.contacto.empresa || 'tu empresa';
  const reg = rgNorm(r.registro), cob = rgNorm(r.cobranza), fac = rgNorm(r.facturacion);
  const canales = r.canales || [];
  const multi = r.sucursales && r.sucursales !== '1';
  const tema = { ...rgTemas(r.tarea), ...Object.fromEntries(Object.keys(rgTemas(r.saber)).map((k) => ['q_' + k, true])) };
  const tareaCita = r.tarea ? `“${rgCut(r.tarea, 140)}”` : '';
  const saberCita = r.saber ? `“${rgCut(r.saber, 140)}”` : '';
  const ex = rgExcel(x);
  const manual = /papel|libreta|no lo llevamos/.test(reg), enExcel = /^excel/.test(reg), propio = /sistema propio/.test(reg), erp = /erp/.test(reg);
  const credito = canales.includes('A crédito');
  const cobManual = /libreta|excel|a mano|no hay seguimiento/.test(cob);
  const facSeparada = /portal|programa|contador/.test(fac) && !erp;
  const H = [], M = [];
  const h = (tema, score, titulo, detalle, evidencia) => H.push({ tema, score, titulo, detalle, evidencia });
  const m = (tema, score, titulo, que_hacer, beneficio, impacto, esfuerzo, servicio, paso) => M.push({ tema, score, titulo, que_hacer, beneficio, impacto, esfuerzo, servicio, paso });

  // ---- registro de ventas e inventario ----
  if (manual) {
    h('registro', 90 + (multi ? 6 : 0), 'Ventas e inventario sin un sistema',
      `Hoy ${/no lo llevamos/.test(reg) ? 'no llevan un registro formal' : 'llevan el control en papel'}${multi ? ` con ${r.sucursales} sucursales` : ''}: no hay forma rápida de saber qué se vendió, qué falta ni cuánto queda en caja.`,
      `Dónde llevan ventas e inventario: ${r.registro}`);
    m('registro', 92, 'Punto de venta e inventario en un solo sistema', 'Instalar punto de venta e inventario en Odoo para que cada venta descuente existencias al momento y quede registrada por sucursal.',
      'Saber en tiempo real qué se vende y qué hay que surtir.', 'alto', 'medio', 'Odoo Systems', 'Elige el punto de venta con más movimiento y anota durante una semana cada venta y cada entrada de mercancía; con eso arrancamos el catálogo.');
  } else if (enExcel) {
    h('registro', 78 + (multi ? 10 : 0), multi ? 'Excel distinto en cada sucursal' : 'Control de ventas en Excel',
      `El control vive en Excel${multi ? ` y tienen ${r.sucursales} sucursales` : ''}: se duplican versiones, las existencias no cuadran y armar un reporte toma horas.`,
      `Dónde llevan ventas e inventario: ${r.registro}`);
    m('registro', 82 + (multi ? 6 : 0), 'Pasar de Excel a un sistema en línea', `Migrar tus hojas a Odoo (ventas, inventario${multi ? ' por sucursal' : ''} y catálogo) conservando tu historial, para trabajar todos sobre los mismos datos.`,
      'Un solo dato confiable y cero archivos duplicados.', 'alto', 'medio', 'Odoo Systems', 'Junta en una carpeta el Excel más reciente de cada sucursal (ventas, inventario y catálogo); es lo que se migra primero.');
  } else if (propio) {
    h('registro', 55, 'Sistema propio que no se conecta', 'Tienen un sistema propio; normalmente la facturación, la cobranza y los reportes se terminan haciendo fuera de él, a mano.', `Dónde llevan ventas e inventario: ${r.registro}`);
    m('registro', 58, 'Conectar tu sistema con lo demás', 'Conectar tu sistema actual con la facturación y un tablero mediante integraciones, sin cambiar de sistema de golpe.', 'Menos recaptura y cifras al día.', 'medio', 'medio', 'Automatización e IA', 'Haz una lista de los datos que hoy copias de tu sistema a otro lado (Excel, facturación, WhatsApp).');
  } else if (erp) {
    h('registro', 40, 'ERP con información por aprovechar', 'Ya tienen un ERP: el siguiente paso es que la información llegue sola a quien decide, sin exportar y armar reportes a mano.', `Dónde llevan ventas e inventario: ${r.registro}`);
  }

  // ---- cobranza ----
  if (credito && cobManual) {
    h('cobranza', 84, 'Cobranza a crédito sin seguimiento', `Venden a crédito y la cobranza se sigue ${/no hay/.test(cob) ? 'sin un control formal' : 'a mano'}: es donde una pyme suele tener más dinero detenido sin darse cuenta.`, `Cómo cobran: ${r.cobranza}`);
    m('cobranza', 86, 'Recordatorios de pago automáticos', 'Llevar las cuentas por cobrar en el sistema con antigüedad de saldos y enviar recordatorios automáticos por WhatsApp antes y después del vencimiento.',
      'Cobrar a tiempo sin perseguir a cada cliente.', 'alto', 'bajo', 'Automatización e IA', 'Saca la lista de clientes con saldo pendiente, cuánto deben y desde cuándo; con eso vemos cuánto dinero está detenido.');
  } else if (cobManual) {
    h('cobranza', 45, 'Pagos pendientes controlados a mano', `La cobranza se controla ${/no hay/.test(cob) ? 'sin un seguimiento formal' : 'a mano'}; cuando crecen los clientes es fácil que algo se olvide.`, `Cómo cobran: ${r.cobranza}`);
  }

  // ---- facturación ----
  if (facSeparada && !/no factur/.test(fac)) {
    h('factura', 62 + (tema.factura ? 15 : 0), 'Facturación separada de la venta', `Facturan ${/contador/.test(fac) ? 'a través del contador' : 'en una herramienta aparte'}: los datos de cada venta se vuelven a capturar para timbrar el CFDI.`, `Cómo facturan: ${r.facturacion}`);
    m('factura', 64 + (tema.factura ? 15 : 0), 'Facturar CFDI desde la misma venta', 'Timbrar el CFDI directo desde la venta en el sistema, con los datos fiscales del cliente guardados y el XML y PDF archivados solos.',
      'Facturas en segundos y sin errores de captura.', 'medio', 'bajo', 'Odoo Systems', 'Cuenta cuántas facturas emiten al mes y cuánto tarda cada una; es la base para medir el ahorro.');
  }

  // ---- WhatsApp y pedidos ----
  if (canales.includes('WhatsApp')) {
    h('pedidos', 52 + (tema.pedidos ? 22 : 0), 'Pedidos de WhatsApp que se recapturan', 'Venden por WhatsApp: si los pedidos no llegan solos al sistema, alguien los vuelve a capturar y ahí se pierden ventas y tiempo.', `Canales de venta: ${rgList(canales)}`);
    m('pedidos', 56 + (tema.pedidos ? 22 : 0), 'Bot de WhatsApp que toma pedidos', 'Un bot en tu WhatsApp que muestra productos, toma el pedido y lo deja registrado en tu sistema para surtirlo, las 24 horas.',
      'Más pedidos atendidos sin aumentar personal.', 'medio', 'medio', 'Automatización e IA', 'Guarda los 20 pedidos de WhatsApp más recientes para ver qué preguntan y cómo piden.');
  }
  if (canales.includes('En línea') && (manual || enExcel)) {
    h('linea', 50, 'Venta en línea sin inventario conectado', 'Venden en línea pero el inventario se lleva aparte: se pueden vender productos que ya no hay.', `Canales: ${rgList(canales)} · Registro: ${r.registro}`);
  }

  // ---- texto libre: tarea que más tiempo quita ----
  if (r.tarea) {
    if (tema.inventario) { h('inventario', 80, 'El inventario consume tu semana', `Nos contaste: ${tareaCita}. Contar y cuadrar existencias a mano es de las tareas que más horas se lleva.`, 'Tarea que más tiempo quita');
      m('inventario', 78, 'Inventario que se actualiza solo', `Que cada venta y cada compra muevan el inventario en automático${multi ? ' por sucursal' : ''}, con conteos cíclicos cortos en lugar de un conteo completo.`, 'Recuperar las horas del conteo y evitar faltantes.', 'alto', 'medio', 'Odoo Systems', 'Elige 20 productos de alto movimiento y cuéntalos esta semana; comparamos contra lo que dice tu registro.'); }
    if (tema.reportes || tema.captura) { h('reportes', 74, 'Horas armando reportes a mano', `Nos contaste: ${tareaCita}. Juntar y cuadrar datos a mano cada semana es tiempo que se puede automatizar.`, 'Tarea que más tiempo quita');
      m('reportes', 72, 'Tablero que se arma solo', 'Un tablero con ventas, inventario y cobranza que se actualiza solo desde tus datos y se consulta en el celular.', 'Ver cómo va el negocio en minutos, sin armar reportes.', 'medio', 'bajo', 'Intelligence (tableros)', 'Anota qué reportes armas cada semana, de dónde salen los datos y cuánto tiempo te toma cada uno.'); }
    if (tema.cobranza && !(credito && cobManual)) { h('cobranza', 70, 'La cobranza te quita tiempo', `Nos contaste: ${tareaCita}.`, 'Tarea que más tiempo quita');
      m('cobranza', 70, 'Recordatorios de pago automáticos', 'Cuentas por cobrar con antigüedad de saldos y recordatorios automáticos por WhatsApp.', 'Cobrar a tiempo sin perseguir a cada cliente.', 'alto', 'bajo', 'Automatización e IA', 'Saca la lista de clientes con saldo pendiente y desde cuándo.'); }
    if (tema.ti) { h('ti', 66, 'Fallas de equipo o red frenan el trabajo', `Nos contaste: ${tareaCita}. Cuando la red, los equipos o los respaldos fallan, todo lo demás se detiene.`, 'Tarea que más tiempo quita');
      m('ti', 66, 'Soporte preventivo de equipos y red', 'Revisar y documentar equipos, red, Wi‑Fi y respaldos, con mantenimiento preventivo y una mesa de ayuda que responde.', 'Menos interrupciones y respaldos que sí funcionan.', 'medio', 'bajo', 'Soporte TI', 'Haz una lista de las fallas de equipo o internet del último mes y cuánto tiempo te detuvo cada una.'); }
    if (tema.personal) { h('personal', 48, 'Control de personal a mano', `Nos contaste: ${tareaCita}.`, 'Tarea que más tiempo quita'); }
  }

  // ---- lo que quiere saber ----
  if (tema.q_margen) m('margen', 60 + (ex.margen != null ? 8 : 0), 'Margen por producto y sucursal', 'Cruzar ventas contra costos para ver el margen real por producto, categoría y sucursal en un tablero.', 'Saber dónde ganas de verdad y dónde no.', 'alto', 'medio', 'Intelligence (tableros)', 'Junta tu lista de costos actualizada; es lo único que falta para calcular el margen.');
  if (tema.q_rotacion && !ex.sinMov) m('rotacion', 58, 'Saber qué se mueve y qué no', 'Un reporte de rotación que marque los productos sin venta en 90 días y los que están por agotarse.', 'Menos dinero detenido en anaqueles.', 'medio', 'bajo', 'Intelligence (tableros)', 'Exporta las ventas de los últimos 6 meses por producto.');
  if (tema.q_sucursal && multi) m('sucursal', 56, 'Comparativo entre sucursales', 'Un tablero que compare ventas, ticket y margen entre sucursales con el mismo criterio.', 'Detectar a tiempo la sucursal que se queda atrás.', 'medio', 'bajo', 'Intelligence (tableros)', 'Pide a cada sucursal su venta del último mes con el mismo formato.');

  // ---- Excel: hallazgos con cifras del resumen ----
  if (ex.sinMov) { const s = ex.sinMov; h('xsinmov', 88, `${rgNum(s.total)} productos sin movimiento`, `Tu archivo muestra ${rgNum(s.total)} productos ${s.criterio || 'sin ventas'}${s.ejemplos && s.ejemplos.length ? ` (por ejemplo: ${rgList(s.ejemplos.slice(0, 3))})` : ''}: es dinero detenido en anaqueles.`, 'Resumen de tu archivo: productos sin movimiento');
    m('xsinmov', 80, 'Liberar el inventario que no se mueve', 'Revisar los productos sin movimiento para liquidarlos, devolverlos al proveedor o dejar de comprarlos, y vigilarlos en un tablero.', 'Recuperar efectivo y espacio.', 'alto', 'bajo', 'Intelligence (tableros)', `Revisa la lista de los ${rgNum(s.total)} productos sin movimiento y marca cuáles puedes liquidar o devolver.`); }
  if (ex.critico) { const s = ex.critico; h('xcritico', 82, `${rgNum(s.total)} productos en stock crítico`, `Tu archivo muestra ${rgNum(s.total)} productos ${s.criterio || 'agotados'}${s.ejemplos && s.ejemplos.length ? ` (por ejemplo: ${rgList(s.ejemplos.slice(0, 3))})` : ''}: cada faltante es una venta que se va con la competencia.`, 'Resumen de tu archivo: stock crítico');
    m('xcritico', 76, 'Alertas de reorden automáticas', 'Calcular un punto de reorden por producto con su venta diaria y avisar en automático cuando hay que comprar.', 'Menos ventas perdidas por faltantes.', 'alto', 'medio', 'Odoo Systems', `Revisa con tu comprador los ${rgNum(s.total)} productos en stock crítico y confirma cuáles ya están pedidos.`); }
  if (ex.tendencia && Math.abs(ex.tendencia.pct) >= 8) { const t = ex.tendencia; const baja = t.pct < 0;
    h('xtend', baja ? 86 : 50, baja ? 'Las ventas vienen bajando' : 'Las ventas vienen creciendo', `En tu archivo, las ventas de ${t.a} suman ${rgMoney(t.va)} contra ${rgMoney(t.vb)} de ${t.de}: ${baja ? 'una baja' : 'un alza'} de ${rgNum(Math.abs(t.pct))}%.${baja ? ' Conviene ubicar en qué productos o sucursales se concentra.' : ' Es buen momento para ordenar la operación antes de que el crecimiento la rebase.'}`, 'Resumen de tu archivo: ventas por mes'); }
  if (ex.concentracion) { const c = ex.concentracion;
    h('xconc', 60, 'Ventas concentradas en pocos productos', `Tus 3 productos más vendidos (${rgList(c.nombres.map((n) => rgCut(n, 40)))}) suman el ${rgNum(c.pct)}% de las ventas del archivo: un faltante en ellos pega fuerte.`, 'Resumen de tu archivo: top de productos'); }
  if (ex.sucursales && ex.sucursales.pctMayor - ex.sucursales.pctMenor >= 15) { const s = ex.sucursales;
    h('xsuc', 64, 'Diferencia fuerte entre sucursales', `${rgCut(s.mayor[0], 40)} vende el ${rgNum(s.pctMayor)}% del total y ${rgCut(s.menor[0], 40)} el ${rgNum(s.pctMenor)}%. Vale la pena entender qué hace distinto cada una.`, 'Resumen de tu archivo: ventas por sucursal');
    m('sucursal', 62, 'Comparativo entre sucursales', 'Un tablero que compare ventas, ticket y margen por sucursal con el mismo criterio, para replicar lo que funciona.', 'Detectar a tiempo la sucursal que se queda atrás.', 'medio', 'bajo', 'Intelligence (tableros)', 'Pide a cada sucursal su venta del último mes con el mismo formato.'); }
  if (ex.margen != null && ex.margen < 20) {
    h('xmargen', 70, 'Margen bruto ajustado', `El margen bruto que sale de tu archivo es de ${rgNum(ex.margen)}%${x.margen_base ? ` (${x.margen_base})` : ''}: hay poco espacio para descuentos, mermas o errores de precio.`, 'Resumen de tu archivo: margen');
    m('margen', 72, 'Margen por producto y sucursal', 'Cruzar ventas contra costos por producto para detectar los que se venden con margen bajo o negativo.', 'Subir el margen sin vender más.', 'alto', 'medio', 'Intelligence (tableros)', 'Revisa los precios de los 10 productos más vendidos contra su costo actual.'); }
  if (x && !ex.sinMov && !ex.critico && !H.some((y) => y.tema.startsWith('x')) && Number(x.ventas_totales) > 0) {
    h('xbase', 46, 'Ya tienes datos para un tablero', `Tu archivo suma ${rgMoney(x.ventas_totales)} en ventas${x.periodo ? ` (${x.periodo})` : ''} y ${rgNum(x.productos_distintos || 0)} productos: con eso se puede armar un tablero que se actualice solo.`, 'Resumen de tu archivo'); }

  // ---- respaldo: nunca menos de 3 ----
  if (!M.some((y) => y.servicio === 'Intelligence (tableros)')) m('reportes', 40, 'Tablero con tus indicadores clave', 'Un tablero que muestre ventas, inventario y cobranza actualizados, sin armar reportes a mano.', 'Ver cómo va el negocio en minutos.', 'medio', 'bajo', 'Intelligence (tableros)', 'Anota los 5 números que te gustaría ver cada lunes.');
  m('ti', 20, 'Revisión preventiva de equipos y red', 'Inventariar equipos, revisar la red y probar que los respaldos de la información clave sí se pueden recuperar.', 'Que la operación no se detenga por una falla.', 'medio', 'bajo', 'Soporte TI', 'Anota qué equipos usan para vender y facturar y cuándo fue la última vez que se respaldaron.');
  m('auto', 18, 'Automatizar avisos repetitivos', 'Automatizar los avisos que hoy se mandan a mano (confirmaciones, recordatorios, reportes del día) por WhatsApp o correo.', 'Menos tareas repetitivas para tu equipo.', 'bajo', 'bajo', 'Automatización e IA', 'Haz una lista de los mensajes que mandas igual todos los días.');
  if (H.length < 3) h('info', 30, 'Falta información para precisar', 'Con lo que nos contaste aún no vemos un cuello de botella claro; en la llamada lo aterrizamos con un par de preguntas.', 'Respuestas del diagnóstico');
  if (H.length < 3) h('crec', 25, 'Procesos que dependen de personas', `Con ${r.empleados} personas, mucho de la operación suele vivir en la cabeza de alguien; documentarlo evita depender de una sola persona.`, `Empleados: ${r.empleados}`);
  if (H.length < 3) h('datos', 20, 'Decisiones sin un tablero', 'Sin un tablero, las decisiones se toman con la memoria o con reportes atrasados.', 'Respuestas del diagnóstico');

  const top = (arr, n) => {
    const seen = new Set(), out = [];
    for (const y of arr.slice().sort((a, b) => b.score - a.score)) { if (seen.has(y.tema)) continue; seen.add(y.tema); out.push(y); if (out.length === n) break; }
    return out;
  };
  const hall = top(H, 3);
  const mej = top(M, 3).sort((a, b) => RG_IMP[b.impacto] - RG_IMP[a.impacto] || b.score - a.score);

  // ---- madurez ----
  let nivel = manual ? 1 : enExcel ? 2 : propio ? 3 : erp ? 4 : 2;
  if (erp && !cobManual && /sistema|erp/.test(fac)) nivel = 4;
  if (nivel >= 3 && (credito && cobManual)) nivel -= 1;
  if (nivel > 1 && manual) nivel = 1;
  const expl = ['Casi todo se lleva a mano o de memoria.', 'Hay registros, pero en hojas sueltas que no se hablan entre sí.', 'Tienen sistema, pero hay pasos importantes que se hacen fuera de él.',
    'La información está en un sistema; falta que llegue sola a quien decide.', 'Datos conectados y decisiones con tableros.'][nivel - 1];

  const giro = rgNorm(r.giro) === 'otro' ? 'un negocio' : `un negocio de ${r.giro.charAt(0).toLowerCase() + r.giro.slice(1)}`;
  const resumen = rgCut(`${emp} es ${giro} con ${r.sucursales === '1' ? 'una sucursal' : r.sucursales + ' sucursales'} y ${r.empleados} personas, que vende por ${rgList(canales.map(rgMin))} y lleva ventas e inventario en ${rgMin(r.registro)}. `
    + `Lo más urgente: ${rgMin(hall[0].titulo)}. La oportunidad principal: ${rgMin(mej[0].titulo)}.`, 880);

  // ---- preguntas para la llamada ----
  const P = [];
  if (manual || enExcel) P.push(multi ? '¿Cada sucursal lleva su propio archivo o comparten uno?' : '¿Quién captura las ventas y cada cuánto se actualiza el registro?');
  if (credito) P.push('¿Cuánto dinero tienes hoy en cuentas por cobrar y cuántos clientes deben?');
  if (facSeparada) P.push('¿Cuántas facturas emiten al mes y quién las hace?');
  if (canales.includes('WhatsApp')) P.push('¿Cuántos pedidos reciben por WhatsApp al día y cómo llegan al sistema?');
  if (!x) P.push('¿Nos puedes compartir un Excel de ventas de los últimos 6 meses para afinar el diagnóstico?');
  if (r.saber) P.push(`Sobre lo que quieres saber (${rgCut(r.saber, 80)}): ¿qué decisión tomarías con ese dato?`);
  if (!r.tarea) P.push('¿Qué tarea repetitiva te gustaría dejar de hacer cada semana?');
  P.push('¿Qué reporte te gustaría tener cada lunes sin armarlo a mano?');

  const limpia = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    resumen,
    madurez: { nivel, etiqueta: RG_ETQ[nivel - 1], explicacion: expl },
    hallazgos: hall.map((y) => ({ titulo: rgCut(y.titulo, 88), detalle: rgCut(y.detalle, 480), evidencia: rgCut(y.evidencia, 380) })),
    mejoras: mej.map((y) => limpia(y, ['titulo', 'que_hacer', 'beneficio', 'impacto', 'esfuerzo', 'servicio'])),
    primer_paso: rgCut(mej[0].paso, 580),
    preguntas_para_llamada: [...new Set(P)].slice(0, 3).map((q) => rgCut(q, 290)),
    motor: 'reglas',
  };
}
