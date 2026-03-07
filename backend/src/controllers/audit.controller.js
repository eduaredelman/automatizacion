/**
 * AUDIT CONTROLLER - FiberPeru
 * Auditoría completa: WispHub ↔ PostgreSQL ↔ WhatsApp
 * Detecta vinculaciones incorrectas, montos erróneos y pagos mal asignados.
 */

const { query } = require('../config/database');
const wisphub = require('../services/wisphub.service');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// Normalizar número peruano a variantes para búsqueda robusta
// ─────────────────────────────────────────────────────────────
const phoneVariants = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  const base = digits.startsWith('51') ? digits.slice(2) : digits;
  return [...new Set([base, `51${base}`, digits])].filter(p => p.length >= 7);
};

// ─────────────────────────────────────────────────────────────
// GET /api/audit/client?phone=51XXXXXXXXX
// Auditoría completa de un cliente por teléfono
// ─────────────────────────────────────────────────────────────
const auditByPhone = async (req, res) => {
  const rawPhone = req.query.phone || '';
  if (!rawPhone) {
    return res.status(400).json({ success: false, message: 'Parámetro phone requerido' });
  }

  const variants = phoneVariants(rawPhone);
  const report = {
    query_phone: rawPhone,
    phone_variants_checked: variants,
    timestamp: new Date().toISOString(),
    crm: {},
    wisphub: {},
    payments: {},
    inconsistencies: [],
    recommendations: [],
  };

  // ── 1. VERIFICAR EN POSTGRESQL (CRM) ──────────────────────
  try {
    // Conversaciones con ese teléfono
    const convRes = await query(
      `SELECT
         c.id, c.phone, c.display_name, c.status, c.bot_intent,
         c.client_id, c.created_at,
         cl.wisphub_id, cl.name AS client_name, cl.plan, cl.plan_price,
         cl.service_status, cl.wisphub_plan_id, cl.nodo, cl.phone AS client_phone
       FROM conversations c
       LEFT JOIN clients cl ON cl.id = c.client_id
       WHERE c.phone = ANY($1::text[])
       ORDER BY c.created_at DESC
       LIMIT 5`,
      [variants]
    );
    report.crm.conversations = convRes.rows;

    // Clientes con ese teléfono en la tabla clients
    const clientRes = await query(
      `SELECT
         id, wisphub_id, phone, name, plan, plan_price,
         service_status, wisphub_plan_id, nodo, last_synced_at,
         debt_amount
       FROM clients
       WHERE phone = ANY($1::text[])`,
      [variants]
    );
    report.crm.clients = clientRes.rows;

    // Pagos asociados a esas conversaciones
    if (convRes.rows.length > 0) {
      const convIds = convRes.rows.map(r => r.id);
      const payRes = await query(
        `SELECT
           p.id, p.conversation_id, p.client_id, p.status, p.amount,
           p.payment_method, p.operation_code, p.payment_date,
           p.rejection_reason, p.registered_wisphub, p.factura_id,
           p.created_at,
           cl.wisphub_id, cl.name AS client_name
         FROM payments p
         LEFT JOIN clients cl ON cl.id = p.client_id
         WHERE p.conversation_id = ANY($1::uuid[])
         ORDER BY p.created_at DESC`,
        [convIds]
      );
      report.payments.from_conversations = payRes.rows;
    }

    // Pagos donde client_id apunta a un cliente con ese teléfono
    if (report.crm.clients.length > 0) {
      const clientIds = report.crm.clients.map(r => r.id);
      const payByClient = await query(
        `SELECT
           p.id, p.conversation_id, p.client_id, p.status, p.amount,
           p.payment_method, p.operation_code, p.payment_date,
           p.registered_wisphub, p.factura_id, p.created_at
         FROM payments p
         WHERE p.client_id = ANY($1::uuid[])
         ORDER BY p.created_at DESC
         LIMIT 20`,
        [clientIds]
      );
      report.payments.from_client_id = payByClient.rows;
    }

  } catch (err) {
    report.crm.error = err.message;
    logger.error('[AUDIT] CRM query error', { error: err.message });
  }

  // ── 2. VERIFICAR EN WISPHUB ────────────────────────────────
  try {
    // Buscar cliente por teléfono en WispHub
    const wispClient = await wisphub.buscarClientePorTelefono(rawPhone);
    report.wisphub.client_by_phone = wispClient || null;

    if (wispClient) {
      const clientId = wispClient.id_servicio || wispClient.id;
      report.wisphub.client_id = clientId;
      report.wisphub.client_name = wispClient.nombre || wispClient.nombre_completo;
      report.wisphub.client_phone_celular = wispClient.celular;
      report.wisphub.client_phone_telefono = wispClient.telefono;
      report.wisphub.client_phone_movil = wispClient.movil;
      report.wisphub.plan = wispClient.plan || wispClient.plan_nombre;
      report.wisphub.plan_price_fields = {
        precio_plan:    wispClient.precio_plan,
        monto_plan:     wispClient.monto_plan,
        costo_plan:     wispClient.costo_plan,
        precio:         wispClient.precio,
        costo:          wispClient.costo,
        valor:          wispClient.valor,
        monto:          wispClient.monto,
        precio_mensual: wispClient.precio_mensual,
      };
      report.wisphub.all_fields = Object.keys(wispClient);

      // Obtener facturas pendientes del cliente WispHub
      try {
        const debtInfo = await wisphub.consultarDeuda(clientId, null, wispClient.usuario || null);
        report.wisphub.debt_info = {
          tiene_deuda:       debtInfo.tiene_deuda,
          monto_mensual:     debtInfo.monto_mensual,
          monto_deuda:       debtInfo.monto_deuda,
          cantidad_facturas: debtInfo.cantidad_facturas,
          factura_id:        debtInfo.factura_id,
          facturas_sample:   (debtInfo.facturas || []).slice(0, 3).map(f => ({
            id:     f.id_factura || f.id,
            estado: f.estado,
            monto:  f.total || f.sub_total || f.monto,
            fecha:  f.fecha_vencimiento || f.fecha,
            usuario: f.usuario,
            id_servicio: f.cliente?.id_servicio || f.id_servicio,
          })),
        };
      } catch (debtErr) {
        report.wisphub.debt_error = debtErr.message;
      }
    }
  } catch (err) {
    report.wisphub.error = err.message;
    logger.error('[AUDIT] WispHub query error', { error: err.message });
  }

  // ── 3. DETECTAR INCONSISTENCIAS ───────────────────────────
  const issues = [];
  const recs = [];

  const crmClient = report.crm.clients?.[0];
  const wispClient = report.wisphub.client_by_phone;
  const crmConv = report.crm.conversations?.[0];

  // 3a. Teléfono en CRM ≠ teléfono en WispHub
  if (wispClient) {
    const wispPhone = wisphub.obtenerTelefonoCliente(wispClient);
    const phoneMatch = variants.some(v => v === wispPhone || v === String(wispClient.celular || '').replace(/\D/g, ''));
    if (!phoneMatch) {
      issues.push({
        tipo: 'PHONE_MISMATCH',
        detalle: `WispHub devolvió cliente "${report.wisphub.client_name}" para el teléfono ${rawPhone}, pero el teléfono real del cliente en WispHub es ${wispPhone || wispClient.celular}`,
        gravedad: 'CRITICA',
      });
      recs.push('Verificar manualmente en WispHub si el teléfono realmente pertenece a ese cliente.');
    }
  }

  // 3b. Conversación vinculada a cliente incorrecto
  if (crmConv && wispClient && crmConv.wisphub_id) {
    const wispId = String(wispClient.id_servicio || wispClient.id);
    if (String(crmConv.wisphub_id) !== wispId) {
      issues.push({
        tipo: 'WRONG_CLIENT_LINKED',
        detalle: `La conversación está vinculada a wisphub_id="${crmConv.wisphub_id}" (${crmConv.client_name}) pero WispHub retorna wisphub_id="${wispId}" (${report.wisphub.client_name}) para el mismo teléfono`,
        gravedad: 'CRITICA',
      });
      recs.push(`Ejecutar: UPDATE conversations SET client_id = (SELECT id FROM clients WHERE wisphub_id = '${wispId}' LIMIT 1), display_name = '${report.wisphub.client_name}' WHERE phone = '${rawPhone}';`);
      recs.push(`Ejecutar: UPDATE clients SET wisphub_id = '${wispId}', name = '${report.wisphub.client_name}' WHERE phone = ANY(ARRAY[${variants.map(v => `'${v}'`).join(',')}]);`);
    }
  }

  // 3c. plan_price en CRM no coincide con WispHub
  if (crmClient && wispClient) {
    const wispPrice = parseFloat(
      wispClient.precio_plan || wispClient.monto_plan || wispClient.costo_plan ||
      wispClient.precio || wispClient.costo || wispClient.valor || wispClient.monto ||
      wispClient.precio_mensual || 0
    ) || null;
    const crmPrice = parseFloat(crmClient.plan_price) || null;

    if (wispPrice && crmPrice && Math.abs(wispPrice - crmPrice) > 0.5) {
      issues.push({
        tipo: 'PLAN_PRICE_MISMATCH',
        detalle: `CRM tiene plan_price=S/${crmPrice} pero WispHub tiene precio=S/${wispPrice}`,
        gravedad: 'ALTA',
      });
      recs.push(`Ejecutar: UPDATE clients SET plan_price = ${wispPrice} WHERE wisphub_id = '${crmClient.wisphub_id}';`);
    }

    if (!crmPrice && wispPrice) {
      issues.push({
        tipo: 'PLAN_PRICE_NULL',
        detalle: `CRM tiene plan_price=NULL. El bot no puede validar montos correctamente. WispHub tiene precio=S/${wispPrice}`,
        gravedad: 'ALTA',
      });
      recs.push(`Ejecutar: UPDATE clients SET plan_price = ${wispPrice} WHERE wisphub_id = '${crmClient.wisphub_id}';`);
    }
  }

  // 3d. Pagos sin client_id
  const pagosHuerfanos = (report.payments.from_conversations || []).filter(p => !p.client_id);
  if (pagosHuerfanos.length > 0) {
    issues.push({
      tipo: 'PAYMENTS_WITHOUT_CLIENT',
      detalle: `${pagosHuerfanos.length} pago(s) sin client_id vinculado: ${pagosHuerfanos.map(p => p.id).join(', ')}`,
      gravedad: 'MEDIA',
    });
    if (crmClient) {
      recs.push(`Ejecutar: UPDATE payments SET client_id = '${crmClient.id}' WHERE id IN (${pagosHuerfanos.map(p => `'${p.id}'`).join(',')});`);
    }
  }

  // 3e. Cliente no encontrado en WispHub
  if (!wispClient) {
    issues.push({
      tipo: 'NOT_IN_WISPHUB',
      detalle: `El teléfono ${rawPhone} no retorna ningún cliente en WispHub API. Posible número incorrecto o no registrado.`,
      gravedad: 'ALTA',
    });
    recs.push('Verificar el número en WispHub manualmente. El cliente puede estar registrado con otro formato de teléfono.');
  }

  // 3f. Nombre en CRM diferente al nombre en WispHub
  if (crmConv && wispClient) {
    const crmName = (crmConv.display_name || '').toLowerCase().trim();
    const wispName = (report.wisphub.client_name || '').toLowerCase().trim();
    if (crmName && wispName && crmName !== wispName) {
      issues.push({
        tipo: 'NAME_MISMATCH',
        detalle: `Chat muestra "${crmConv.display_name}" pero WispHub tiene "${report.wisphub.client_name}"`,
        gravedad: 'ALTA',
      });
      recs.push(`El nombre real del cliente en WispHub es "${report.wisphub.client_name}". Actualizar display_name en conversaciones.`);
    }
  }

  // 3g. Facturas con id_servicio diferente al cliente
  if (report.wisphub.debt_info?.facturas_sample?.length > 0 && wispClient) {
    const wispId = String(wispClient.id_servicio || wispClient.id);
    const facturasAjenas = report.wisphub.debt_info.facturas_sample.filter(f => {
      const fId = String(f.id_servicio || '');
      return fId && fId !== wispId;
    });
    if (facturasAjenas.length > 0) {
      issues.push({
        tipo: 'INVOICES_FROM_OTHER_CLIENT',
        detalle: `Facturas con id_servicio diferente al cliente: ${JSON.stringify(facturasAjenas.map(f => ({ id: f.id, id_servicio: f.id_servicio })))}`,
        gravedad: 'CRITICA',
      });
      recs.push('WispHub está retornando facturas de OTRO cliente. La lógica de consultarDeuda necesita filtrar por id_servicio correctamente.');
    }
  }

  report.inconsistencies = issues;
  report.recommendations = recs;
  report.summary = {
    total_issues: issues.length,
    critical: issues.filter(i => i.gravedad === 'CRITICA').length,
    high:     issues.filter(i => i.gravedad === 'ALTA').length,
    medium:   issues.filter(i => i.gravedad === 'MEDIA').length,
    client_correctly_linked: issues.filter(i => ['WRONG_CLIENT_LINKED', 'NAME_MISMATCH'].includes(i.tipo)).length === 0,
    plan_price_ok: issues.filter(i => ['PLAN_PRICE_MISMATCH', 'PLAN_PRICE_NULL'].includes(i.tipo)).length === 0,
    payments_ok:  issues.filter(i => i.tipo === 'PAYMENTS_WITHOUT_CLIENT').length === 0,
  };

  return res.json({ success: true, report });
};

