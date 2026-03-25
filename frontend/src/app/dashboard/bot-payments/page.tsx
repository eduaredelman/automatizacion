'use client';
import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  Download, Eye, RefreshCw, DollarSign, FileCheck,
  Users, AlertTriangle, CheckCircle2, Send, MessageSquare,
  TrendingUp, X, BarChart2, ChevronRight, Calendar,
} from 'lucide-react';
import clsx from 'clsx';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const MESES = [
  { value: 1,  label: 'Enero' },   { value: 2,  label: 'Febrero' },
  { value: 3,  label: 'Marzo' },   { value: 4,  label: 'Abril' },
  { value: 5,  label: 'Mayo' },    { value: 6,  label: 'Junio' },
  { value: 7,  label: 'Julio' },   { value: 8,  label: 'Agosto' },
  { value: 9,  label: 'Septiembre' }, { value: 10, label: 'Octubre' },
  { value: 11, label: 'Noviembre' }, { value: 12, label: 'Diciembre' },
];

const METHOD_ICONS: Record<string, string> = {
  yape: '💜', plin: '💛', bcp: '💙', interbank: '🟢',
  bbva: '🔵', scotiabank: '🔴', transfer: '🏦', unknown: '💳',
};

const DEFAULT_MENSAJE =
  'Estimado/a {nombre}, le recordamos que su pago mensual de {precio} se encuentra pendiente.\n\nPor favor realice su pago para evitar inconvenientes con su servicio. 🙏\n\n_Fiber Perú_';

// ─── Types ───────────────────────────────────────────────────
interface BotPayment {
  id: string; nombre_cliente: string; telefono_cliente: string | null;
  amount: number | null; payment_method: string | null;
  payment_date: string | null; validated_at: string | null;
  created_at: string; operation_code: string | null;
  voucher_url: string | null; factura_id: string | null;
  registered_wisphub: boolean; mes: number; ano: number;
}

interface ClienteMes {
  id: string; wisphub_id: string; name: string; phone: string;
  plan: string | null; plan_price: number | null;
  service_status: string; monto_pagado: number | null;
  estado_pago: 'pagado' | 'pendiente';
}

interface SummaryMes {
  total_clientes: number; pagados: number;
  pendientes: number; total_recaudado: number;
}

type TabId = 'pagos' | 'control' | 'historial';
type EstadoFilter = '' | 'pagado' | 'pendiente';

interface MesKey { key: string; label: string; }

interface ClienteMatriz {
  id: string; wisphub_id: string; name: string; phone: string;
  plan: string | null; plan_price: number | null;
  pagos: Record<string, { estado: 'pagado' | 'pendiente'; monto: number }>;
  meses_pagados: number; meses_pendientes: number;
  deuda_actual: number; deudas_anteriores: number; al_dia: boolean;
}

interface PagoHistorial {
  id: string; amount: number; payment_method: string | null;
  payment_date: string | null; validated_at: string | null;
  created_at: string; operation_code: string | null;
  status: string; notes: string | null;
}

