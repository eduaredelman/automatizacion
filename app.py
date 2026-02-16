import logging
from flask import Flask, request, jsonify

import config
from src.whatsapp_handler import verify_webhook, process_webhook, download_media, send_message
from src.processor import process_receipt

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
    handlers=[
        logging.FileHandler(config.LOGS_DIR / "payments.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

app = Flask(__name__)


@app.route("/webhook", methods=["GET"])
def webhook_verify():
    """Meta webhook verification endpoint."""
    body, status = verify_webhook(request.args.to_dict())
    return body, status


@app.route("/webhook", methods=["POST"])
def webhook_receive():
    """Receive incoming WhatsApp messages."""
    payload = request.get_json()
    if not payload:
        return jsonify({"error": "No payload"}), 400

    message = process_webhook(payload)
    if not message:
        return jsonify({"status": "no_message"}), 200

    phone = message["phone"]
    msg_type = message["type"]

    if msg_type == "image":
        file_path = download_media(message["media_id"])
        if not file_path:
            send_message(phone, "No se pudo descargar la imagen. Intenta enviarla nuevamente.")
            return jsonify({"status": "download_failed"}), 200

        result = process_receipt(file_path, phone)
        logger.info(f"Receipt result for {phone}: accion={result.get('accion')}, valido={result.get('pago_valido')}")
        return jsonify({"status": "processed", "result": result}), 200

    elif msg_type == "text":
        send_message(
            phone,
            "Hola! Soy el asistente de pagos.\n"
            "Envia una foto de tu boucher de pago y lo verificare automaticamente.",
        )

    else:
        send_message(
            phone,
            "Solo puedo procesar imagenes de comprobantes de pago. "
            "Por favor envia una foto de tu recibo.",
        )

    return jsonify({"status": "ok"}), 200


@app.route("/health", methods=["GET"])
def health():
    """Health check."""
    return jsonify({"status": "ok", "service": "payment-processor"}), 200


@app.route("/debug/client/<phone>", methods=["GET"])
def debug_client(phone):
    """Debug: look up client by phone and show raw WispHub data."""
    from src.wisphub import WispHubClient
    client = WispHubClient()
    data = client._request("GET", "/clientes/", params={"celular": phone})
    return jsonify({"raw_response": data}), 200


if __name__ == "__main__":
    logger.info("Starting Payment Processor...")
    app.run(host="0.0.0.0", port=8085, debug=True)
