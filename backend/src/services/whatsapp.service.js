const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const WA_BASE = () => `https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}`;
const WA_HEADERS = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json',
});

const sendTextMessage = async (phone, text) => {
  try {
    const { data } = await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { preview_url: false, body: text },
    }, { headers: WA_HEADERS() });

    logger.info('WhatsApp message sent', { phone, messageId: data.messages?.[0]?.id });
    return data;
  } catch (err) {
    logger.error('Failed to send WhatsApp message', {
      phone,
      error: err.response?.data || err.message,
    });
    throw err;
  }
};

const sendTemplateMessage = async (phone, templateName, language = 'es', components = []) => {
  const { data } = await axios.post(`${WA_BASE()}/messages`, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: { name: templateName, language: { code: language }, components },
  }, { headers: WA_HEADERS() });
  return data;
};

const downloadMedia = async (mediaId) => {
  try {
    // Step 1: Get media URL
    const { data: mediaInfo } = await axios.get(
      `https://graph.facebook.com/v22.0/${mediaId}`,
      { headers: WA_HEADERS() }
    );

    // Step 2: Download media bytes
    const response = await axios.get(mediaInfo.url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer',
    });

    const mime = mediaInfo.mime_type || response.headers['content-type'] || 'image/jpeg';
    const ext = mime.split('/')[1]?.split(';')[0] || 'jpg';
    const filename = `${mediaId}.${ext}`;
    const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads');

    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(response.data));

    logger.info('Media downloaded', { mediaId, filename, size: response.data.byteLength });

    return {
      path: filePath,
      filename,
      mime,
      size: response.data.byteLength,
      url: `/uploads/${filename}`,
    };
  } catch (err) {
    logger.error('Failed to download media', { mediaId, error: err.response?.data || err.message });
    throw err;
  }
};

// Sube un archivo al servidor de WhatsApp y retorna el media_id
const uploadMedia = async (fileBuffer, mimeType, filename) => {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fileBuffer, { filename, contentType: mimeType });
  form.append('type', mimeType);
  form.append('messaging_product', 'whatsapp');

  try {
    const { data } = await axios.post(`${WA_BASE()}/media`, form, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, ...form.getHeaders() },
    });
    logger.info('Media uploaded to WhatsApp', { mediaId: data.id, filename });
    return data.id;
  } catch (err) {
    logger.error('Failed to upload media to WhatsApp', { error: err.response?.data || err.message });
    throw err;
  }
};

// Envía un mensaje multimedia al cliente
const sendMediaMessage = async (phone, mediaId, mediaType, caption = '') => {
  const typePayload = {
    image:    { image:    { id: mediaId, caption } },
    document: { document: { id: mediaId, caption, filename: caption || 'documento' } },
    audio:    { audio:    { id: mediaId } },
  };

  try {
    const { data } = await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: mediaType,
      ...typePayload[mediaType],
    }, { headers: WA_HEADERS() });
    logger.info('WhatsApp media message sent', { phone, mediaId, mediaType });
    return data;
  } catch (err) {
    logger.error('Failed to send WhatsApp media message', { phone, error: err.response?.data || err.message });
    throw err;
  }
};

const markAsRead = async (messageId) => {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    }, { headers: WA_HEADERS() });
  } catch {
    // Non-critical: don't throw
  }
};

const parseWebhookPayload = (body) => {
  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return null;

    const msg = value.messages[0];
    const contact = value.contacts?.[0];

    return {
      phone: msg.from,
      displayName: contact?.profile?.name || msg.from,
      messageId: msg.id,
      timestamp: new Date(parseInt(msg.timestamp) * 1000).toISOString(),
      type: msg.type,
      text: msg.text?.body || null,
      mediaId: msg.image?.id || msg.document?.id || msg.audio?.id || msg.video?.id || null,
      mediaMime: msg.image?.mime_type || msg.document?.mime_type || msg.audio?.mime_type || msg.video?.mime_type || null,
      mediaCaption: msg.image?.caption || msg.document?.caption || null,
      location: msg.location || null,
      context: msg.context || null,
    };
  } catch (err) {
    logger.error('Failed to parse webhook payload', { error: err.message });
    return null;
  }
};

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  downloadMedia,
  uploadMedia,
  sendMediaMessage,
  markAsRead,
  parseWebhookPayload,
};
