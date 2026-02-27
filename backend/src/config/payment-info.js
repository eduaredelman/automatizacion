/**
 * MÉTODOS DE PAGO FIBER PERU
 * Lee exactamente las variables definidas en backend/.env
 * No tiene valores por defecto falsos — si no está configurado, no se muestra.
 */

const getPaymentBlock = () => {
  const lines = [];

  // Yape
  if (process.env.YAPE_NUMBER) {
    const name = process.env.YAPE_NAME || 'Fiber Peru';
    lines.push(`💜 *Yape:* ${process.env.YAPE_NUMBER} (${name})`);
  }

  // Plin
  if (process.env.PLIN_NUMBER) {
    const name = process.env.PLIN_NAME || 'Fiber Peru';
    lines.push(`💛 *Plin:* ${process.env.PLIN_NUMBER} (${name})`);
  }

  // BCP  (variable: BCP_ACCOUNT_NUMBER + BCP_CCI)
  if (process.env.BCP_ACCOUNT_NUMBER) {
    const holder = process.env.BCP_ACCOUNT_NAME ? ` — ${process.env.BCP_ACCOUNT_NAME}` : '';
    lines.push(`💙 *BCP Transferencia:*${holder}`);
    lines.push(`   Cuenta: \`${process.env.BCP_ACCOUNT_NUMBER}\``);
    if (process.env.BCP_CCI) {
      lines.push(`   CCI: \`${process.env.BCP_CCI}\``);
    }
  }

  // Interbank (opcional — solo aparece si está configurado)
  if (process.env.IBK_ACCOUNT_NUMBER || process.env.IBK_ACCOUNT) {
    const account = process.env.IBK_ACCOUNT_NUMBER || process.env.IBK_ACCOUNT;
    const holder  = process.env.IBK_ACCOUNT_NAME ? ` — ${process.env.IBK_ACCOUNT_NAME}` : '';
    lines.push(`🟢 *Interbank:*${holder}`);
    lines.push(`   Cuenta: \`${account}\``);
    if (process.env.IBK_CCI) {
      lines.push(`   CCI: \`${process.env.IBK_CCI}\``);
    }
  }

  return lines.join('\n');
};

module.exports = { getPaymentBlock };