// ─────────────────────────────────────────────────────────────
// GET /api/audit/client-name?name=Marcela
// Buscar cliente por nombre en WispHub y cruzar con CRM
// ─────────────────────────────────────────────────────────────
const auditByName = async (req, res) => {
  const name = req.query.name || '';
  if (!name || name.length < 3) {
    return res.status(400).json({ success: false, message: 'Parámetro name requerido (mínimo 3 caracteres)' });
  }

  const result = { query_name: name, wisphub: null, crm: null };

  try {
    const wispClient = await wisphub.buscarClientePorNombre(name);
    result.wisphub = wispClient ? {
      id_servicio: wispClient.id_servicio || wispClient.id,
      nombre: wispClient.nombre || wispClient.nombre_completo,
      celular: wispClient.celular,
      telefono: wispClient.telefono,
      movil: wispClient.movil,
      plan: wispClient.plan || wispClient.plan_nombre,
      estado: wispClient.estado || wispClient.activo,
      usuario: wispClient.usuario,
      precio_plan: wispClient.precio_plan || wispClient.precio || wispClient.monto,
    } : null;
  } catch (err) {
    result.wisphub_error = err.message;
  }

  try {
    const crmRes = await query(
      `SELECT id, wisphub_id, phone, name, plan, plan_price, service_status
       FROM clients
       WHERE name ILIKE $1
       LIMIT 10`,
      [`%${name}%`]
    );
    result.crm = crmRes.rows;
  } catch (err) {
    result.crm_error = err.message;
  }

  return res.json({ success: true, result });
};

