/**
 * MÉTODOS DE PAGO FIBERPERU
 * Se leen de variables de entorno para fácil configuración
 */

const getPaymentInfo = () => ({
  yape:   process.env.YAPE_NUMBER  || '999999999',
  plin:   process.env.PLIN_NUMBER  || '999999999',
  holder: process.env.PAYMENT_HOLDER || 'FiberPeru',
  bcp: {
    account: process.env.BCP_ACCOUNT || '191-XXXXXXXX-0-XX',
    cci:     process.env.BCP_CCI     || '00219100XXXXXXXX0XX0',
  },
  ibk: {
    account: process.env.IBK_ACCOUNT || '898-XXXXXXXXX-0-00',
    cci:     process.env.IBK_CCI     || '00389800XXXXXXXXX000',
  },
});

/**
 * Bloque de texto con todos los métodos de pago (para incluir en mensajes)
 */
const getPaymentBlock = () => {
  const p = getPaymentInfo();
  return `
💜 *Yape:* ${p.yape} (${p.holder})
💛 *Plin:* ${p.plin} (${p.holder})
💙 *BCP Transferencia:*
   Cuenta: \`${p.bcp.account}\`
   CCI: \`${p.bcp.cci}\`
🟢 *Interbank:*
   Cuenta: \`${p.ibk.account}\`
   CCI: \`${p.ibk.cci}\``.trim();
};

module.exports = { getPaymentInfo, getPaymentBlock };
