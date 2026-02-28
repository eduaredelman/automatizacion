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

// consultarDeuda acepta opts.usuario y opts.nombre para validar que las facturas
// pertenecen al cliente correcto (WispHub a veces retorna facturas de otro cliente)
const consultarDeuda = async (clienteId, opts = {}) => {
  const { usuario: clienteUsuario = null, nombre: clienteNombre = null } = opts;

  // Todas las variantes posibles de estado pendiente en WispHub
  const estadosPendientes = new Set([
    'pendiente', 'no pagada', 'no pagado', 'vencida', 'vencido',
    'Pendiente', 'No Pagada', 'No Pagado', 'Vencida', 'Vencido',
    'pendiente de pago', 'Pendiente de Pago', 'PENDIENTE DE PAGO',
    'por pagar', 'Por Pagar', 'POR PAGAR',
    'impago', 'impaga', 'mora', 'atrasado', 'atrasada',
    'Impago', 'Impaga', 'Mora', 'Atrasado', 'Atrasada',
    'sin pagar', 'Sin Pagar',
  ]);

  try {
    let pendientes = [];

    const statusFilters = [
      'Pendiente', 'pendiente',
      'Pendiente de Pago', 'pendiente de pago',
      'Vencida', 'vencida',
      'No Pagada', 'no pagada',
      'Por Pagar',
    ];
    for (const estado of statusFilters) {
      try {
        const { data } = await withRetry(() =>
          http.get('/facturas/', { params: { id_servicio: clienteId, estado, limit: 20 } })
        );
        const rows = data.results || data || [];
        if (Array.isArray(rows) && rows.length > 0) {
          pendientes.push(...rows);
          logger.info(`WispHub facturas por estado "${estado}"`, { clienteId, count: rows.length });
        }
      } catch { /* continúa con el siguiente estado */ }
    }

    // Deduplicar por id
    const seen = new Set();
    pendientes = pendientes.filter(f => {
      const id = f.id_factura || f.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // ─── VALIDAR que las facturas pertenecen al cliente correcto ─────────────
    // WispHub a veces ignora el filtro y devuelve facturas de OTRO cliente.
    // Validamos contra el usuario o nombre del cliente real.
    if ((clienteUsuario || clienteNombre) && pendientes.length > 0) {
      const normalize = s => (s || '').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').trim();

      const clienteUsuarioNorm = normalize(clienteUsuario);
      const clienteNombreNorm  = normalize(clienteNombre);

      const pendientesValidados = pendientes.filter(f => {
        const facUsuario = f.cliente?.usuario || '';
        const facNombre  = normalize(f.cliente?.nombre || '');
        const facUsuarioNorm = normalize(facUsuario);

        // Aceptar si usuario o nombre del cliente en la factura coincide
        if (clienteUsuario && facUsuarioNorm && facUsuarioNorm === clienteUsuarioNorm) return true;
        if (clienteNombre  && facNombre   && facNombre.includes(clienteNombreNorm.split(' ')[0])) return true;
        return false;
      });

      if (pendientesValidados.length > 0) {
        logger.info('WispHub facturas validadas por cliente', {
          clienteId,
          original: pendientes.length,
          validadas: pendientesValidados.length,
        });
        pendientes = pendientesValidados;
      } else {
        // Si ninguna pasó la validación, es señal de que WispHub devolvió facturas de otro cliente
        logger.warn('WispHub facturas descartadas: ninguna coincide con el cliente', {
          clienteId, clienteUsuario, clienteNombre,
          facturasRetornadas: pendientes.slice(0, 3).map(f => ({
            id: f.id_factura, usuario: f.cliente?.usuario, nombre: f.cliente?.nombre,
          })),
        });
        pendientes = []; // Sin facturas válidas para este cliente
      }
    }

    // Si no encontró nada con filtro de estado, traer todas y filtrar localmente
    if (pendientes.length === 0) {
      const { data } = await withRetry(() =>
        http.get('/facturas/', { params: { id_servicio: clienteId, limit: 100 } })
      );
      const facturas = data.results || data || [];
      logger.info('WispHub facturas (sin filtro)', {
        clienteId,
        total: facturas.length,
        estados: [...new Set(facturas.map(f => f.estado || f.status))],
      });

      pendientes = facturas.filter(f => {
        const estado = (f.estado || f.status || '').toString();
        return estadosPendientes.has(estado) || estadosPendientes.has(estado.toLowerCase());
      });
    }

    const montoTotal = pendientes.reduce((s, f) =>
      s + parseFloat(f.total || f.sub_total || f.monto || f.monto_total || 0), 0);

    // Monto mensual = total de la primera factura válida (precio de una cuota)
    const montoPrimera = parseFloat(
      pendientes[0]?.total || pendientes[0]?.sub_total || pendientes[0]?.monto || 0
    );

    // Períodos de las primeras 5 facturas (fecha_vencimiento como referencia)
    const periodos = pendientes.slice(0, 5).map(f => {
      if (f.fecha_vencimiento) return f.fecha_vencimiento;
      if (f.fecha_emision)    return f.fecha_emision;
      return null;
    }).filter(Boolean);

    logger.info('WispHub deuda resultado', {
      clienteId,
      pendientes: pendientes.length,
      monto: montoTotal,
      monto_mensual: montoPrimera,
      periodos,
    });

    return {
      tiene_deuda: pendientes.length > 0,
      monto_deuda: parseFloat(montoTotal.toFixed(2)),
      monto_mensual: parseFloat(montoPrimera.toFixed(2)),
      cantidad_facturas: pendientes.length,
      periodos,
      factura_id: pendientes[0]?.id_factura || pendientes[0]?.id || null,
      facturas: pendientes,
    };
  } catch (err) {
    logger.error('WispHub deuda query failed', { clienteId, error: err.message });
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────
// REGISTRAR PAGO
// ─────────────────────────────────────────────────────────────

const registrarPago = async (clienteId, paymentData) => {
  const { data } = await withRetry(() =>
    http.post('/pagos/', {
      id_servicio: clienteId,
      monto: paymentData.amount,
      fecha_pago: paymentData.date,
      medio_pago: paymentData.method,
      codigo_operacion: paymentData.operationCode,
      observacion: `Pago automático vía WhatsApp - ${paymentData.method} - Bot FiberPeru`,
    })
  );
  logger.info('Payment registered in WispHub', { clienteId });
  return data;
};

const marcarFacturaPagada = async (facturaId) => {
  const { data } = await withRetry(() =>
    http.patch(`/facturas/${facturaId}/`, { estado: 'Pagada' })
  );
  logger.info('Invoice marked as paid', { facturaId });
  return data;
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
  const phone = cliente.celular || cliente.telefono || null;
  if (!phone) return null;
  // Normalizar para WhatsApp (agregar 51 si es número peruano de 9 dígitos)
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length === 9) return `51${clean}`;
  if (clean.length === 11 && clean.startsWith('51')) return clean;
  return clean;
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
};
