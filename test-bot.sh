#!/bin/bash
# ─────────────────────────────────────────────────────────────
# test-bot.sh — Simulador de auditoría FiberPeru CRM
# Uso: ./test-bot.sh [phone]
# Ejemplo: ./test-bot.sh 51941073520
# Sin argumento: muestra resumen general de la BD
# ─────────────────────────────────────────────────────────────

BASE="http://localhost:3001"
EMAIL="admin@fiberperu.com"
PASS="Admin2024!"

echo "=================================="
echo " FiberPeru CRM — Test Bot"
echo "=================================="

# ── 1. Login ──────────────────────────────────────────────────
echo ""
echo "[1/3] Autenticando..."
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token') or d.get('data',{}).get('token','ERROR'))" 2>/dev/null)

if [ "$TOKEN" = "ERROR" ] || [ -z "$TOKEN" ]; then
  echo "ERROR: No se pudo obtener token. Verificar credenciales."
  exit 1
fi
echo "Token OK"

# ── 2. Sin argumento: resumen de BD ───────────────────────────
if [ -z "$1" ]; then
  echo ""
  echo "[2/3] Resumen general de la base de datos..."
  curl -s "$BASE/api/audit/db-summary" \
    -H "Authorization: Bearer $TOKEN" \
    | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('summary',{})
print('')
print('=== RESUMEN BD ===')
print(f'Conversaciones sin cliente vinculado : {s.get(\"conversations_no_client_id\",\"?\")}')
print(f'Pagos sin client_id                  : {s.get(\"orphan_payments_no_client_id\",\"?\")}')
print(f'Clientes sin plan_price              : {s.get(\"clients_without_plan_price\",\"?\")}')
print(f'Telefonos duplicados en clients      : {len(s.get(\"duplicate_phones_in_clients\",[]))}')
print('')
print('--- Conversaciones por estado ---')
for r in s.get('conversations_by_status',[]):
    print(f'  {r[\"status\"]}: {r[\"count\"]}')
print('')
print('--- Pagos por estado ---')
for r in s.get('payments_by_status',[]):
    print(f'  {r[\"status\"]}: {r[\"count\"]}')
print('')
print('--- Clientes por estado de servicio ---')
for r in s.get('clients_by_service_status',[]):
    print(f'  {r[\"service_status\"]}: {r[\"count\"]}')
print('')
print('Para simular un cliente especifico:')
print('  ./test-bot.sh 51XXXXXXXXX')
"
  exit 0
fi

# ── 3. Con phone: simulacion del cliente ──────────────────────
PHONE="$1"
echo ""
echo "[2/3] Simulando bot para: $PHONE"
echo ""

RESULT=$(curl -s "$BASE/api/audit/simulate?phone=$PHONE" \
  -H "Authorization: Bearer $TOKEN")

echo "$RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'):
    print('ERROR:', d.get('message','desconocido'))
    sys.exit(1)

s=d['simulate']

print('══════════════════════════════════════════')
print(' DATOS DEL CLIENTE EN CRM (PostgreSQL)')
print('══════════════════════════════════════════')
crm=s.get('crm_client') or {}
if crm:
    print(f'  Nombre en chat  : {crm.get(\"display_name\",\"—\")}')
    print(f'  Nombre WispHub  : {crm.get(\"name\",\"—\")}')
    print(f'  WispHub ID      : {crm.get(\"wisphub_id\",\"SIN VINCULAR\")}')
    print(f'  Plan            : {crm.get(\"plan\",\"—\")}')
    print(f'  Plan price BD   : S/ {crm.get(\"plan_price\",\"—\")}')
    print(f'  Estado servicio : {crm.get(\"service_status\",\"—\")}')
    print(f'  Estado conv.    : {crm.get(\"conv_status\",\"—\")}')
    print(f'  Nodo            : {crm.get(\"nodo\",\"—\")}')
else:
    print('  (sin conversacion registrada en CRM)')

print('')
print('══════════════════════════════════════════')
print(' DATOS EN WISPHUB')
print('══════════════════════════════════════════')
wh=s.get('wisphub_client') or {}
if wh:
    print(f'  Nombre real     : {wh.get(\"nombre\",\"—\")}')
    print(f'  ID servicio     : {wh.get(\"id_servicio\",\"—\")}')
    print(f'  Usuario         : {wh.get(\"usuario\",\"—\")}')
    print(f'  Estado          : {wh.get(\"estado\",\"—\")}')
    print(f'  Plan            : {wh.get(\"plan\",\"—\")}')
    print(f'  Precio plan WH  : S/ {wh.get(\"precio_plan\",\"—\")}')
    print(f'  Nodo            : {wh.get(\"nodo\",\"—\")}')
    print(f'  Celular         : {wh.get(\"celular\",\"—\")}')
else:
    print('  (no encontrado en WispHub por ese telefono)')

print('')
print('══════════════════════════════════════════')
print(' DEUDA / FACTURA (lógica real del bot)')
print('══════════════════════════════════════════')
deu=s.get('deuda') or {}
if deu:
    print(f'  Tiene deuda     : {deu.get(\"tiene_deuda\",\"—\")}')
    print(f'  Monto deuda     : S/ {deu.get(\"monto_deuda\",\"—\")}')
    print(f'  Cuota mensual   : S/ {deu.get(\"monto_mensual\",\"—\")}')
    print(f'  Factura ID      : {deu.get(\"factura_id\",\"fallback planPrice\")}')
    print(f'  Facturas total  : {deu.get(\"cantidad_facturas\",0)}')
else:
    print('  (no se pudo consultar — ver advertencias)')

print('')
print('══════════════════════════════════════════')
print(' LO QUE VERIA EL CLIENTE (preview bot)')
print('══════════════════════════════════════════')
bp=s.get('bot_preview',{})
print(f'  Nombre que usa  : {bp.get(\"nombre_que_ve_el_bot\",\"—\")}')
print(f'  Cuota que usa   : {bp.get(\"monto_que_validara_el_bot\",\"—\")}')
print(f'  Bienvenida      : {bp.get(\"mensaje_bienvenida\",\"—\")}')
print(f'  Msg cuota       : {bp.get(\"mensaje_cuota\",\"—\")}')

warns=s.get('warnings',[])
if warns:
    print('')
    print('══════════════════════════════════════════')
    print(' ADVERTENCIAS / PROBLEMAS DETECTADOS')
    print('══════════════════════════════════════════')
    for w in warns:
        print(f'  ⚠  {w}')
else:
    print('')
    print('  Todo OK - sin inconsistencias detectadas')

print('')
" 2>/dev/null

# ── 4. Pagos recientes del cliente ────────────────────────────
echo "[3/3] Últimos pagos del cliente en CRM..."
curl -s "$BASE/api/audit/client?phone=$PHONE" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
pays=(d.get('report',{}) or d).get('payments',{}).get('list',[])
if pays:
    print('')
    print('  ID pago          Monto   Estado         Fecha              Op#')
    print('  ──────────────────────────────────────────────────────────────')
    for p in pays[:5]:
        print(f'  {str(p.get(\"id\",\"\"))[:8]}...  S/{p.get(\"amount\",\"?\"):>6}  {str(p.get(\"status\",\"\")):14} {str(p.get(\"created_at\",\"\"))[:19]}  {p.get(\"operation_number\",\"—\")}')
else:
    print('  (sin pagos registrados)')
print('')
" 2>/dev/null

echo "=================================="
echo " Fin del test"
echo "=================================="