// ─── Component ───────────────────────────────────────────────
export default function BotPaymentsPage() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = Array.from({ length: 3 }, (_, i) => currentYear - i);

  // Tab activo
  const [tab, setTab] = useState<TabId>('pagos');

  // Filtros compartidos (mes/año)
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [ano, setAno] = useState(currentYear);

  // ── Tab 1: Pagos WhatsApp ──────────────────────────────────
  const [payments, setPayments]       = useState<BotPayment[]>([]);
  const [pagoTotal, setPagoTotal]     = useState(0);
  const [pagoAmount, setPagoAmount]   = useState(0);
  const [loadingPagos, setLoadingPagos] = useState(true);
  const [preview, setPreview]         = useState<string | null>(null);

  // ── Tab 2: Control Mensual ─────────────────────────────────
  const [clientes, setClientes]         = useState<ClienteMes[]>([]);
  const [summary, setSummary]           = useState<SummaryMes | null>(null);
  const [estadoFilter, setEstadoFilter] = useState<EstadoFilter>('');
  const [loadingControl, setLoadingControl] = useState(false);
  const [mesNombreCtrl, setMesNombreCtrl] = useState('');

  // ── Tab 3: Historial / Matriz ─────────────────────────────
  const [mesesRango, setMesesRango]       = useState(6);
  const [matrizClientes, setMatrizClientes] = useState<ClienteMatriz[]>([]);
  const [matrizMeses, setMatrizMeses]     = useState<MesKey[]>([]);
  const [loadingMatriz, setLoadingMatriz] = useState(false);
  const [selectedCliente, setSelectedCliente] = useState<ClienteMatriz | null>(null);
  const [historialPagos, setHistorialPagos] = useState<PagoHistorial[]>([]);
  const [loadingHistorial, setLoadingHistorial] = useState(false);
  const [showHistorialModal, setShowHistorialModal] = useState(false);

  // Envío masivo
  const [enviando, setEnviando]         = useState(false);
  const [envioResult, setEnvioResult]   = useState<string | null>(null);
  const [showConfirm, setShowConfirm]   = useState(false);
  const [mensaje, setMensaje]           = useState(DEFAULT_MENSAJE);
  const [showMsgEditor, setShowMsgEditor] = useState(false);

  // ── Fetch: pagos WhatsApp ──────────────────────────────────
  const fetchPayments = useCallback(async () => {
    setLoadingPagos(true);
    try {
      const { data } = await api.getBotPayments({ mes, ano, limit: 100 });
      setPayments(data.data?.payments ?? []);
      setPagoTotal(data.data?.total ?? 0);
      setPagoAmount(data.data?.total_amount ?? 0);
    } catch { setPayments([]); }
    finally { setLoadingPagos(false); }
  }, [mes, ano]);

  // ── Fetch: control mensual ─────────────────────────────────
  const fetchControl = useCallback(async (estado?: EstadoFilter) => {
    setLoadingControl(true);
    setEnvioResult(null);
    try {
      const f = estado !== undefined ? estado : estadoFilter;
      const { data } = await api.getClientesMes({ mes, ano, estado: f, limit: 500 });
      setClientes(data.data?.clientes ?? []);
      setSummary(data.data?.summary ?? null);
      setMesNombreCtrl(data.data?.mes_nombre ?? '');
    } catch { setClientes([]); setSummary(null); }
    finally { setLoadingControl(false); }
  }, [mes, ano, estadoFilter]);

  // ── Fetch: matriz histórica ────────────────────────────────
  const fetchMatriz = useCallback(async (rango?: number) => {
    setLoadingMatriz(true);
    try {
      const meses = rango ?? mesesRango;
      const { data } = await api.getMatrizPagos({ meses });
      setMatrizClientes(data.data?.clientes ?? []);
      setMatrizMeses(data.data?.meses ?? []);
    } catch { setMatrizClientes([]); setMatrizMeses([]); }
    finally { setLoadingMatriz(false); }
  }, [mesesRango]);

  const fetchHistorialCliente = async (clientId: string) => {
    setLoadingHistorial(true);
    setHistorialPagos([]);
    try {
      const { data } = await api.getHistorialCliente(clientId);
      setHistorialPagos(data.data?.payments ?? []);
    } catch { setHistorialPagos([]); }
    finally { setLoadingHistorial(false); }
  };

  const handleOpenHistorial = (c: ClienteMatriz) => {
    setSelectedCliente(c);
    setShowHistorialModal(true);
    fetchHistorialCliente(c.id);
  };

  // Cargar según tab activo
  useEffect(() => {
    if (tab === 'pagos')    fetchPayments();
    if (tab === 'control')  fetchControl();
    if (tab === 'historial') fetchMatriz();
  }, [tab, mes, ano]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === 'historial') fetchMatriz(mesesRango);
  }, [mesesRango]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Cambiar filtro estado ──────────────────────────────────
  const handleEstadoFilter = (v: EstadoFilter) => {
    setEstadoFilter(v);
    fetchControl(v);
  };

  // ── Enviar mensajes a deudores ─────────────────────────────
  const handleEnviarDeudores = async () => {
    setShowConfirm(false);
    setEnviando(true);
    setEnvioResult(null);
    try {
      const { data } = await api.sendMensajeDeudores({ mes, ano, mensaje });
      setEnvioResult(data.message ?? 'Mensajes enviados.');
      fetchControl(); // Refrescar lista
    } catch { setEnvioResult('Error al enviar mensajes. Intenta de nuevo.'); }
    finally { setEnviando(false); }
  };

  // ── Helpers ────────────────────────────────────────────────
  const mesNombre = MESES.find(m => m.value === mes)?.label ?? '';

  const voucherUrl = (url: string | null) => {
    if (!url) return null;
    return url.startsWith('http') ? url : `${API_BASE}${url}`;
  };

  const formatFecha = (p: BotPayment) => {
    const raw = p.payment_date || p.validated_at || p.created_at;
    try { return format(new Date(raw), 'dd/MM/yyyy', { locale: es }); }
    catch { return raw ?? '-'; }
  };

  const deudoresCount = summary?.pendientes ?? 0;

  // ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-[#080f1e] text-white overflow-hidden">

      {/* ── Header ── */}
      <div className="px-6 pt-5 pb-0 border-b border-slate-800/60">
        <div className="flex items-center justify-between gap-4 flex-wrap pb-4">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <FileCheck className="w-5 h-5 text-emerald-400" />
              Pagos del Bot
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Pagos registrados automáticamente por WhatsApp
            </p>
          </div>

          {/* Filtros mes/año */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={mes} onChange={e => setMes(Number(e.target.value))}
              className="bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            >
              {MESES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <select
              value={ano} onChange={e => setAno(Number(e.target.value))}
              className="bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            >
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          {([
            { id: 'pagos',    label: 'Pagos WhatsApp',  icon: FileCheck },
            { id: 'control',  label: 'Control Mensual', icon: Users },
            { id: 'historial', label: 'Historial',      icon: BarChart2 },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-xl border-b-2 transition-all',
                tab === id
                  ? 'border-emerald-400 text-emerald-300 bg-emerald-500/5'
                  : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-800/30'
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
              {id === 'control' && deudoresCount > 0 && tab !== 'control' && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                  {deudoresCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          TAB 1: PAGOS WHATSAPP
      ══════════════════════════════════════════════════════ */}
      {tab === 'pagos' && (
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Acciones */}
          <div className="px-6 pt-4 flex items-center gap-2 flex-wrap">
            <button
              onClick={fetchPayments}
              className="p-2 rounded-xl bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-white transition-all"
            >
              <RefreshCw className={clsx('w-4 h-4', loadingPagos && 'animate-spin')} />
            </button>
          </div>

          {/* KPIs */}
          <div className="px-6 py-4 grid grid-cols-2 gap-4">
            <KpiCard icon={<FileCheck className="w-5 h-5 text-emerald-400" />}
              color="emerald" label={`Pagos en ${mesNombre} ${ano}`} value={String(pagoTotal)} />
            <KpiCard icon={<DollarSign className="w-5 h-5 text-blue-400" />}
              color="blue" label="Total recaudado" value={`S/ ${pagoAmount.toFixed(2)}`} />
          </div>

          {/* Tabla */}
          <div className="flex-1 overflow-auto px-6 pb-6">
            {loadingPagos ? (
              <LoadingSpinner text="Cargando pagos..." />
            ) : payments.length === 0 ? (
              <EmptyState icon={<FileCheck className="w-8 h-8" />}
                text={`No hay pagos registrados en ${mesNombre} ${ano}`} />
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-800/60">
                    {['Cliente', 'Teléfono', 'Método', 'Monto', 'Fecha', 'Comprobante'].map(h => (
                      <th key={h} className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wider pb-3 pr-4">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id} className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
                      <td className="py-3 pr-4 font-medium text-white">{p.nombre_cliente}</td>
                      <td className="py-3 pr-4 text-slate-300 font-mono text-xs">{p.telefono_cliente ?? '-'}</td>
                      <td className="py-3 pr-4">
                        {p.payment_method ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-slate-700/50 text-xs font-medium text-slate-200">
                            {METHOD_ICONS[p.payment_method] ?? '💳'} {p.payment_method.toUpperCase()}
                          </span>
                        ) : '-'}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="text-emerald-400 font-bold">S/ {Number(p.amount ?? 0).toFixed(2)}</span>
                      </td>
                      <td className="py-3 pr-4 text-slate-300 text-xs">{formatFecha(p)}</td>
                      <td className="py-3">
                        {voucherUrl(p.voucher_url) ? (
                          <div className="flex items-center gap-2">
                            <button onClick={() => setPreview(voucherUrl(p.voucher_url)!)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 transition-all">
                              <Eye className="w-4 h-4" />
                            </button>
                            <a href={voucherUrl(p.voucher_url)!} download target="_blank" rel="noreferrer"
                              className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all">
                              <Download className="w-4 h-4" />
                            </a>
                          </div>
                        ) : <span className="text-slate-600 text-xs">Sin imagen</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB 2: CONTROL MENSUAL
      ══════════════════════════════════════════════════════ */}
      {tab === 'control' && (
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* KPIs */}
          <div className="px-6 pt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard icon={<Users className="w-5 h-5 text-slate-400" />}
              color="slate" label="Total clientes" value={String(summary?.total_clientes ?? '—')} />
            <KpiCard icon={<CheckCircle2 className="w-5 h-5 text-emerald-400" />}
              color="emerald" label="Pagados" value={String(summary?.pagados ?? '—')} />
            <KpiCard icon={<AlertTriangle className="w-5 h-5 text-red-400" />}
              color="red" label="Deudores" value={String(summary?.pendientes ?? '—')} />
            <KpiCard icon={<TrendingUp className="w-5 h-5 text-blue-400" />}
              color="blue" label="Recaudado" value={summary ? `S/ ${summary.total_recaudado.toFixed(2)}` : '—'} />
          </div>

          {/* Controles */}
          <div className="px-6 py-3 flex items-center justify-between gap-3 flex-wrap">

            {/* Filtros estado */}
            <div className="flex items-center gap-1">
              {([
                { v: '' as EstadoFilter,          l: 'Todos' },
                { v: 'pagado' as EstadoFilter,    l: 'Pagados' },
                { v: 'pendiente' as EstadoFilter, l: 'Deudores' },
              ]).map(({ v, l }) => (
                <button key={v} onClick={() => handleEstadoFilter(v)}
                  className={clsx(
                    'px-3 py-1.5 rounded-xl text-xs font-medium transition-all border',
                    estadoFilter === v
                      ? v === 'pendiente'
                        ? 'bg-red-500/20 text-red-300 border-red-500/40'
                        : v === 'pagado'
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                          : 'bg-slate-700/60 text-white border-slate-600/60'
                      : 'text-slate-500 border-transparent hover:text-slate-300 hover:bg-slate-800/50'
                  )}
                >
                  {l}
                  {v === 'pendiente' && deudoresCount > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-500/30 text-red-300">
                      {deudoresCount}
                    </span>
                  )}
                </button>
              ))}
              <button onClick={() => fetchControl()} disabled={loadingControl}
                className="p-1.5 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800/50 transition-all ml-1">
                <RefreshCw className={clsx('w-3.5 h-3.5', loadingControl && 'animate-spin')} />
              </button>
            </div>

            {/* Botón enviar deudores */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowMsgEditor(v => !v)}
                title="Editar mensaje"
                className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800/50 transition-all border border-transparent hover:border-slate-700/50"
              >
                <MessageSquare className="w-4 h-4" />
              </button>
              <button
                onClick={() => { setShowConfirm(true); setEnvioResult(null); }}
                disabled={enviando || deudoresCount === 0}
                className={clsx(
                  'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition-all',
                  deudoresCount > 0 && !enviando
                    ? 'bg-red-500/15 text-red-300 border-red-500/40 hover:bg-red-500/25 hover:border-red-500/60'
                    : 'bg-slate-800/40 text-slate-600 border-slate-700/30 cursor-not-allowed'
                )}
              >
                {enviando
                  ? <><RefreshCw className="w-4 h-4 animate-spin" /> Enviando...</>
                  : <><Send className="w-4 h-4" /> Enviar a {deudoresCount} deudores</>}
              </button>
            </div>
          </div>

          {/* Editor de mensaje */}
          {showMsgEditor && (
            <div className="mx-6 mb-3 p-4 rounded-2xl bg-slate-900/60 border border-slate-700/50">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-400 font-medium">Mensaje personalizado · usa <code className="text-emerald-400">&#123;nombre&#125;</code> y <code className="text-emerald-400">&#123;precio&#125;</code></p>
                <button onClick={() => setMensaje(DEFAULT_MENSAJE)}
                  className="text-xs text-slate-600 hover:text-slate-400 transition-all">Restablecer</button>
              </div>
              <textarea
                value={mensaje} onChange={e => setMensaje(e.target.value)} rows={4}
                className="w-full bg-slate-800/60 border border-slate-700/40 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 resize-none focus:outline-none focus:border-emerald-500/50"
              />
            </div>
          )}

          {/* Resultado envío */}
          {envioResult && (
            <div className={clsx(
              'mx-6 mb-2 px-4 py-2.5 rounded-xl text-sm flex items-center justify-between',
              envioResult.includes('Error')
                ? 'bg-red-500/10 border border-red-500/20 text-red-300'
                : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
            )}>
              <span>{envioResult}</span>
              <button onClick={() => setEnvioResult(null)} className="ml-4 opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
            </div>
          )}

          {/* Tabla clientes */}
          <div className="flex-1 overflow-auto px-6 pb-6">
            {loadingControl ? (
              <LoadingSpinner text="Cargando clientes..." />
            ) : clientes.length === 0 ? (
              <EmptyState
                icon={<Users className="w-8 h-8" />}
                text={estadoFilter === 'pendiente'
                  ? `¡Sin deudores en ${mesNombreCtrl} ${ano}! Todos al día. ✅`
                  : estadoFilter === 'pagado'
                    ? `Sin pagos registrados en ${mesNombreCtrl} ${ano}`
                    : `Sin clientes sincronizados. Usa "Sincronizar" en Contactos.`}
              />
            ) : (
              <div className="rounded-2xl border border-slate-700/40 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800/60 bg-slate-900/50">
                      {['Nombre', 'Teléfono', 'Plan', 'Precio/Mes', 'Estado', 'Monto Pagado'].map(h => (
                        <th key={h} className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {clientes.map(c => (
                      <tr key={c.id} className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-medium text-white truncate max-w-[180px]">{c.name}</p>
                          <p className="text-[11px] text-slate-600 font-mono">{c.wisphub_id}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-300 font-mono text-xs">{c.phone || '—'}</td>
                        <td className="px-4 py-3">
                          <p className="text-sm text-slate-300 truncate max-w-[140px]">{c.plan || '—'}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm font-semibold text-white">
                            {c.plan_price != null ? `S/ ${parseFloat(String(c.plan_price)).toFixed(2)}` : '—'}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          {c.estado_pago === 'pagado' ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <CheckCircle2 className="w-3 h-3" /> Pagado
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
                              <AlertTriangle className="w-3 h-3" /> Pendiente
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {c.monto_pagado != null
                            ? <span className="text-emerald-400 font-semibold">S/ {Number(c.monto_pagado).toFixed(2)}</span>
                            : <span className="text-slate-600 text-xs">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          TAB 3: HISTORIAL / MATRIZ
      ══════════════════════════════════════════════════════ */}
      {tab === 'historial' && (
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Controles rango */}
          <div className="px-6 pt-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-500" />
              <span className="text-sm text-slate-400">Rango:</span>
              {([3, 6, 12] as const).map(r => (
                <button
                  key={r}
                  onClick={() => setMesesRango(r)}
                  className={clsx(
                    'px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all',
                    mesesRango === r
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'text-slate-500 border-transparent hover:text-slate-300 hover:bg-slate-800/50'
                  )}
                >
                  {r} meses
                </button>
              ))}
            </div>
            <button
              onClick={() => fetchMatriz()}
              disabled={loadingMatriz}
              className="p-1.5 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800/50 transition-all border border-transparent hover:border-slate-700/50"
            >
              <RefreshCw className={clsx('w-4 h-4', loadingMatriz && 'animate-spin')} />
            </button>
          </div>

          {/* Leyenda */}
          <div className="px-6 pt-2 flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="w-3 h-3 rounded-sm bg-emerald-500/30 border border-emerald-500/50 inline-block" />
              Pagado
            </span>
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="w-3 h-3 rounded-sm bg-red-500/30 border border-red-500/50 inline-block" />
              Pendiente
            </span>
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="w-3 h-3 rounded-sm bg-slate-700/60 border border-slate-600/50 inline-block" />
              Sin datos
            </span>
          </div>

          {/* Tabla matriz */}
          <div className="flex-1 overflow-auto px-6 pb-6 mt-3">
            {loadingMatriz ? (
              <LoadingSpinner text="Cargando historial..." />
            ) : matrizClientes.length === 0 ? (
              <EmptyState icon={<BarChart2 className="w-8 h-8" />}
                text="No hay datos de clientes. Sincroniza contactos primero." />
            ) : (
              <div className="rounded-2xl border border-slate-700/40 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800/60 bg-slate-900/60">
                        {/* Client column */}
                        <th className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3 sticky left-0 bg-slate-900/90 z-10 min-w-[180px]">
                          Cliente
                        </th>
                        {/* Month columns */}
                        {matrizMeses.map(m => (
                          <th key={m.key} className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wider px-3 py-3 min-w-[100px]">
                            {m.label}
                          </th>
                        ))}
                        {/* Summary columns */}
                        <th className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wider px-3 py-3 min-w-[80px]">Pagados</th>
                        <th className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wider px-3 py-3 min-w-[80px]">Deuda</th>
                        <th className="text-center text-xs font-semibold text-slate-400 uppercase tracking-wider px-3 py-3 min-w-[60px]"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {matrizClientes.map((c, idx) => (
                        <tr
                          key={c.id}
                          onClick={() => handleOpenHistorial(c)}
                          className={clsx(
                            'border-b border-slate-800/30 cursor-pointer transition-colors group',
                            idx % 2 === 0 ? 'bg-transparent' : 'bg-slate-900/20',
                            'hover:bg-slate-800/40'
                          )}
                        >
                          {/* Client info */}
                          <td className="px-4 py-3 sticky left-0 bg-inherit z-10 group-hover:bg-slate-800/40">
                            <p className="font-medium text-white truncate max-w-[160px] text-sm">{c.name}</p>
                            <p className="text-[10px] text-slate-600 font-mono mt-0.5">{c.wisphub_id}</p>
                          </td>
                          {/* Month cells */}
                          {matrizMeses.map(m => {
                            const p = c.pagos?.[m.key];
                            if (!p) {
                              return (
                                <td key={m.key} className="px-3 py-3 text-center">
                                  <span className="inline-flex items-center justify-center w-full">
                                    <span className="text-slate-700 text-xs">—</span>
                                  </span>
                                </td>
                              );
                            }
                            const isPaid = p.estado === 'pagado';
                            return (
                              <td key={m.key} className="px-3 py-3 text-center">
                                <span className={clsx(
                                  'inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border',
                                  isPaid
                                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                    : 'bg-red-500/15 text-red-400 border-red-500/30'
                                )}>
                                  {isPaid ? '✓' : '✗'}
                                  {isPaid && p.monto > 0 && (
                                    <span className="hidden sm:inline text-[10px] opacity-75">
                                      {p.monto.toFixed(0)}
                                    </span>
                                  )}
                                </span>
                              </td>
                            );
                          })}
                          {/* Summary */}
                          <td className="px-3 py-3 text-center">
                            <span className="text-emerald-400 text-xs font-semibold">{c.meses_pagados}</span>
                            <span className="text-slate-600 text-xs">/{mesesRango}</span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            {(c.deuda_actual + c.deudas_anteriores) > 0 ? (
                              <span className="text-red-400 text-xs font-semibold">
                                S/{(c.deuda_actual + c.deudas_anteriores).toFixed(0)}
                              </span>
                            ) : (
                              <span className="text-emerald-400 text-xs">✓</span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <ChevronRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-400 transition-colors mx-auto" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modal: Historial de cliente ── */}
      {showHistorialModal && selectedCliente && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowHistorialModal(false)}>
          <div className="bg-[#0d1424] rounded-2xl border border-slate-700/60 w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl"
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/60">
              <div>
                <h3 className="text-base font-semibold text-white">{selectedCliente.name}</h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">{selectedCliente.wisphub_id} · {selectedCliente.phone}</p>
              </div>
              <button onClick={() => setShowHistorialModal(false)}
                className="w-8 h-8 rounded-xl text-slate-400 hover:text-white hover:bg-slate-700 transition-all flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Stats rápidos */}
            <div className="px-5 py-3 grid grid-cols-4 gap-3 border-b border-slate-800/40">
              <div className="text-center">
                <p className="text-xs text-slate-500">Plan</p>
                <p className="text-sm font-medium text-white truncate">{selectedCliente.plan || '—'}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-slate-500">Precio</p>
                <p className="text-sm font-semibold text-white">
                  {selectedCliente.plan_price != null ? `S/ ${parseFloat(String(selectedCliente.plan_price)).toFixed(2)}` : '—'}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-slate-500">Meses pagados</p>
                <p className="text-sm font-bold text-emerald-400">{selectedCliente.meses_pagados}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-slate-500">Deuda total</p>
                <p className={clsx('text-sm font-bold',
                  (selectedCliente.deuda_actual + selectedCliente.deudas_anteriores) > 0
                    ? 'text-red-400' : 'text-emerald-400')}>
                  {(selectedCliente.deuda_actual + selectedCliente.deudas_anteriores) > 0
                    ? `S/ ${(selectedCliente.deuda_actual + selectedCliente.deudas_anteriores).toFixed(2)}`
                    : 'Al día ✓'}
                </p>
              </div>
            </div>

            {/* Lista pagos */}
            <div className="flex-1 overflow-auto px-5 py-4">
              <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mb-3">
                Todos los pagos registrados
              </p>
              {loadingHistorial ? (
                <LoadingSpinner text="Cargando historial..." />
              ) : historialPagos.length === 0 ? (
                <EmptyState icon={<FileCheck className="w-6 h-6" />}
                  text="No hay pagos registrados para este cliente." />
              ) : (
                <div className="space-y-2">
                  {historialPagos.map(p => {
                    const rawDate = p.payment_date || p.validated_at || p.created_at;
                    let fechaStr = rawDate ?? '—';
                    try { fechaStr = format(new Date(rawDate!), "dd MMM yyyy", { locale: es }); } catch {}
                    return (
                      <div key={p.id}
                        className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/30 border border-slate-700/30 hover:border-slate-700/60 transition-all">
                        <div className={clsx(
                          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border text-sm font-bold',
                          p.status === 'validated'
                            ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                            : 'bg-red-500/15 border-red-500/30 text-red-400'
                        )}>
                          {p.status === 'validated' ? '✓' : '✗'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-white">S/ {Number(p.amount).toFixed(2)}</span>
                            {p.payment_method && (
                              <span className="text-xs px-2 py-0.5 rounded-lg bg-slate-700/50 text-slate-300">
                                {METHOD_ICONS[p.payment_method] ?? '💳'} {p.payment_method.toUpperCase()}
                              </span>
                            )}
                            {p.operation_code && (
                              <span className="text-xs text-slate-500 font-mono">#{p.operation_code}</span>
                            )}
                          </div>
                          {p.notes && <p className="text-xs text-slate-500 mt-0.5 truncate">{p.notes}</p>}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-xs text-slate-400">{fechaStr}</p>
                          <p className={clsx('text-[10px] font-medium mt-0.5',
                            p.status === 'validated' ? 'text-emerald-500' : 'text-red-500')}>
                            {p.status === 'validated' ? 'Validado' : p.status}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Confirmar envío masivo ── */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0d1424] rounded-2xl border border-slate-700/60 w-full max-w-md p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                <Send className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">Confirmar envío masivo</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {mesNombreCtrl} {ano} · {deudoresCount} destinatarios
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/60 mb-5">
              <p className="text-xs text-slate-400 font-medium mb-1.5">Vista previa del mensaje:</p>
              <p className="text-sm text-slate-300 whitespace-pre-line leading-relaxed">
                {mensaje
                  .replace('{nombre}', 'Juan Pérez')
                  .replace('{precio}', 'S/ 60.00')}
              </p>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowConfirm(false)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-slate-800/60 border border-slate-700/40 text-slate-400 hover:text-white transition-all">
                Cancelar
              </button>
              <button onClick={handleEnviarDeudores}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 transition-all flex items-center justify-center gap-2">
                <Send className="w-4 h-4" />
                Sí, enviar a {deudoresCount}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Preview voucher ── */}
      {preview && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreview(null)}>
          <div className="relative max-w-lg w-full bg-slate-900 rounded-2xl border border-slate-700 overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <p className="text-sm font-semibold text-white">Comprobante</p>
              <div className="flex items-center gap-2">
                <a href={preview} download target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs hover:bg-emerald-500/20 transition-all">
                  <Download className="w-3.5 h-3.5" /> Descargar
                </a>
                <button onClick={() => setPreview(null)}
                  className="w-7 h-7 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-all flex items-center justify-center">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="p-4">
              <img src={preview} alt="Comprobante" className="w-full rounded-xl object-contain max-h-[70vh]" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────
function KpiCard({
  icon, color, label, value,
}: {
  icon: React.ReactNode;
  color: 'emerald' | 'blue' | 'red' | 'slate';
  label: string;
  value: string;
}) {
  const colors = {
    emerald: 'bg-emerald-500/10 border-emerald-500/20',
    blue:    'bg-blue-500/10    border-blue-500/20',
    red:     'bg-red-500/10     border-red-500/20',
    slate:   'bg-slate-800/40   border-slate-700/40',
  };
  return (
    <div className={clsx('rounded-2xl p-4 flex items-center gap-3 border', colors[color], 'bg-slate-800/40')}>
      <div className={clsx('w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0', colors[color])}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-400 truncate">{label}</p>
        <p className="text-xl font-bold text-white">{value}</p>
      </div>
    </div>
  );
}

function LoadingSpinner({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-40 text-slate-500 text-sm gap-2">
      <RefreshCw className="w-4 h-4 animate-spin" /> {text}
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 text-slate-500">
      <div className="mb-2 opacity-30">{icon}</div>
      <p className="text-sm text-center max-w-xs">{text}</p>
    </div>
  );
}
