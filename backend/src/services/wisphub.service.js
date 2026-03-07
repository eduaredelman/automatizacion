const axios = require('axios');
const logger = require('../utils/logger');

const BASE_URL = process.env.WISPHUB_API_URL || 'https://api.wisphub.app/api';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  config.headers['Authorization'] = `Api-Key ${process.env.WISPHUB_API_TOKEN}`;
  config.headers['Content-Type'] = 'application/json';
  return config;
});

const withRetry = async (fn, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      // No reintentar en errores 4xx (el servidor rechazó la solicitud, reintentar no ayuda)
      if (status >= 400 && status < 500) throw err;
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
      logger.warn(`WispHub retry ${i + 1}/${retries}`);
    }
  }
};

// ─────────────────────────────────────────────────────────────
// BUSCAR CLIENTES
// ─────────────────────────────────────────────────────────────

const buscarClientePorTelefono = async (phone) => {
  const clean = phone.replace(/^51/, '').replace(/\D/g, '');
  const variants = [clean, `51${clean}`];
  const fields = ['celular', 'telefono'];

  for (const field of fields) {
    for (const variant of variants) {
      try {
        const { data } = await withRetry(() =>
          http.get('/clientes/', { params: { [field]: variant, limit: 1 } })
        );
        const results = data.results || data;
        if (!Array.isArray(results) || !results.length) continue;

        const client = results[0];

        // VALIDAR: el cliente devuelto debe tener realmente ese número.
        // WispHub puede ignorar el filtro y devolver el primer cliente de la lista.
        const returnedPhone = String(client[field] || '').replace(/\D/g, '');
        if (returnedPhone === clean || returnedPhone === `51${clean}`) {
          logger.info('WispHub client found by phone', { field, variant });
          return client;
        }
        logger.debug('WispHub phone mismatch - ignorando resultado', {
          field, variant, returned: returnedPhone, expected: clean,
        });
      } catch (err) {
        logger.warn('WispHub phone search failed', { field, variant, error: err.message });
      }
    }
  }
  return null;
};

