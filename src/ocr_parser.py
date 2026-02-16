"""OCR-based receipt parser using Tesseract.

Extracts payment data from receipt images using OCR + regex patterns
for Peruvian payment methods (Yape, Plin, BCP, Interbank, etc.).
"""
import logging
import re
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter
import pytesseract

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Bank/payment detection patterns
# ---------------------------------------------------------------------------

BANK_PATTERNS = {
    "Yape": [r"(?i)\byape\b", r"(?i)\byapeo\b", r"(?i)\byapeaste\b"],
    "Plin": [r"(?i)\bplin\b"],
    "BCP": [r"(?i)\bbcp\b", r"(?i)banco\s*de\s*cr[eé]dito"],
    "Interbank": [r"(?i)\binterbank\b"],
    "BBVA": [r"(?i)\bbbva\b", r"(?i)\bcontinental\b"],
    "Scotiabank": [r"(?i)\bscotiabank\b"],
    "BanBif": [r"(?i)\bbanbif\b"],
    "Banco de la Nacion": [r"(?i)banco\s*de\s*la\s*naci[oó]n"],
    "Tarjeta": [r"(?i)tarjeta\s*(de\s*)?(cr[eé]dito|d[eé]bito)", r"(?i)\bvisa\b", r"(?i)\bmastercard\b"],
    "Transferencia": [r"(?i)transferencia\s*(bancaria)?", r"(?i)\btransferencia\b"],
}

# ---------------------------------------------------------------------------
# Data extraction patterns
# ---------------------------------------------------------------------------

# Amount: S/ 50.00, S/50, 50.00, PEN 50.00, $ 50.00
AMOUNT_PATTERNS = [
    r"S/\.?\s*(\d{1,6}[.,]\d{2})",
    r"S/\.?\s*(\d{1,6})",
    r"PEN\s*(\d{1,6}[.,]\d{2})",
    r"(\d{1,6}[.,]\d{2})\s*(?:soles|PEN)",
    r"(?:monto|importe|total|pagaste|recibido|enviaste)\s*:?\s*S?/?\.?\s*(\d{1,6}[.,]\d{2})",
    r"USD?\s*\$?\s*(\d{1,6}[.,]\d{2})",
]

# Operation code / transaction ID
OPERATION_PATTERNS = [
    r"(?:N[°ºo]?\s*(?:de\s*)?(?:operaci[oó]n|transacci[oó]n|referencia|pedido))\s*:?\s*(\w{4,20})",
    r"(?:C[oó]digo|Code)\s*:?\s*(\w{4,20})",
    r"(?:operaci[oó]n|transacci[oó]n)\s*:?\s*#?\s*(\w{4,20})",
    r"(?:N[°ºo]?\s*operaci[oó]n)\s*:?\s*(\d{6,20})",
    r"(?:CodOpe|Op\.?)\s*:?\s*(\d{6,20})",
    r"#(\d{8,20})",
]

# Date: DD/MM/YYYY, DD-MM-YYYY, DD de mes YYYY
DATE_PATTERNS = [
    r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})",
    r"(\d{1,2})\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*(?:de\s*)?(\d{2,4})",
]

MONTH_MAP = {
    "enero": "01", "febrero": "02", "marzo": "03", "abril": "04",
    "mayo": "05", "junio": "06", "julio": "07", "agosto": "08",
    "septiembre": "09", "octubre": "10", "noviembre": "11", "diciembre": "12",
}

# Time: HH:MM:SS or HH:MM
TIME_PATTERNS = [
    r"(\d{1,2}:\d{2}:\d{2})",
    r"(\d{1,2}:\d{2})\s*(?:hrs?|a\.?m\.?|p\.?m\.?|horas)?",
]

# Phone number (Peru: 9 digits starting with 9)
PHONE_PATTERNS = [
    r"(?:celular|tel[eé]fono|m[oó]vil|cel)\s*:?\s*(\d{9})",
    r"\b(9\d{8})\b",
]

# Last 4 digits of card/account
LAST4_PATTERNS = [
    r"\*{2,}(\d{4})",
    r"(?:terminada?\s*en|ending)\s*(\d{4})",
    r"(?:cuenta|tarjeta)\s*\*+(\d{4})",
]

# Name patterns
NAME_PATTERNS = [
    r"(?:De|Para|Enviado\s*a|Recibido\s*de|Pagador|Destinatario|Nombre)\s*:?\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,4})",
]


def preprocess_image(image_path: str) -> Image.Image:
    """Enhance image for better OCR results."""
    img = Image.open(image_path)

    # Convert to RGB if needed
    if img.mode != "RGB":
        img = img.convert("RGB")

    # Resize if too small
    w, h = img.size
    if w < 800:
        ratio = 800 / w
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

    # Enhance contrast and sharpness
    img = ImageEnhance.Contrast(img).enhance(1.5)
    img = ImageEnhance.Sharpness(img).enhance(2.0)
    img = img.filter(ImageFilter.SHARPEN)

    return img


