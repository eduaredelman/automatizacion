const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const logger = require('../utils/logger');

const OCR_URL = process.env.OCR_SERVICE_URL || 'http://python-ocr:8085';

const analyzeVoucher = async (imagePath) => {
  try {
    const form = new FormData();
    form.append('image', fs.createReadStream(imagePath));

    const { data } = await axios.post(`${OCR_URL}/analyze`, form, {
      headers: form.getHeaders(),
      timeout: 60000,
    });

    logger.info('OCR analysis complete', {
      confidence: data.confidence,
      method: data.extraction_method,
      bank: data.bank,
      amount: data.monto,
    });

    return {
      success: true,
      confidence: data.confidence || 'none',
      method: data.extraction_method || 'ocr',
      paymentMethod: data.bank || data.medio_pago || 'unknown',
      amount: parseFloat(data.monto) || null,
      currency: data.moneda || 'PEN',
      operationCode: data.codigo_operacion || null,
      paymentDate: data.fecha || null,
      paymentTime: data.hora || null,
      payerName: data.nombre_pagador || null,
      receiverName: data.nombre_receptor || null,
      phone: data.telefono || null,
      cardLast4: data.ultimos_digitos || null,
      rawText: data.raw_text || null,
      rawData: data,
    };
  } catch (err) {
    logger.error('OCR service failed', { imagePath, error: err.message });
    return { success: false, confidence: 'none', error: err.message };
  }
};

const checkOcrHealth = async () => {
  try {
    const { data } = await axios.get(`${OCR_URL}/health`, { timeout: 5000 });
    return data.status === 'healthy';
  } catch {
    return false;
  }
};

module.exports = { analyzeVoucher, checkOcrHealth };