// ─────────────────────────────────────────────────────────────
// GET /api/audit/conversation?id=UUID
// Auditoría completa de una conversación específica
// ─────────────────────────────────────────────────────────────
const auditConversation = async (req, res) => {
  const convId = req.query.id || '';
  if (!convId) {
    return res.status(400).json({ success: false, message: 'Parámetro id (conversationId) requerido' });
  }

  try {
    const convRes = await query(
      `SELECT
         c.*,
         cl.wisphub_id, cl.name AS wisphub_name, cl.plan, cl.plan_price,
         cl.service_status, cl.wisphub_plan_id, cl.nodo, cl.phone AS client_stored_phone,
         cl.last_synced_at
       FROM conversations c
       LEFT JOIN clients cl ON cl.id = c.client_id
       WHERE c.id = $1`,
      [convId]
    );

    if (!convRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Conversación no encontrada' });
    }

    const conv = convRes.rows[0];

    const paymentsRes = await query(
      `SELECT p.*, cl.wisphub_id, cl.name AS client_name, cl.phone AS client_phone
       FROM payments p
       LEFT JOIN clients cl ON cl.id = p.client_id
       WHERE p.conversation_id = $1
       ORDER BY p.created_at DESC`,
      [convId]
    );

    const messagesRes = await query(
      `SELECT id, direction, content, type, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [convId]
    );

    // Verificar en WispHub con el teléfono de la conversación
    let wispVerification = null;
    if (conv.phone) {
      try {
        const wispClient = await wisphub.buscarClientePorTelefono(conv.phone);
        wispVerification = wispClient ? {
          id_servicio: wispClient.id_servicio || wispClient.id,
          nombre: wispClient.nombre || wispClient.nombre_completo,
          celular: wispClient.celular,
          telefono: wispClient.telefono,
          plan: wispClient.plan || wispClient.plan_nombre,
          coincide_con_crm: String(wispClient.id_servicio || wispClient.id) === String(conv.wisphub_id),
          nombre_coincide: (wispClient.nombre || '').toLowerCase() === (conv.display_name || '').toLowerCase(),
        } : { error: 'Teléfono no encontrado en WispHub' };
      } catch (e) {
        wispVerification = { error: e.message };
      }
    }

    return res.json({
      success: true,
      conversation: conv,
      payments: paymentsRes.rows,
      messages_last_20: messagesRes.rows,
      wisphub_verification: wispVerification,
      issues: [
        conv.client_id === null ? 'ADVERTENCIA: conversation.client_id es NULL — el cliente no está vinculado' : null,
        conv.wisphub_id && wispVerification && !wispVerification.coincide_con_crm
          ? `CRITICO: CRM tiene wisphub_id=${conv.wisphub_id} pero WispHub retorna id=${wispVerification.id_servicio} para este teléfono`
          : null,
        conv.display_name !== conv.wisphub_name && conv.wisphub_name
          ? `ADVERTENCIA: display_name="${conv.display_name}" difiere del nombre en clients "${conv.wisphub_name}"`
          : null,
        paymentsRes.rows.some(p => !p.client_id)
          ? 'ADVERTENCIA: Hay pagos sin client_id vinculado'
          : null,
      ].filter(Boolean),
    });
  } catch (err) {
    logger.error('[AUDIT] auditConversation error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/audit/fix-client?phone=51XXXXXXXXX
// Corregir automáticamente vinculación incorrecta de cliente
// ─────────────────────────────────────────────────────────────
const fixClientLink = async (req, res) => {
  const rawPhone = req.query.phone || '';
  if (!rawPhone) {
    return res.status(400).json({ success: false, message: 'Parámetro phone requerido' });
  }

  const variants = phoneVariants(rawPhone);
  const fixes = [];

  try {
    // 1. Buscar cliente real en WispHub
    const wispClient = await wisphub.buscarClientePorTelefono(rawPhone);
    if (!wispClient) {
      return res.json({ success: false, message: 'Cliente no encontrado en WispHub para ese teléfono', fixes });
    }

    const wispId    = String(wispClient.id_servicio || wispClient.id);
    const wispName  = wispClient.nombre || wispClient.nombre_completo || 'N/A';
    const wispPhone = wisphub.obtenerTelefonoCliente(wispClient) || rawPhone;
    const wispPrice = parseFloat(
      wispClient.precio_plan || wispClient.monto_plan || wispClient.precio ||
      wispClient.costo || wispClient.valor || wispClient.monto || 0
    ) || null;

    // 2. Upsert cliente correcto en clients
    const clientRes = await query(
      `INSERT INTO clients (wisphub_id, phone, name, service_id, plan, plan_price, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (wisphub_id) DO UPDATE SET
         phone          = EXCLUDED.phone,
         name           = EXCLUDED.name,
         plan           = EXCLUDED.plan,
         plan_price     = CASE WHEN EXCLUDED.plan_price IS NOT NULL THEN EXCLUDED.plan_price ELSE clients.plan_price END,
         last_synced_at = NOW(),
         updated_at     = NOW()
       RETURNING id`,
      [wispId, wispPhone, wispName, wispId,
       wispClient.plan || wispClient.plan_nombre || null, wispPrice]
    );
    const clientDbId = clientRes.rows[0].id;
    fixes.push(`Cliente upsert: wisphub_id=${wispId}, name="${wispName}", plan_price=${wispPrice}`);

    // 3. Actualizar TODAS las conversaciones con ese teléfono
    const convUpdate = await query(
      `UPDATE conversations SET
         client_id    = $1,
         display_name = $2,
         bot_intent   = 'identity_ok'
       WHERE phone = ANY($3::text[])
       RETURNING id, phone, display_name`,
      [clientDbId, wispName, variants]
    );
    fixes.push(`${convUpdate.rowCount} conversación(es) re-vinculadas a "${wispName}" (wisphub_id=${wispId})`);

    // 4. Actualizar pagos huérfanos de esas conversaciones
    if (convUpdate.rows.length > 0) {
      const convIds = convUpdate.rows.map(r => r.id);
      const payUpdate = await query(
        `UPDATE payments SET client_id = $1
         WHERE conversation_id = ANY($2::uuid[]) AND client_id IS NULL
         RETURNING id`,
        [clientDbId, convIds]
      );
      if (payUpdate.rowCount > 0) {
        fixes.push(`${payUpdate.rowCount} pago(s) vinculados al cliente correcto`);
      }
    }

    return res.json({
      success: true,
      wisphub_client: { id_servicio: wispId, nombre: wispName, phone: wispPhone, plan_price: wispPrice },
      fixes,
    });

  } catch (err) {
    logger.error('[AUDIT] fixClientLink error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message, fixes });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/audit/db-summary
// Resumen del estado de la base de datos
// ─────────────────────────────────────────────────────────────
const dbSummary = async (req, res) => {
  try {
    const [
      convStats, clientStats, payStats,
      orphanPayments, nullPlanPrice, duplicatePhones
    ] = await Promise.all([
      query(`SELECT status, COUNT(*) FROM conversations GROUP BY status`),
      query(`SELECT service_status, COUNT(*) FROM clients GROUP BY service_status`),
      query(`SELECT status, COUNT(*), SUM(amount)::numeric(10,2) AS total FROM payments GROUP BY status`),
      // Pagos sin client_id
      query(`SELECT COUNT(*) AS count FROM payments WHERE client_id IS NULL`),
      // Clientes sin plan_price
      query(`SELECT COUNT(*) AS count FROM clients WHERE plan_price IS NULL OR plan_price = 0`),
      // Teléfonos duplicados en clients
      query(`
        SELECT phone, COUNT(*) AS count, array_agg(wisphub_id) AS wisphub_ids
        FROM clients
        WHERE phone IS NOT NULL AND phone != ''
        GROUP BY phone HAVING COUNT(*) > 1
        LIMIT 20
      `),
    ]);

    // Conversaciones sin client_id
    const orphanConvs = await query(
      `SELECT COUNT(*) AS count FROM conversations WHERE client_id IS NULL`
    );

    return res.json({
      success: true,
      summary: {
        conversations_by_status: convStats.rows,
        clients_by_service_status: clientStats.rows,
        payments_by_status: payStats.rows,
        orphan_payments_no_client_id: parseInt(orphanPayments.rows[0]?.count || 0),
        conversations_no_client_id: parseInt(orphanConvs.rows[0]?.count || 0),
        clients_without_plan_price: parseInt(nullPlanPrice.rows[0]?.count || 0),
        duplicate_phones_in_clients: duplicatePhones.rows,
      },
    });
  } catch (err) {
    logger.error('[AUDIT] dbSummary error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/audit/simulate?phone=51XXXXXXXXX
// Simula qué vería el bot para ese cliente sin enviar WhatsApp
// ─────────────────────────────────────────────────────────────
const simulateBot = async (req, res) => {
  const rawPhone = req.query.phone || '';
  if (!rawPhone) {
    return res.status(400).json({ success: false, message: 'Parámetro phone requerido' });
  }

  const result = {
    phone: rawPhone,
    timestamp: new Date().toISOString(),
    crm_client: null,
    wisphub_client: null,
    deuda: null,
    bot_preview: {},
    warnings: [],
  };

  try {
    // ── 1. Buscar en CRM (PostgreSQL) ──────────────────────
    const variants = phoneVariants(rawPhone);
    const crmRes = await query(
      `SELECT cl.wisphub_id, cl.name, cl.plan, cl.plan_price, cl.service_status,
              cl.nodo, cl.wisphub_plan_id, cl.phone AS client_phone,
              c.display_name, c.status AS conv_status, c.client_id,
              c.id AS conv_id
       FROM conversations c
       LEFT JOIN clients cl ON cl.id = c.client_id
       WHERE c.phone = ANY($1::text[])
       ORDER BY c.last_message_at DESC LIMIT 1`,
      [variants]
    );

    if (crmRes.rows.length) {
      const r = crmRes.rows[0];
      result.crm_client = {
        conv_id: r.conv_id,
        display_name: r.display_name,
        conv_status: r.conv_status,
        wisphub_id: r.wisphub_id,
        name: r.name,
        plan: r.plan,
        plan_price: r.plan_price,
        service_status: r.service_status,
        nodo: r.nodo,
      };
    }

    // ── 2. Buscar en WispHub ───────────────────────────────
    const digits9 = rawPhone.replace(/\D/g, '').replace(/^51/, '');
    try {
      const whClients = await wisphub.buscarClientePorTelefono(digits9);
      if (whClients && whClients.length > 0) {
        const wh = whClients[0];
        result.wisphub_client = {
          id_servicio: wh.id_servicio,
          nombre: wh.nombre,
          usuario: wh.usuario,
          estado: wh.estado,
          plan: wh.nombre_plan || wh.plan,
          precio_plan: wh.precio_plan,
          nodo: wh.nodo || wh.nombre_nodo,
          celular: wh.celular,
          telefono: wh.telefono,
        };
      }
    } catch (e) {
      result.warnings.push(`WispHub búsqueda falló: ${e.message}`);
    }

    // ── 3. Consultar deuda (lógica real del bot) ───────────
    const wisphubId = result.crm_client?.wisphub_id || result.wisphub_client?.id_servicio;
    const planPrice = parseFloat(result.crm_client?.plan_price || result.wisphub_client?.precio_plan || 0) || null;
    const usuario   = result.wisphub_client?.usuario || null;

    if (wisphubId) {
      try {
        result.deuda = await wisphub.consultarDeuda(wisphubId, planPrice, usuario);
      } catch (e) {
        result.warnings.push(`consultarDeuda falló: ${e.message}`);
      }
    } else {
      result.warnings.push('No se encontró wisphub_id — cliente no vinculado');
    }

    // ── 4. Preview del mensaje que vería el cliente ────────
    const nombre      = result.crm_client?.name || result.wisphub_client?.nombre || 'Cliente';
    const cuota       = result.deuda?.monto_mensual || planPrice || 0;
    const tienePendiente = result.deuda?.tiene_deuda;
    const estado      = result.wisphub_client?.estado || result.crm_client?.service_status || 'desconocido';

    result.bot_preview = {
      nombre_que_ve_el_bot: nombre,
      cuota_mensual_usada: cuota,
      tiene_deuda_pendiente: tienePendiente,
      estado_servicio: estado,
      mensaje_bienvenida: `Hola ${nombre.split(' ')[0]}, soy el asistente de FiberPeru. ¿En qué te puedo ayudar?`,
      mensaje_cuota: cuota > 0
        ? `Tu cuota mensual es S/ ${parseFloat(cuota).toFixed(2)}.`
        : 'No se pudo determinar la cuota mensual.',
      monto_que_validara_el_bot: cuota > 0 ? `S/ ${parseFloat(cuota).toFixed(2)}` : 'DESCONOCIDO',
    };

    // ── 5. Detección de problemas ──────────────────────────
    if (!result.crm_client?.wisphub_id) {
      result.warnings.push('Conversacion NO vinculada a cliente WispHub');
    }
    if (result.crm_client?.plan_price && result.wisphub_client?.precio_plan) {
      const dbPrice = parseFloat(result.crm_client.plan_price);
      const whPrice = parseFloat(result.wisphub_client.precio_plan);
      if (Math.abs(dbPrice - whPrice) > 0.5) {
        result.warnings.push(`PLAN_PRICE_MISMATCH: BD tiene S/${dbPrice} pero WispHub dice S/${whPrice}`);
      }
    }

    return res.json({ success: true, simulate: result });
  } catch (err) {
    logger.error('[AUDIT] simulateBot error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { auditByPhone, auditByName, auditConversation, fixClientLink, dbSummary, simulateBot };