const buscarClientePorNombre = async (name) => {
  if (!name || name.length < 3) return null;

  const normalize = s => (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim();

  const searchWords = normalize(name).split(/\s+/).filter(w => w.length > 2);
  if (!searchWords.length) return null;

  // Validar que el resultado devuelto realmente contiene palabras de la búsqueda
  const isGoodMatch = (client) => {
    const cn = normalize(client.nombre || client.name || '');
    const cu = normalize(client.usuario || client.username || '');
    return searchWords.some(w => cn.includes(w) || cu.includes(w));
  };

  // Estrategias en orden: nombre completo → primera palabra → campo nombre → usuario
  const strategies = [
    { search: name },
    { search: searchWords[0] },
    { nombre: name },
    { nombre: searchWords[0] },
    { usuario: searchWords[0] },
  ];

  for (const params of strategies) {
    try {
      const { data } = await withRetry(() =>
        http.get('/clientes/', { params: { ...params, limit: 10 } })
      );
      const results = data.results || data;
      if (!Array.isArray(results) || !results.length) continue;

      const match = results.find(isGoodMatch);
      if (match) {
        logger.info('WispHub name search found match', {
          searchName: name, found: match.nombre, strategy: JSON.stringify(params),
        });
        return match;
      }
      logger.debug('WispHub name search returned results but no match passed validation', {
        searchName: name, strategy: JSON.stringify(params), returned: results.map(r => r.nombre),
      });
    } catch (err) {
      logger.warn('WispHub name search strategy failed', { params, error: err.message });
    }
  }

  logger.info('WispHub name search: no match found for any strategy', { name });
  return null;
};

const buscarCliente = async (phone, name = null) => {
  let client = await buscarClientePorTelefono(phone);
  if (!client && name) client = await buscarClientePorNombre(name);
  return client;
};

// ─────────────────────────────────────────────────────────────
// OBTENER TODOS LOS CLIENTES (con paginación)
// ─────────────────────────────────────────────────────────────

const obtenerTodosLosClientes = async ({ soloActivos = true, pageSize = 100 } = {}) => {
  const allClients = [];
  let offset = 0;
  let hasMore = true;

  logger.info('Fetching all WispHub clients...');

  while (hasMore) {
    try {
      const params = { limit: pageSize, offset };
      if (soloActivos) params.activo = true;

      const { data } = await withRetry(() =>
        http.get('/clientes/', { params })
      );

      const results = data.results || data;
      const total = data.count || null;

      if (!Array.isArray(results) || results.length === 0) {
        hasMore = false;
        break;
      }

      allClients.push(...results);
      offset += results.length;

      // Si la API devuelve un total, usarlo para saber si hay más
      if (total && allClients.length >= total) {
        hasMore = false;
      } else if (results.length < pageSize) {
        hasMore = false;
      }

      // Pequeña pausa para no sobrecargar la API
      await new Promise(r => setTimeout(r, 300));
      logger.debug(`WispHub: fetched ${allClients.length} clients so far...`);

    } catch (err) {
      logger.error('Error fetching WispHub clients', { offset, error: err.message });
      hasMore = false;
    }
  }

  logger.info(`WispHub: total clients fetched: ${allClients.length}`);
  return allClients;
};

// ─────────────────────────────────────────────────────────────
// OBTENER CLIENTES CON DEUDA PENDIENTE
// ─────────────────────────────────────────────────────────────

const obtenerClientesConDeuda = async () => {
  try {
    const { data } = await withRetry(() =>
      http.get('/facturas/', {
        params: {
          estado__in: 'pendiente,no pagada,vencida',
          limit: 500,
        }
      })
    );

    const facturas = data.results || data || [];
    logger.info(`WispHub: ${facturas.length} facturas pendientes encontradas`);
    return facturas;
  } catch (err) {
    logger.error('Error fetching pending invoices', { error: err.message });
    // Fallback: obtener todos y filtrar
    try {
      const { data } = await withRetry(() =>
        http.get('/facturas/', { params: { limit: 500 } })
      );
      const facturas = data.results || data || [];
      const pendientes = facturas.filter(f =>
        ['pendiente', 'no pagada', 'vencida', 'Pendiente', 'No Pagada', 'Vencida'].includes(f.estado)
      );
      return pendientes;
    } catch (err2) {
      logger.error('Fallback also failed', { error: err2.message });
      return [];
    }
  }
};

// ─────────────────────────────────────────────────────────────
// DEUDA
// ─────────────────────────────────────────────────────────────

// AUDITORIA CONFIRMADA: La API de WispHub /facturas/ IGNORA todos los query params
// (id_servicio, usuario, estado). Siempre devuelve TODAS las facturas paginadas.
// El cliente real de cada factura está en:
//   f.articulos[0].servicio.id_servicio  → id numérico del servicio
//   f.cliente.usuario                    → username WispHub del cliente
// La estrategia correcta: fetch paginado + filtro client-side por esos campos.
//
// planPrice: precio mensual desde DB local (fuente de verdad para monto_mensual)
// clientUsuario: username WispHub (ej: "mfiber101312@fiber-fix-sac")
const consultarDeuda = async (clienteId, planPrice = null, clientUsuario = null) => {

  const estadosPendientes = new Set([
    'pendiente', 'no pagada', 'no pagado', 'vencida', 'vencido',
    'Pendiente', 'No Pagada', 'No Pagado', 'Vencida', 'Vencido',
    'pendiente de pago', 'Pendiente de Pago', 'PENDIENTE DE PAGO',
    'por pagar', 'Por Pagar', 'impago', 'Impago', 'mora', 'Mora',
    'sin pagar', 'Sin Pagar', 'atrasado', 'Atrasado',
  ]);

  // Helper: extraer id_servicio real de una factura según la estructura de WispHub
  const getFacturaServicioId = (f) => {
    // Nuevo: articulos[0].servicio.id_servicio (confirmado en auditoría)
    const arts = f.articulos || [];
    if (arts.length > 0 && arts[0].servicio?.id_servicio) {
      return String(arts[0].servicio.id_servicio);
    }
    // Fallback: campos clásicos que podrían existir en versiones futuras de WispHub
    return String(f.id_servicio || f.cliente?.id_servicio || '');
  };

  // Helper: extraer usuario de una factura
  const getFacturaUsuario = (f) => f.cliente?.usuario || f.usuario || '';

  // Helper: ¿pertenece esta factura al cliente buscado?
  const esDeEsteCliente = (f) => {
    const fServicioId = getFacturaServicioId(f);
    const fUsuario    = getFacturaUsuario(f);
    if (fServicioId && fServicioId === String(clienteId)) return true;
    if (clientUsuario && fUsuario && fUsuario === clientUsuario)  return true;
    return false;
  };

  try {
    // ─── Si planPrice es conocido: buscar la factura correcta en las páginas recientes ──
    // Las facturas se devuelven ordenadas por ID DESC (más recientes primero).
    // Cada cliente tiene ~1 factura por mes, así que con 3 páginas (~300 facturas)
    // cubrimos los clientes más recientes. Si no encontramos, usamos planPrice directo.
    let facturaEncontrada = null;
    const MAX_PAGES = 5;

    for (let page = 0; page < MAX_PAGES && !facturaEncontrada; page++) {
      try {
        const { data } = await withRetry(() =>
          http.get('/facturas/', { params: { limit: 100, offset: page * 100 } })
        );
        const rows = data.results || (Array.isArray(data) ? data : []);
        if (!rows.length) break;

        // Filtrar facturas de este cliente con estado pendiente
        const delCliente = rows.filter(f => esDeEsteCliente(f));
        const pendientesDelCliente = delCliente.filter(f => {
          const estado = (f.estado || '').toString();
          return estadosPendientes.has(estado) || estadosPendientes.has(estado.toLowerCase());
        });

        if (pendientesDelCliente.length > 0) {
          // Si planPrice conocido: preferir la factura cuyo monto coincida
          if (planPrice && planPrice > 0) {
            facturaEncontrada = pendientesDelCliente.find(f => {
              const m = parseFloat(f.total || f.sub_total || 0);
              return Math.abs(m - planPrice) <= 0.51;
            }) || pendientesDelCliente[0];
          } else {
            facturaEncontrada = pendientesDelCliente[0];
          }
          logger.info('WispHub: factura pendiente encontrada (filtro client-side)', {
            clienteId, clientUsuario, page,
            facturaId: facturaEncontrada.id_factura,
            monto: parseFloat(facturaEncontrada.total || 0),
          });
          break;
        }

        // Si las facturas de este cliente en esta página ya están todas pagadas,
        // pueden estar en páginas anteriores — pero si ya las hay pagadas, el cliente
        // probablemente no tiene pendientes. Dejar que el bucle continúe igual.
        if (delCliente.length > 0 && pendientesDelCliente.length === 0) {
          logger.info('WispHub: cliente encontrado en facturas pero sin pendientes', {
            clienteId, page, estadosEncontrados: [...new Set(delCliente.map(f => f.estado))],
          });
          // No rompemos — podría haber más páginas con facturas pendientes de meses anteriores
        }

      } catch (err) {
        logger.warn('WispHub: error en página de facturas', { page, error: err.message });
        break;
      }
    }

    // ─── Si no se encontró factura pero planPrice es conocido ─────────────────
    // Retornar planPrice como cuota — el bot podrá validar el monto del voucher.
    // factura_id=null significa que el registro en WispHub se omite (solo DB local).
    if (!facturaEncontrada && planPrice && planPrice > 0) {
      logger.warn('WispHub: no se encontró factura pendiente del cliente — usando plan_price', {
        clienteId, clientUsuario, planPrice,
      });
      return {
        tiene_deuda:       true,
        monto_deuda:       planPrice,
        monto_mensual:     planPrice,
        cantidad_facturas: 0,
        factura_id:        null,
        facturas:          [],
      };
    }

    // ─── Si no hay factura ni planPrice ──────────────────────────────────────
    if (!facturaEncontrada) {
      logger.warn('WispHub: sin factura pendiente ni plan_price para el cliente', { clienteId, clientUsuario });
      return {
        tiene_deuda:       false,
        monto_deuda:       0,
        monto_mensual:     0,
        cantidad_facturas: 0,
        factura_id:        null,
        facturas:          [],
      };
    }

    const montoFactura = parseFloat(facturaEncontrada.total || facturaEncontrada.sub_total || 0);

    // monto_mensual = precio de 1 mes. Si la factura parece acumulada (>10% mayor al plan),
    // usar planPrice para que el bot siempre muestre la cuota correcta.
    let montoMensual = montoFactura;
    if (planPrice && planPrice > 0 && montoFactura > planPrice * 1.1) {
      logger.warn('WispHub: monto factura parece acumulado — usando plan_price como cuota mensual', {
        clienteId, montoFactura, planPrice, ratio: (montoFactura / planPrice).toFixed(2),
      });
      montoMensual = planPrice;
    }

    logger.info('WispHub deuda resultado final', {
      clienteId, montoFactura, montoMensual,
      facturaId: facturaEncontrada.id_factura,
    });

    return {
      tiene_deuda:       true,
      monto_deuda:       montoFactura,
      monto_mensual:     montoMensual,
      cantidad_facturas: 1,
      factura_id:        facturaEncontrada.id_factura || facturaEncontrada.id || null,
      facturas:          [facturaEncontrada],
    };

  } catch (err) {
    logger.error('WispHub deuda query failed', { clienteId, error: err.message });
    // Si planPrice conocido, devolver sin lanzar excepción — el bot puede funcionar
    if (planPrice && planPrice > 0) {
      return {
        tiene_deuda:       true,
        monto_deuda:       planPrice,
        monto_mensual:     planPrice,
        cantidad_facturas: 0,
        factura_id:        null,
        facturas:          [],
      };
    }
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────
// REGISTRAR PAGO
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// FORMA_PAGO: auto-descubrimiento + caché en memoria
// ─────────────────────────────────────────────────────────────

// Cache de formas de pago disponibles en WispHub (id → nombre)
let _formasPagoCache = null;

// Palabras clave para detectar el ID correcto por nombre
// Prioriza "FIBER FIX" sobre nombres personales cuando existan ambos
const _KEYWORDS = {
  yape:       ['yape fiber', 'yape fix', 'yape s.a', 'yape'],
  plin:       ['plin fiber', 'plin fix', 'plin s.a', 'plin'],
  bcp:        ['bcp', 'banco de credito'],
  interbank:  ['interbank', 'ibk'],
  bbva:       ['bbva'],
  scotiabank: ['scotiabank', 'scotia'],
  efectivo:   ['efectivo', 'cash'],
  transfer:   ['transferencia bancaria fiber', 'transferencia bancaria fix', 'transferencia bancaria s.a', 'transferencia', 'transfer'],
  deposito:   ['deposito fiber', 'deposito fix', 'deposito s.a', 'deposito', 'depósito'],
};

const _obtenerFormasPago = async () => {
  if (_formasPagoCache) return _formasPagoCache;

  // Intentar varios endpoints posibles en WispHub
  const endpoints = ['/formas-de-pago/', '/formas-pago/', '/forma-pago/', '/tipos-pago/', '/metodos-pago/', '/formas_pago/'];
  for (const ep of endpoints) {
    try {
      const { data } = await http.get(ep, { params: { limit: 100 } });
      const items = data.results || data || [];
      if (!Array.isArray(items) || items.length === 0) continue;
      logger.info(`WispHub formas de pago encontradas en ${ep}:`, items.map(i => ({ id: i.id, nombre: i.nombre || i.name || i.descripcion })));
      _formasPagoCache = items;
      return items;
    } catch { /* probar siguiente endpoint */ }
  }
  logger.warn('WispHub: no se pudo obtener lista de formas de pago - usando env vars o fallback');
  return [];
};

const _resolverFormaPago = async (metodo) => {
  // 1. Env vars tienen prioridad absoluta
  const envMap = {
    efectivo:   process.env.WISPHUB_FORMA_PAGO_EFECTIVO,
    yape:       process.env.WISPHUB_FORMA_PAGO_YAPE,
    plin:       process.env.WISPHUB_FORMA_PAGO_PLIN,
    bcp:        process.env.WISPHUB_FORMA_PAGO_BCP,
    interbank:  process.env.WISPHUB_FORMA_PAGO_INTERBANK,
    bbva:       process.env.WISPHUB_FORMA_PAGO_BBVA,
    scotiabank: process.env.WISPHUB_FORMA_PAGO_SCOTIABANK,
    transfer:   process.env.WISPHUB_FORMA_PAGO_TRANSFER,
  };
  if (envMap[metodo]) return parseInt(envMap[metodo]);

  // 2. Auto-descubrimiento por nombre
  const formas = await _obtenerFormasPago();
  if (formas.length > 0) {
    const keywords = _KEYWORDS[metodo] || [metodo];
    for (const forma of formas) {
      const nombre = (forma.nombre || forma.name || forma.descripcion || '').toLowerCase();
      if (keywords.some(kw => nombre.includes(kw))) {
        logger.info(`WispHub: forma_pago detectada automáticamente`, { metodo, formaPagoId: forma.id, nombre });
        return forma.id;
      }
    }
    // No encontró coincidencia → usar el primer ID disponible como fallback
    logger.warn(`WispHub: no se encontró forma_pago para "${metodo}", usando primer ID disponible: ${formas[0].id} (${formas[0].nombre || formas[0].name})`);
    return formas[0].id;
  }

  // 3. Último fallback (probablemente fallará, pero se loguea claro)
  logger.error(`WispHub: FORMA_PAGO desconocida para "${metodo}". Configura WISPHUB_FORMA_PAGO_${metodo.toUpperCase()} en .env`);
  return null;
};

// POST /facturas/{id_factura}/registrar-pago/
// clienteId = id_servicio del cliente en WispHub
// El endpoint necesita el ID de la FACTURA (id_factura), no el id_servicio del cliente.
const registrarPago = async (clienteId, paymentData) => {
  const pad = (n) => String(n).padStart(2, '0');

  // Fecha del pago
  let fechaPago;
  if (paymentData.paymentDate) {
    const d = new Date(paymentData.paymentDate);
    d.setMinutes(d.getMinutes() + d.getTimezoneOffset());
    fechaPago = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00`;
  } else {
    const now = new Date();
    fechaPago = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  const metodo = (paymentData.method || '').toLowerCase();
  const formaPago = await _resolverFormaPago(metodo);

  if (!formaPago) {
    throw new Error(`No se encontró forma_pago válida para método "${metodo}". Configura WISPHUB_FORMA_PAGO_${metodo.toUpperCase()} en backend/.env`);
  }

  // Si el caller ya conoce el id_factura (de consultarDeuda), usarlo directamente.
  // Esto evita un segundo lookup que puede traer facturas de otros clientes.
  let facturaId = paymentData.facturaId || null;

  if (!facturaId) {
    // Fallback: buscar factura usando el monto y usuario del cliente para identificar la factura correcta
    const fallbackPlanPrice = paymentData.amount ? parseFloat(paymentData.amount) : null;
    const fallbackUsuario   = paymentData.clientUsuario || null;
    try {
      const debtInfo = await consultarDeuda(clienteId, fallbackPlanPrice, fallbackUsuario);
      if (debtInfo.factura_id) {
        facturaId = debtInfo.factura_id;
        logger.info('WispHub: factura pendiente obtenida via consultarDeuda', { clienteId, facturaId });
      }
    } catch (err) {
      logger.warn('WispHub: error buscando factura via consultarDeuda', { clienteId, error: err.message });
    }
  }

  if (!facturaId) {
    throw new Error(`No se encontró factura pendiente para cliente WispHub ${clienteId}`);
  }

  const body = {
    total_cobrado: paymentData.amount,
    forma_pago: formaPago,
    accion: 1,
    fecha_pago: fechaPago,
    descripcion: `Pago vía WhatsApp - ${paymentData.method?.toUpperCase() || 'Bot FiberPeru'}`,
    referencia: paymentData.operationCode || '',
  };

  logger.info('WispHub: registrando pago', { clienteId, facturaId, monto: body.total_cobrado, fecha: fechaPago, metodo, formaPago });
  const { data } = await http.post(`/facturas/${facturaId}/registrar-pago/`, body);
  logger.info('WispHub: pago registrado exitosamente', { clienteId, facturaId, monto: body.total_cobrado });
  return data;
};

// marcarFacturaPagada ya no es necesaria — registrarPago marca la factura como pagada automáticamente
const marcarFacturaPagada = async (facturaId, paymentData = {}) => {
  // El endpoint /facturas/{id_servicio}/registrar-pago/ ya actualiza el estado de la factura.
  // Esta función queda como stub para compatibilidad.
  return null;
};

// ─────────────────────────────────────────────────────────────
// CORTE DE SERVICIO (día 10)
// ─────────────────────────────────────────────────────────────

const cortarServicio = async (clienteId, razon = 'Falta de pago') => {
  // WispHub endpoint para suspender servicio
  // Intenta múltiples endpoints posibles
  const endpoints = [
    { method: 'patch', url: `/servicios/${clienteId}/`, body: { estado: 'cortado', razon_corte: razon } },
    { method: 'patch', url: `/clientes/${clienteId}/`, body: { estado: 'suspendido', observacion: razon } },
    { method: 'post',  url: `/servicios/${clienteId}/cortar/`, body: { razon } },
    { method: 'post',  url: `/clientes/${clienteId}/suspender/`, body: { razon } },
  ];

  for (const endpoint of endpoints) {
    try {
      const { data } = await withRetry(async () => {
        if (endpoint.method === 'patch') {
          return http.patch(endpoint.url, endpoint.body);
        }
        return http.post(endpoint.url, endpoint.body);
      });
      logger.info('Service cut successfully', { clienteId, endpoint: endpoint.url });
      return { success: true, data };
    } catch (err) {
      if (err.response?.status === 404) {
        logger.warn(`WispHub cut endpoint not found: ${endpoint.url}`);
        continue; // Prueba el siguiente
      }
      throw err;
    }
  }

  // Si ningún endpoint funciona, log para revisión manual
  logger.error('Could not cut service via API - manual intervention required', { clienteId });
  return { success: false, requiresManualCut: true, clienteId };
};

// ─────────────────────────────────────────────────────────────
// OBTENER TELÉFONO DEL CLIENTE
// ─────────────────────────────────────────────────────────────

const obtenerTelefonoCliente = (cliente) => {
  const phone = cliente.celular || cliente.movil || cliente.telefono || null;
  if (!phone) return null;
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length === 9) return `51${clean}`;
  if (clean.length === 12 && clean.startsWith('051')) return `51${clean.slice(3)}`;
  if (clean.length === 11 && clean.startsWith('51')) return clean;
  return clean;
};

// ─────────────────────────────────────────────────────────────
// SINCRONIZAR PLANES DE WISPHUB → DB local
// ─────────────────────────────────────────────────────────────

const sincronizarPlanes = async (db) => {
  logger.info('[WISPHUB] Sincronizando planes...');
  const endpoints = ['/planes/', '/planes-servicio/', '/plan-servicio/', '/tipos-plan/', '/planes-internet/'];
  let planes = [];

  for (const ep of endpoints) {
    try {
      const { data } = await withRetry(() => http.get(ep, { params: { limit: 200 } }));
      const results = data.results || data || [];
      if (Array.isArray(results) && results.length > 0) {
        planes = results;
        logger.info(`[WISPHUB] Planes obtenidos desde ${ep}: ${planes.length}`);
        break;
      }
    } catch { /* prueba siguiente endpoint */ }
  }

  if (planes.length === 0) {
    logger.warn('[WISPHUB] No se encontraron planes en WispHub');
    return { total: 0, created: 0, updated: 0 };
  }

  let created = 0;
  let updated = 0;

  for (const plan of planes) {
    try {
      const planId = String(plan.id || plan.id_plan || '');
      if (!planId) continue;
      const nombre = plan.nombre || plan.name || plan.descripcion || 'Sin nombre';
      const precio = parseFloat(plan.precio || plan.costo || plan.monto || plan.precio_mensual || 0);
      const bajada = plan.velocidad_bajada || plan.bajada || plan.download || null;
      const subida = plan.velocidad_subida || plan.subida || plan.upload || null;
      const activo = plan.activo !== false && plan.activo !== 0 && plan.activo !== '0';

      const result = await db.query(
        `INSERT INTO wisphub_plans (wisphub_plan_id, nombre, precio, velocidad_bajada, velocidad_subida, activo, wisphub_raw, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (wisphub_plan_id) DO UPDATE SET
           nombre           = EXCLUDED.nombre,
           precio           = EXCLUDED.precio,
           velocidad_bajada = EXCLUDED.velocidad_bajada,
           velocidad_subida = EXCLUDED.velocidad_subida,
           activo           = EXCLUDED.activo,
           wisphub_raw      = EXCLUDED.wisphub_raw,
           last_synced_at   = NOW(),
           updated_at       = NOW()
         RETURNING id, (xmax = 0) AS is_new`,
        [planId, nombre, precio, bajada, subida, activo, JSON.stringify(plan)]
      );

      if (result.rows[0]?.is_new) created++;
      else updated++;
    } catch (err) {
      logger.warn('[WISPHUB] Error UPSERT plan', { error: err.message });
    }
  }

  logger.info(`[WISPHUB] Planes sync: ${planes.length} total, ${created} nuevos, ${updated} actualizados`);
  return { total: planes.length, created, updated };
};

// ─────────────────────────────────────────────────────────────
// SINCRONIZAR CONTACTOS → DB local (UPSERT enriquecido)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Determinar estado de servicio desde objeto WispHub
// WispHub puede devolver: campo 'estado', 'activo' (bool/int/string), o ninguno.
// Por defecto asumimos 'activo' — solo marcamos 'cortado' si hay evidencia explícita.
// ─────────────────────────────────────────────────────────────
const _resolverEstadoServicio = (cliente) => {
  // 1. Campo 'estado' o 'status' explícito (más confiable)
  const estado = String(cliente.estado || cliente.status || '').toLowerCase().trim();
  if (estado && estado !== 'activo' && estado !== 'active') {
    const cortados = ['cortado', 'suspendido', 'inactivo', 'retirado', 'baja', 'desactivado', 'inactive', 'suspended', 'cancelled'];
    if (cortados.some(s => estado.includes(s))) return 'cortado';
  }
  if (estado === 'activo' || estado === 'active') return 'activo';

  // 2. Campo 'activo' explícitamente falso
  const activo = cliente.activo;
  if (activo === false || activo === 0 || activo === '0' || activo === 'false' ||
      activo === 'No' || activo === 'no' || activo === 'N') {
    return 'cortado';
  }

  // 3. Si activo es explícitamente true/1/"1"/"Si", es activo
  if (activo === true || activo === 1 || activo === '1' || activo === 'true' ||
      activo === 'Si' || activo === 'si' || activo === 'S') {
    return 'activo';
  }

  // 4. Default: asumir activo (WispHub puede omitir el campo en la respuesta)
  return 'activo';
};

const sincronizarContactos = async (db) => {
  logger.info('[WISPHUB] Iniciando sincronización completa de contactos...');

  // Precargar mapa de planes desde DB local para lookup de precios más confiable
  const plansMap = {}; // { wisphub_plan_id: precio }
  try {
    const plansResult = await db.query('SELECT wisphub_plan_id, precio FROM wisphub_plans WHERE activo = true');
    for (const row of plansResult.rows) {
      if (row.wisphub_plan_id) plansMap[row.wisphub_plan_id] = parseFloat(row.precio) || null;
    }
    if (Object.keys(plansMap).length > 0) {
      logger.info(`[WISPHUB] ${Object.keys(plansMap).length} planes precargados para lookup de precios`);
    }
  } catch { /* tabla wisphub_plans puede no existir aún */ }

  const clientes = await obtenerTodosLosClientes({ soloActivos: false });

  // Loguear estructura del primer cliente para diagnóstico
  if (clientes.length > 0) {
    const sample = clientes[0];
    logger.info('[WISPHUB] Estructura de muestra (primer cliente):', {
      keys: Object.keys(sample),
      activo: sample.activo,
      estado: sample.estado,
      status: sample.status,
      id_servicio: sample.id_servicio,
    });
  }

  let created = 0;
  let updated = 0;
  let errors  = 0;

  for (const cliente of clientes) {
    try {
      const wisphubId = String(cliente.id_servicio || cliente.id || '');
      if (!wisphubId) { errors++; continue; }

      const phone          = obtenerTelefonoCliente(cliente) || '';
      const name           = cliente.nombre || cliente.nombre_completo || 'N/A';
      const email          = cliente.correo  || cliente.email || null;
      const serviceId      = wisphubId;
      const plan           = cliente.plan || cliente.plan_nombre || null;
      const address        = cliente.direccion || null;
      const serviceStatus  = _resolverEstadoServicio(cliente);
      const tags           = Array.isArray(cliente.etiquetas) ? cliente.etiquetas : [];
      const fechaRegistro  = cliente.fecha_registro || null;
      const wisphubRaw     = JSON.stringify(cliente);
      const nodo           = cliente.nodo || cliente.nombre_nodo || cliente.punto_acceso || null;
      const wisphubPlanId  = String(cliente.id_plan || cliente.plan_id || cliente.id_plan_servicio || '') || null;

      // Precio: desde tabla de planes sincronizados (más confiable) o desde campos del cliente
      let planPrice = wisphubPlanId && plansMap[wisphubPlanId] ? plansMap[wisphubPlanId] : null;
      if (!planPrice) {
        planPrice = parseFloat(
          cliente.precio_plan || cliente.monto_plan || cliente.costo_plan ||
          cliente.precio || cliente.costo || cliente.valor || cliente.monto ||
          cliente.precio_mensual || 0
        ) || null;
      }

      const result = await db.query(
        `INSERT INTO clients
           (wisphub_id, phone, name, email, service_id, plan, address,
            service_status, tags, plan_price, fecha_registro, wisphub_raw,
            wisphub_plan_id, nodo, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (wisphub_id) DO UPDATE SET
           phone           = EXCLUDED.phone,
           name            = EXCLUDED.name,
           email           = EXCLUDED.email,
           plan            = EXCLUDED.plan,
           address         = EXCLUDED.address,
           service_status  = EXCLUDED.service_status,
           tags            = EXCLUDED.tags,
           plan_price      = CASE WHEN EXCLUDED.plan_price IS NOT NULL THEN EXCLUDED.plan_price ELSE clients.plan_price END,
           wisphub_raw     = EXCLUDED.wisphub_raw,
           wisphub_plan_id = COALESCE(EXCLUDED.wisphub_plan_id, clients.wisphub_plan_id),
           nodo            = COALESCE(EXCLUDED.nodo, clients.nodo),
           last_synced_at  = NOW(),
           updated_at      = NOW()
         RETURNING id, (xmax = 0) AS is_new`,
        [wisphubId, phone, name, email, serviceId, plan, address,
         serviceStatus, tags, planPrice, fechaRegistro, wisphubRaw,
         wisphubPlanId, nodo]
      );

      if (result.rows[0]?.is_new) created++;
      else updated++;

    } catch (err) {
      errors++;
      logger.warn('[WISPHUB] Error UPSERT cliente', { error: err.message });
    }
  }

  // ── RETROVINCULACIÓN: Vincular conversaciones existentes sin client_id
  // Esto asegura que chats históricos (creados antes del sync) también muestren nombre real
  let linked = 0;
  try {
    // Actualizar display_name y client_id para TODAS las conversaciones con match de teléfono en WispHub
    // (no solo las sin client_id) para que siempre se vea el nombre real de WispHub
    const retroResult = await db.query(`
      UPDATE conversations conv
      SET
        client_id    = cl.id,
        display_name = cl.name,
        bot_intent   = 'identity_ok'
      FROM clients cl
      WHERE cl.wisphub_id IS NOT NULL
        AND cl.phone != ''
        AND cl.name != 'N/A'
        AND (
          cl.phone = conv.phone
          OR (conv.phone LIKE '51%' AND cl.phone = SUBSTRING(conv.phone FROM 3))
          OR (cl.phone LIKE '51%' AND conv.phone = SUBSTRING(cl.phone FROM 3))
          OR cl.phone = REGEXP_REPLACE(conv.phone, '[^0-9]', '', 'g')
        )
    `);
    linked = retroResult.rowCount || 0;
    if (linked > 0) {
      logger.info(`[WISPHUB] Retrovinculadas ${linked} conversaciones con nombre de cliente WispHub`);
    }
  } catch (err) {
    logger.warn('[WISPHUB] Error en retrovinculación de conversaciones', { error: err.message });
  }

  logger.info(`[WISPHUB] Sync completo: ${clientes.length} total, ${created} nuevos, ${updated} actualizados, ${errors} errores, ${linked} conversaciones retrovinculadas`);
  return { total: clientes.length, created, updated, errors, linked };
};

// ─────────────────────────────────────────────────────────────
// BUSCAR FACTURAS PAGADAS DE UN CLIENTE (para reconciliación)
// ─────────────────────────────────────────────────────────────
// Devuelve facturas con estado "Pagada" para el usuario WispHub dado.
// Si clientUsuario es null, intenta por id_servicio.
const buscarFacturasPagadas = async (clienteId, clientUsuario = null) => {
  const estadosPagados = new Set([
    'Pagada', 'pagada', 'PAGADA', 'Pagado', 'pagado', 'PAGADO',
    'Cobrada', 'cobrada', 'Cobrado', 'cobrado',
    'Completada', 'completada', 'Completado', 'completado',
  ]);

  try {
    let facturas = [];

    // Estrategia 1: filtrar por usuario + estado Pagada
    if (clientUsuario) {
      try {
        const { data } = await withRetry(() =>
          http.get('/facturas/', { params: { usuario: clientUsuario, estado: 'Pagada', limit: 100 } })
        );
        const rows = data.results || data || [];
        if (Array.isArray(rows) && rows.length > 0) {
          facturas = rows.filter(f => estadosPagados.has(f.estado || ''));
          logger.info('WispHub facturas pagadas por usuario', { clienteId, clientUsuario, count: facturas.length });
        }
      } catch { /* continúa */ }
    }

    // Estrategia 2: filtrar por id_servicio + estado
    if (facturas.length === 0) {
      try {
        const { data } = await withRetry(() =>
          http.get('/facturas/', { params: { id_servicio: clienteId, estado: 'Pagada', limit: 100 } })
        );
        const rows = data.results || data || [];
        if (Array.isArray(rows) && rows.length > 0) {
          facturas = rows.filter(f => estadosPagados.has(f.estado || ''));
        }
      } catch { /* continúa */ }
    }

    // Estrategia 3: traer todas y filtrar localmente por usuario
    if (facturas.length === 0 && clientUsuario) {
      try {
        const { data } = await withRetry(() =>
          http.get('/facturas/', { params: { usuario: clientUsuario, limit: 100 } })
        );
        const rows = data.results || data || [];
        facturas = rows.filter(f => estadosPagados.has(f.estado || ''));
      } catch { /* continúa */ }
    }

    return facturas;
  } catch (err) {
    logger.warn('WispHub buscarFacturasPagadas error', { clienteId, error: err.message });
    return [];
  }
};

module.exports = {
  buscarCliente,
  buscarClientePorTelefono,
  buscarClientePorNombre,
  obtenerTodosLosClientes,
  obtenerClientesConDeuda,
  consultarDeuda,
  registrarPago,
  marcarFacturaPagada,
  cortarServicio,
  obtenerTelefonoCliente,
  sincronizarPlanes,
  sincronizarContactos,
  buscarFacturasPagadas,
  obtenerFormasPago: _obtenerFormasPago,
};