def extract_text(image_path: str) -> str:
    """Extract text from image using Tesseract OCR."""
    img = preprocess_image(image_path)

    # Try Spanish first, then Spanish+English
    text = pytesseract.image_to_string(img, lang="spa", config="--psm 6")

    if len(text.strip()) < 20:
        text = pytesseract.image_to_string(img, lang="spa+eng", config="--psm 3")

    logger.info(f"OCR extracted {len(text)} chars from {Path(image_path).name}")
    return text


def detect_bank(text: str) -> str | None:
    """Detect bank/payment platform from OCR text."""
    for bank, patterns in BANK_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, text):
                logger.info(f"Detected bank: {bank}")
                return bank
    return None


def extract_amount(text: str) -> tuple[float | None, str]:
    """Extract amount and currency. Returns (amount, currency)."""
    # Check for USD first
    for pattern in AMOUNT_PATTERNS:
        match = re.search(pattern, text)
        if match:
            amount_str = match.group(1).replace(",", ".")
            try:
                amount = float(amount_str)
                currency = "USD" if "USD" in text or "US$" in text or "dólar" in text.lower() else "PEN"
                return amount, currency
            except ValueError:
                continue
    return None, "PEN"


def extract_operation_code(text: str) -> str | None:
    """Extract operation/transaction code."""
    for pattern in OPERATION_PATTERNS:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return None


def extract_date(text: str) -> str | None:
    """Extract date in YYYY-MM-DD format."""
    # Try numeric dates first
    match = re.search(DATE_PATTERNS[0], text)
    if match:
        day, month, year = match.group(1), match.group(2), match.group(3)
        if len(year) == 2:
            year = "20" + year
        if int(month) > 12:
            day, month = month, day
        return f"{year}-{int(month):02d}-{int(day):02d}"

    # Try text dates
    match = re.search(DATE_PATTERNS[1], text, re.IGNORECASE)
    if match:
        day = match.group(1)
        month = MONTH_MAP.get(match.group(2).lower(), "01")
        year = match.group(3)
        if len(year) == 2:
            year = "20" + year
        return f"{year}-{month}-{int(day):02d}"

    return None


def extract_time(text: str) -> str | None:
    """Extract time in HH:MM:SS format."""
    for pattern in TIME_PATTERNS:
        match = re.search(pattern, text)
        if match:
            time_str = match.group(1)
            if len(time_str) == 5:
                time_str += ":00"
            return time_str
    return None


def extract_phone(text: str) -> str | None:
    """Extract phone number."""
    for pattern in PHONE_PATTERNS:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return None


def extract_last4(text: str) -> str | None:
    """Extract last 4 digits of card/account."""
    for pattern in LAST4_PATTERNS:
        match = re.search(pattern, text)
        if match:
            return match.group(1)
    return None


def extract_names(text: str) -> tuple[str | None, str | None]:
    """Extract payer and receiver names. Returns (payer, receiver)."""
    names = []
    for pattern in NAME_PATTERNS:
        matches = re.findall(pattern, text)
        names.extend(matches)

    payer = names[0] if len(names) > 0 else None
    receiver = names[1] if len(names) > 1 else None
    return payer, receiver


def parse_receipt_ocr(image_path: str) -> dict:
    """Full OCR pipeline: extract text, then parse all fields.

    Returns dict with extracted data and confidence indicator.
    """
    text = extract_text(image_path)

    if len(text.strip()) < 10:
        logger.warning(f"OCR got very little text ({len(text.strip())} chars)")
        return {
            "es_recibo_valido": False,
            "imagen_legible": False,
            "ocr_confidence": "none",
            "raw_text": text,
        }

    bank = detect_bank(text)
    amount, currency = extract_amount(text)
    operation = extract_operation_code(text)
    date = extract_date(text)
    time = extract_time(text)
    phone = extract_phone(text)
    last4 = extract_last4(text)
    payer, receiver = extract_names(text)

    # Determine confidence
    has_bank = bank is not None
    has_amount = amount is not None
    has_operation = operation is not None

    if has_bank and has_amount and has_operation:
        confidence = "high"
    elif has_bank and has_amount:
        confidence = "medium"
    elif has_amount:
        confidence = "low"
    else:
        confidence = "none"

    is_valid = confidence in ("high", "medium")
    is_legible = len(text.strip()) > 30

    # Determine medio_pago
    medio_pago = None
    if bank in ("Yape", "Plin"):
        medio_pago = bank
    elif bank in ("Tarjeta",):
        medio_pago = "Tarjeta"
    elif bank:
        medio_pago = "Transferencia"

    result = {
        "es_recibo_valido": is_valid,
        "imagen_legible": is_legible,
        "ocr_confidence": confidence,
        "medio_pago": medio_pago,
        "banco": bank,
        "formato_comprobante": "captura_pantalla",
        "nombre_pagador": payer,
        "nombre_receptor": receiver,
        "monto": amount,
        "moneda": currency,
        "fecha": date,
        "hora": time,
        "codigo_operacion": operation,
        "ultimos_4_digitos": last4,
        "celular_emisor": phone,
        "raw_text": text[:500],
    }

    logger.info(
        f"OCR result: bank={bank}, amount={amount}, "
        f"operation={operation}, confidence={confidence}"
    )
    return result
