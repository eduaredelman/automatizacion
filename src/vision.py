"""Receipt data extraction orchestrator.

Pipeline:
1. Tesseract OCR (fast, free) → parse with regex
2. If OCR confidence is low → LLaVA via Ollama (local AI)
"""
import logging

from src.ocr_parser import parse_receipt_ocr
from src.llava_vision import extract_receipt_llava, is_ollama_available

logger = logging.getLogger(__name__)


def extract_receipt_data(image_path: str) -> dict:
    """Extract payment data from a receipt image.

    Strategy:
    1. Try Tesseract OCR first (fast, free)
    2. If confidence is high/medium → return OCR result
    3. If confidence is low/none → try LLaVA (local AI with vision)
    4. If LLaVA not available → return OCR result anyway
    """
    # Step 1: OCR
    logger.info(f"Step 1: Trying Tesseract OCR for {image_path}")
    ocr_result = parse_receipt_ocr(image_path)
    confidence = ocr_result.get("ocr_confidence", "none")

    if confidence in ("high", "medium"):
        logger.info(f"OCR confidence={confidence}, using OCR result")
        return ocr_result

    # Step 2: LLaVA fallback
    logger.info(f"OCR confidence={confidence}, trying LLaVA fallback")

    if not is_ollama_available():
        logger.warning("Ollama/LLaVA not available, returning OCR result")
        return ocr_result

    llava_result = extract_receipt_llava(image_path)

    if llava_result.get("es_recibo_valido"):
        logger.info("LLaVA extracted valid receipt data")
        return llava_result

    # If both fail, return whichever has more data
    if ocr_result.get("monto") is not None:
        return ocr_result

    return llava_result
