// OCR service stub - Python microservice removed
// Payment processing uses AI Vision (Claude/OpenAI) directly

const analyzeVoucher = async (_imagePath) => {
  return { success: false, confidence: 'none' };
};

const checkOcrHealth = async () => false;

module.exports = { analyzeVoucher, checkOcrHealth };
