"""
Python OCR Microservice - FiberPeru Payment Voucher Analyzer
Exposes REST API for the Node.js backend to call
"""
import os
import sys
import json
import logging
from flask import Flask, request, jsonify
from werkzeug.utils import secure_filename
import tempfile

# Add parent directory to path to reuse existing modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from src.ocr_parser import extract_payment_data
    from src.vision import analyze_image
    OCR_AVAILABLE = True
except ImportError as e:
    logging.warning(f"OCR modules not available: {e}")
    OCR_AVAILABLE = False

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 15 * 1024 * 1024  # 15MB max

ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'}


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'service': 'python-ocr',
        'ocr_available': OCR_AVAILABLE,
        'version': '2.0.0',
    })


@app.route('/analyze', methods=['POST'])
def analyze():
    """
    Receive an image file and return extracted payment data.
    Accepts multipart/form-data with 'image' field.
    """
    if 'image' not in request.files:
        return jsonify({'error': 'No image file provided'}), 400

    file = request.files['image']

    if not file.filename or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type'}), 400

    if not OCR_AVAILABLE:
        return jsonify({
            'error': 'OCR service not available',
            'confidence': 'none',
        }), 503

    # Save to temp file
    suffix = '.' + secure_filename(file.filename).rsplit('.', 1)[-1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        file.save(tmp.name)
        temp_path = tmp.name

    try:
        logger.info(f"Analyzing image: {file.filename}")
        result = analyze_image(temp_path)

        if result is None:
            return jsonify({'confidence': 'none', 'extraction_method': 'failed'})

        # Normalize output
        return jsonify({
            'confidence':        result.get('confidence', 'none'),
            'extraction_method': result.get('extraction_method', 'ocr'),
            'bank':              result.get('bank') or result.get('medio_pago'),
            'medio_pago':        result.get('banco') or result.get('bank'),
            'monto':             result.get('monto'),
            'moneda':            result.get('moneda', 'PEN'),
            'codigo_operacion':  result.get('codigo_operacion'),
            'fecha':             result.get('fecha'),
            'hora':              result.get('hora'),
            'nombre_pagador':    result.get('nombre_pagador'),
            'nombre_receptor':   result.get('nombre_receptor'),
            'telefono':          result.get('telefono'),
            'ultimos_digitos':   result.get('ultimos_digitos'),
            'raw_text':          result.get('texto_raw', ''),
        })

    except Exception as e:
        logger.error(f"OCR analysis failed: {e}", exc_info=True)
        return jsonify({
            'confidence': 'none',
            'error': str(e),
        }), 500
    finally:
        try:
            os.unlink(temp_path)
        except Exception:
            pass


@app.route('/analyze/base64', methods=['POST'])
def analyze_base64():
    """Alternative: receive base64 encoded image"""
    import base64
    data = request.get_json()
    if not data or 'image' not in data:
        return jsonify({'error': 'No image data'}), 400

    try:
        image_data = base64.b64decode(data['image'])
        ext = data.get('ext', 'jpg')
        with tempfile.NamedTemporaryFile(suffix=f'.{ext}', delete=False) as tmp:
            tmp.write(image_data)
            temp_path = tmp.name

        result = analyze_image(temp_path)
        os.unlink(temp_path)

        return jsonify(result or {'confidence': 'none'})
    except Exception as e:
        logger.error(f"Base64 analysis failed: {e}")
        return jsonify({'confidence': 'none', 'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8085))
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    logger.info(f"Starting Python OCR microservice on port {port}")
    app.run(host='0.0.0.0', port=port, debug=debug)
