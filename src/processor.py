import json
import logging
import shutil
from pathlib import Path

import config
from src.database import is_duplicate, save_transaction
from src.vision import extract_receipt_data
from src.whatsapp_handler import send_message
from src.wisphub import WispHubClient

logger = logging.getLogger(__name__)

wisphub = WispHubClient()

# ---------------------------------------------------------------------------
# WhatsApp response messages
# ---------------------------------------------------------------------------

MSG_PAGO_EXITOSO = (
    "Tu pago fue verificado correctamente\n"
    "Monto recibido S/ {monto}\n"
    "Operacion {codigo}\n"
    "Tu servicio fue reactivado\n"
    "Gracias por tu pago"
)

MSG_MONTO_INCORRECTO = (
    "Detectamos tu comprobante pero el monto no coincide con tu deuda\n"
    "Deuda actual S/ {deuda_real}\n"
    "Monto enviado S/ {monto_imagen}\n"
    "Por favor revisa o comunicarte con soporte"
)

MSG_IMAGEN_ILEGIBLE = (
    "No se pudo validar tu comprobante\n"
    "Por favor envia una imagen mas clara donde se vea el monto y codigo de operacion"
)

MSG_RECIBO_INVALIDO = (
    "La imagen enviada no parece ser un comprobante de pago valido.\n"
    "Por favor envia una foto clara de tu boucher de pago."
)

MSG_DUPLICADO = (
    "El comprobante enviado ya fue utilizado o no es valido\n"
    "Si crees que es un error comunicarte con soporte"
)

MSG_CLIENTE_NO_ENCONTRADO = (
    "No pudimos encontrar tu cuenta asociada a este numero.\n"
    "Por favor comunicarte con soporte para verificar tu pago."
)

MSG_ERROR_REGISTRO = (
    "Hubo un error al registrar tu pago.\n"
    "Nuestro equipo lo revisara manualmente. Disculpa las molestias."
)


# ---------------------------------------------------------------------------
# Main processor
# ---------------------------------------------------------------------------

