import logging
import time

import requests

import config

logger = logging.getLogger(__name__)


class WispHubClient:
    """Client for WispHub CRM API (api.wisphub.app).

    Handles: client lookup, debt queries, payment registration.
    Base URL: https://api.wisphub.app/api
    Auth: Token header
    """

    MAX_RETRIES = 3
    BACKOFF_BASE = 2

    def __init__(self):
        self.base_url = config.WISPHUB_API_URL.rstrip("/")
        self.company_id = config.WISPHUB_COMPANY_ID
        self.headers = {
            "Authorization": f"Api-Key {config.WISPHUB_API_TOKEN}",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, endpoint: str, **kwargs) -> dict | None:
        """Make an API request with retries.

        endpoint should start with / (e.g. /clientes/)
        Final URL = base_url + endpoint
        """
        url = f"{self.base_url}{endpoint}"

        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                logger.info(f"WispHub {method} {url} (attempt {attempt})")
                resp = requests.request(
                    method, url,
                    headers=self.headers,
                    timeout=30,
                    **kwargs,
                )
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as e:
                logger.warning(f"WispHub attempt {attempt} failed: {e}")
                if attempt < self.MAX_RETRIES:
                    time.sleep(self.BACKOFF_BASE ** attempt)

        logger.error(f"WispHub request failed after {self.MAX_RETRIES} attempts: {url}")
        return None

    # ------------------------------------------------------------------
    # Client lookup
    # ------------------------------------------------------------------

    def buscar_cliente_por_telefono(self, telefono: str) -> dict | None:
        """Search for a client by phone number."""
        data = self._request("GET", "/clientes/", params={"celular": telefono})
        if data and data.get("results"):
            cliente = data["results"][0]
            logger.info(f"Client found by phone {telefono}: {cliente.get('nombre')}")
            return cliente
        logger.info(f"No client found for phone {telefono}")
        return None

    def buscar_cliente_por_nombre(self, nombre: str) -> dict | None:
        """Search for a client by name."""
        data = self._request("GET", "/clientes/", params={"search": nombre})
        if data and data.get("results"):
            cliente = data["results"][0]
            logger.info(f"Client found by name '{nombre}': {cliente.get('id')}")
            return cliente
        return None

    def buscar_cliente_por_codigo(self, codigo: str) -> dict | None:
        """Search for a client by client code/ID."""
        data = self._request("GET", f"/clientes/{codigo}/")
        if data and data.get("id"):
            logger.info(f"Client found by code {codigo}: {data.get('nombre')}")
            return data
        return None

    def buscar_cliente(self, telefono: str = None, nombre: str = None) -> dict | None:
        """Try to find a client by phone first, then by name."""
        if telefono:
            cliente = self.buscar_cliente_por_telefono(telefono)
            if cliente:
                return cliente

        if nombre:
            cliente = self.buscar_cliente_por_nombre(nombre)
            if cliente:
                return cliente

        return None

    # ------------------------------------------------------------------
    # Debt queries
    # ------------------------------------------------------------------

    def consultar_deuda(self, cliente_id: int) -> dict:
        """Get pending debt for a client.

        Returns: {"tiene_deuda": bool, "monto_deuda": float, "factura_id": int|None}
        """
        data = self._request(
            "GET", f"/clientes/{cliente_id}/facturas/",
            params={"estado": "pendiente"},
        )

        if not data or not data.get("results"):
            logger.info(f"No pending invoices for client {cliente_id}")
            return {"tiene_deuda": False, "monto_deuda": 0.0, "factura_id": None}

        facturas = data["results"]
        monto_total = sum(float(f.get("total", 0)) for f in facturas)
        factura_id = facturas[0].get("id")

        logger.info(f"Client {cliente_id} has debt: S/ {monto_total}, invoice #{factura_id}")
        return {
            "tiene_deuda": True,
            "monto_deuda": round(monto_total, 2),
            "factura_id": factura_id,
            "facturas": facturas,
        }

    # ------------------------------------------------------------------
    # Payment registration
    # ------------------------------------------------------------------

    def registrar_pago(self, cliente_id: int, data: dict) -> dict:
        """Register a payment in WispHub."""
        payload = {
            "cliente": cliente_id,
            "monto": data.get("monto"),
            "fecha_pago": data.get("fecha"),
            "medio_pago": data.get("medio_pago"),
            "codigo_operacion": data.get("codigo_operacion"),
            "observacion": (
                f"Pago automatico - {data.get('medio_pago', '')} "
                f"- Op: {data.get('codigo_operacion', '')} "
                f"- Tel: {data.get('telefono_cliente', '')}"
            ),
        }

        result = self._request("POST", "/pagos/", json=payload)

        if result:
            logger.info(f"Payment registered for client {cliente_id}: {data.get('codigo_operacion')}")
            return {"success": True, "response": result}

        return {"success": False, "error": "No se pudo registrar el pago en WispHub"}

    def marcar_factura_pagada(self, factura_id: int) -> bool:
        """Mark an invoice as paid."""
        result = self._request("PATCH", f"/facturas/{factura_id}/", json={"estado": "pagada"})
        if result:
            logger.info(f"Invoice {factura_id} marked as paid")
            return True
        logger.error(f"Failed to mark invoice {factura_id} as paid")
        return False
