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

// consultarDeuda acepta opts.usuario y opts.nombre para validar que las facturas
// pertenecen al cliente correcto (WispHub a veces retorna facturas de otro cliente)
const consultarDeuda = async (clienteId, opts = {}) => {
  const { usuario: clienteUsuario = null, nombre: clienteNombre = null } = opts;

  // Normalizar texto: quitar acentos, minúsculas, trim
  const normalize = s => (s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').trim();

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

    // ─── VALIDAR que las facturas pertenecen al cliente correcto ─────────────
    // CRÍTICO: se aplica SIEMPRE (después del fallback también).
    // WispHub ignora el filtro id_servicio y devuelve facturas de otro cliente.
    // La pantalla WispHub confirma: cada factura tiene cliente.id_servicio propio.
    // Ej: factura 5112 → id_servicio=1940 (Eduardo Marin), factura 5088 → id_servicio=1969 (Eduardo Huarancca)
    if (pendientes.length > 0 && (clienteUsuario || clienteNombre)) {
      const pendientesValidados = pendientes.filter(f => {
        // 1. id_servicio del cliente en la factura (campo más confiable y específico)
        const facServiceId = String(f.cliente?.id_servicio || f.id_servicio || '');
        if (facServiceId) {
          const match = facServiceId === String(clienteId);
          if (!match) return false; // id_servicio diferente → rechazar definitivamente
          return true;
        }

        // 2. Coincidencia exacta de usuario WispHub (único por cliente)
        if (clienteUsuario) {
          const facUsuario = normalize(f.cliente?.usuario || '');
          if (facUsuario && facUsuario === normalize(clienteUsuario)) return true;
        }

        // 3. Coincidencia de nombre (≥2 palabras para evitar falsos positivos entre
        //    clientes que comparten nombre de pila, ej: dos "Eduardo" distintos)
        if (clienteNombre) {
          const facNombre = normalize(f.cliente?.nombre || '');
          if (facNombre) {
            const words = normalize(clienteNombre).split(/\s+/).filter(w => w.length > 2);
            const matchCount = words.filter(w => facNombre.includes(w)).length;
            if (matchCount >= 2) return true;
          }
        }

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
        // Ninguna pasó la validación → WispHub devolvió facturas de otro cliente
        logger.warn('WispHub facturas descartadas (pertenecen a otro cliente)', {
          clienteId, clienteUsuario, clienteNombre,
          facturasRetornadas: pendientes.slice(0, 3).map(f => ({
            facturaId: f.id_factura || f.id,
            clienteServiceId: f.cliente?.id_servicio,
            clienteNombre: f.cliente?.nombre,
          })),
        });
        pendientes = [];
      }
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

  // Buscar la factura pendiente del cliente para obtener su id_factura
  const estadosPendientes = new Set([
    'pendiente', 'Pendiente', 'pendiente de pago', 'Pendiente de Pago',
    'no pagada', 'No Pagada', 'vencida', 'Vencida', 'por pagar', 'Por Pagar',
  ]);

  let facturaId = null;
  try {
    const { data: facturasData } = await http.get('/facturas/', {
      params: { id_servicio: clienteId, limit: 50 }
    });
    const facturas = facturasData.results || facturasData || [];
    const pendiente = facturas.find(f => estadosPendientes.has(f.estado || f.status || ''));
    if (pendiente) {
      facturaId = pendiente.id_factura || pendiente.id;
      logger.info('WispHub: factura pendiente encontrada', { clienteId, facturaId, estado: pendiente.estado });
    }
  } catch (err) {
    logger.warn('WispHub: error buscando factura pendiente', { clienteId, error: err.message });
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

  logger.info('WispHub: registrando pago', { clienteId, facturaId, monto: body.monto, fecha: fechaPago, metodo, formaPago });
  const { data } = await http.post(`/facturas/${facturaId}/registrar-pago/`, body);
  logger.info('WispHub: pago registrado exitosamente', { clienteId, facturaId, monto: body.monto });
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
  const phone = cliente.celular || cliente.telefono || null;
  if (!phone) return null;
  // Normalizar para WhatsApp (agregar 51 si es número peruano de 9 dígitos)
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length === 9) return `51${clean}`;
  if (clean.length === 11 && clean.startsWith('51')) return clean;
  return clean;
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
      const planPrice      = parseFloat(cliente.precio_plan || cliente.precio || 0) || null;
      const fechaRegistro  = cliente.fecha_registro || null;
      const wisphubRaw     = JSON.stringify(cliente);

      const result = await db.query(
        `INSERT INTO clients
           (wisphub_id, phone, name, email, service_id, plan, address,
            service_status, tags, plan_price, fecha_registro, wisphub_raw, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (wisphub_id) DO UPDATE SET
           phone          = EXCLUDED.phone,
           name           = EXCLUDED.name,
           email          = EXCLUDED.email,
           plan           = EXCLUDED.plan,
           address        = EXCLUDED.address,
           service_status = EXCLUDED.service_status,
           tags           = EXCLUDED.tags,
           plan_price     = EXCLUDED.plan_price,
           wisphub_raw    = EXCLUDED.wisphub_raw,
           last_synced_at = NOW(),
           updated_at     = NOW()
         RETURNING id, (xmax = 0) AS is_new`,
        [wisphubId, phone, name, email, serviceId, plan, address,
         serviceStatus, tags, planPrice, fechaRegistro, wisphubRaw]
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
  sincronizarContactos,
  obtenerFormasPago: _obtenerFormasPago,
};