def process_receipt(image_path: str, phone_number: str) -> dict:
    """Full payment processing flow:

    1. Extract data from image (Claude Vision)
    2. Validate image quality and receipt validity
    3. Check for duplicate transactions
    4. Search client in WispHub
    5. Query pending debt
    6. Compare amount
    7. Register payment
    8. Send WhatsApp confirmation

    Returns JSON result dict for automation.
    """
    image_path = Path(image_path)
    logger.info(f"[{phone_number}] Processing receipt: {image_path.name}")

    # ── Step 1: Extract data from image ──────────────────────────────
    data = extract_receipt_data(str(image_path))
    logger.info(f"[{phone_number}] Extracted data: {json.dumps(data, ensure_ascii=False)}")

    # ── Step 2: Invalid receipt ──────────────────────────────────────
    if not data.get("es_recibo_valido"):
        logger.warning(f"[{phone_number}] Invalid receipt")
        _move_file(image_path, config.ERROR_DIR)
        send_message(phone_number, MSG_RECIBO_INVALIDO)
        return _build_result(data, accion="pedir_imagen", pago_valido=False)

    # ── Step 3: Blurry / unreadable image ────────────────────────────
    if not data.get("imagen_legible"):
        logger.warning(f"[{phone_number}] Unreadable image")
        _move_file(image_path, config.ERROR_DIR)
        send_message(phone_number, MSG_IMAGEN_ILEGIBLE)
        return _build_result(data, accion="pedir_imagen", pago_valido=False)

    # ── Step 4: Duplicate check ──────────────────────────────────────
    codigo_op = data.get("codigo_operacion")
    if codigo_op and is_duplicate(codigo_op):
        logger.warning(f"[{phone_number}] Duplicate transaction: {codigo_op}")
        _move_file(image_path, config.ERROR_DIR)
        send_message(phone_number, MSG_DUPLICADO)
        return _build_result(data, accion="comprobante_repetido", pago_valido=False)

    # ── Step 5: Search client in WispHub ─────────────────────────────
    nombre_pagador = data.get("nombre_pagador")
    cliente = wisphub.buscar_cliente(telefono=phone_number, nombre=nombre_pagador)

    if not cliente:
        logger.warning(f"[{phone_number}] Client not found in WispHub")
        _move_file(image_path, config.ERROR_DIR)
        send_message(phone_number, MSG_CLIENTE_NO_ENCONTRADO)
        return _build_result(data, accion="pedir_imagen", pago_valido=False, cliente_encontrado=False)

    cliente_id = cliente.get("id_servicio") or cliente.get("id")
    logger.info(f"[{phone_number}] Client found: {cliente.get('nombre')} (id={cliente_id})")

    # ── Step 6: Query pending debt ───────────────────────────────────
    deuda_info = wisphub.consultar_deuda(cliente_id)
    deuda_real = deuda_info.get("monto_deuda", 0.0)
    monto_imagen = float(data.get("monto") or 0)

    # ── Step 7: Compare amounts ──────────────────────────────────────
    if deuda_real > 0 and abs(monto_imagen - deuda_real) > 0.50:
        logger.warning(
            f"[{phone_number}] Amount mismatch: image={monto_imagen}, debt={deuda_real}"
        )
        send_message(
            phone_number,
            MSG_MONTO_INCORRECTO.format(deuda_real=deuda_real, monto_imagen=monto_imagen),
        )
        # Still save transaction for audit, but mark as mismatch
        save_transaction({
            **data,
            "telefono_cliente": phone_number,
            "imagen_archivo": image_path.name,
            "estado": "monto_incorrecto",
        })
        _move_file(image_path, config.ERROR_DIR)
        return _build_result(
            data, accion="monto_incorrecto", pago_valido=False,
            cliente_encontrado=True, deuda_real=deuda_real,
        )

    # ── Step 8: Register payment ─────────────────────────────────────
    pago_data = {
        "monto": monto_imagen,
        "fecha": data.get("fecha"),
        "medio_pago": data.get("medio_pago"),
        "codigo_operacion": codigo_op,
        "telefono_cliente": phone_number,
    }

    reg_result = wisphub.registrar_pago(cliente_id, pago_data)

    if not reg_result.get("success"):
        logger.error(f"[{phone_number}] Payment registration failed")
        send_message(phone_number, MSG_ERROR_REGISTRO)
        return _build_result(
            data, accion="registrar_pago", pago_valido=False,
            cliente_encontrado=True, deuda_real=deuda_real,
        )

    # Mark invoice as paid
    factura_id = deuda_info.get("factura_id")
    if factura_id:
        wisphub.marcar_factura_pagada(factura_id)

    # Save to local DB
    save_transaction({
        **data,
        "telefono_cliente": phone_number,
        "imagen_archivo": image_path.name,
        "estado": "registrado",
    })

    # Move image to processed
    _move_file(image_path, config.PROCESSED_DIR)

    # Send success message
    send_message(
        phone_number,
        MSG_PAGO_EXITOSO.format(monto=monto_imagen, codigo=codigo_op or "N/A"),
    )

    logger.info(f"[{phone_number}] Payment processed successfully: {codigo_op}")

    return _build_result(
        data, accion="registrar_pago", pago_valido=True,
        cliente_encontrado=True, deuda_real=deuda_real,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_result(
    data: dict,
    accion: str,
    pago_valido: bool,
    cliente_encontrado: bool = False,
    deuda_real: float = 0.0,
) -> dict:
    """Build the standardized JSON result for automation."""
    return {
        "medio_pago": data.get("medio_pago"),
        "banco": data.get("banco"),
        "monto": data.get("monto"),
        "fecha": data.get("fecha"),
        "hora": data.get("hora"),
        "codigo_operacion": data.get("codigo_operacion"),
        "nombre_pagador": data.get("nombre_pagador"),
        "moneda": data.get("moneda"),
        "cliente_encontrado": cliente_encontrado,
        "deuda_real": deuda_real,
        "pago_valido": pago_valido,
        "accion": accion,
    }


def _move_file(src: Path, dest_dir: Path) -> None:
    """Move a file to the destination directory."""
    try:
        dest = dest_dir / src.name
        shutil.move(str(src), str(dest))
        logger.info(f"Moved {src.name} -> {dest_dir.name}/")
    except OSError as e:
        logger.error(f"Failed to move {src.name}: {e}")
