"""LLaVA vision fallback via Ollama API.

Used when Tesseract OCR can't confidently extract payment data.
Requires Ollama running locally with llava model pulled.
"""
import base64
import json
import logging
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

OLLAMA_URL = "http://host.docker.internal:11434"

EXTRACTION_PROMPT = """Analiza esta imagen de un comprobante de pago peruano.
Extrae los datos y responde SOLO con JSON valido, sin texto extra:

{
  "es_recibo_valido": true,
  "imagen_legible": true,
  "medio_pago": "Yape|Plin|BCP|Interbank|BBVA|Scotiabank|Transferencia|Tarjeta|Otro",
  "banco": "nombre del banco",
  "nombre_pagador": "nombre del que paga",
  "nombre_receptor": "nombre del que recibe",
  "monto": 0.00,
  "moneda": "PEN",
  "fecha": "YYYY-MM-DD",
  "hora": "HH:MM:SS",
  "codigo_operacion": "numero de operacion",
  "ultimos_4_digitos": null,
  "celular_emisor": null
}

Si no es un comprobante: es_recibo_valido=false. Si no ves un campo, usa null.
El monto debe ser numero decimal. NUNCA inventes datos."""


def extract_receipt_llava(image_path: str) -> dict:
    """Extract payment data using LLaVA model via Ollama.

    Returns dict with extracted fields or error info.
    """
    image_path = Path(image_path)

    if not image_path.exists():
        return {"es_recibo_valido": False, "imagen_legible": False, "error": "Imagen no encontrada"}

    # Encode image
    image_data = image_path.read_bytes()
    base64_image = base64.b64encode(image_data).decode("utf-8")

    try:
        logger.info(f"Sending image to LLaVA: {image_path.name}")
        resp = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": "llava",
                "prompt": EXTRACTION_PROMPT,
                "images": [base64_image],
                "stream": False,
                "options": {
                    "temperature": 0.1,
                    "num_predict": 1024,
                },
            },
            timeout=120,
        )
        resp.raise_for_status()

        result = resp.json()
        raw_text = result.get("response", "").strip()
        logger.info(f"LLaVA raw response: {raw_text[:200]}")

        # Try to extract JSON from response
        json_match = raw_text
        if "```" in raw_text:
            parts = raw_text.split("```")
            for part in parts:
                part = part.strip()
                if part.startswith("json"):
                    part = part[4:].strip()
                if part.startswith("{"):
                    json_match = part
                    break

        # Find JSON object in text
        start = json_match.find("{")
        end = json_match.rfind("}") + 1
        if start >= 0 and end > start:
            json_match = json_match[start:end]

        data = json.loads(json_match)
        data["ocr_confidence"] = "llava"
        return data

    except requests.ConnectionError:
        logger.error("Cannot connect to Ollama. Is it running?")
        return {
            "es_recibo_valido": False,
            "imagen_legible": False,
            "ocr_confidence": "none",
            "error": "Ollama no disponible",
        }
    except requests.Timeout:
        logger.error("Ollama request timed out")
        return {
            "es_recibo_valido": False,
            "imagen_legible": False,
            "ocr_confidence": "none",
            "error": "Timeout de Ollama",
        }
    except (json.JSONDecodeError, requests.RequestException) as e:
        logger.error(f"LLaVA error: {e}")
        return {
            "es_recibo_valido": False,
            "imagen_legible": False,
            "ocr_confidence": "none",
            "error": str(e),
        }


def is_ollama_available() -> bool:
    """Check if Ollama is running and llava model is available."""
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        if resp.status_code == 200:
            models = resp.json().get("models", [])
            names = [m.get("name", "") for m in models]
            available = any("llava" in n for n in names)
            logger.info(f"Ollama available, llava model: {available}")
            return available
    except requests.RequestException:
        pass
    logger.warning("Ollama not available")
    return False
