const crypto = require('crypto');
const logger = require('../utils/logger');

const verifyWhatsAppSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];

  if (!signature || !process.env.WHATSAPP_APP_SECRET) {
    if (process.env.NODE_ENV !== 'production') return next();
    logger.warn('Missing webhook signature');
    return res.status(401).json({ error: 'Missing signature' });
  }

  try {
    const expectedSig = 'sha256=' + crypto
      .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
      .update(req.rawBody || '')
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      logger.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    next();
  } catch (err) {
    logger.error('Signature verification error', { error: err.message });
    return res.status(500).json({ error: 'Verification failed' });
  }
};

module.exports = { verifyWhatsAppSignature };
