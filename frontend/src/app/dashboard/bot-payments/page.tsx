'use client';
import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Download, Eye, RefreshCw, DollarSign, FileCheck, Wifi } from 'lucide-react';
import clsx from 'clsx';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const MESES = [
  { value: 1,  label: 'Enero' },
  { value: 2,  label: 'Febrero' },
  { value: 3,  label: 'Marzo' },
  { value: 4,  label: 'Abril' },
  { value: 5,  label: 'Mayo' },
  { value: 6,  label: 'Junio' },
  { value: 7,  label: 'Julio' },
  { value: 8,  label: 'Agosto' },
  { value: 9,  label: 'Septiembre' },
  { value: 10, label: 'Octubre' },
  { value: 11, label: 'Noviembre' },
  { value: 12, label: 'Diciembre' },
];

const METHOD_ICONS: Record<string, string> = {
  yape: '💜', plin: '💛', bcp: '💙', interbank: '🟢',
  bbva: '🔵', scotiabank: '🔴', transfer: '🏦', unknown: '💳',
};

interface BotPayment {
  id: string;
  nombre_cliente: string;
  telefono_cliente: string | null;
  amount: number | null;
  payment_method: string | null;
  payment_date: string | null;
  validated_at: string | null;
  created_at: string;
  operation_code: string | null;
  voucher_url: string | null;
  factura_id: string | null;
  registered_wisphub: boolean;
  mes: number;
  ano: number;
}

export default function BotPaymentsPage() {
  const now = new Date();
  const [mes,  setMes]  = useState(now.getMonth() + 1);
  const [ano,  setAno]  = useState(now.getFullYear());
  const [payments, setPayments] = useState<BotPayment[]>([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const currentYear = now.getFullYear();
  const years = Array.from({ length: 3 }, (_, i) => currentYear - i);

  const fetchPayments = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.getBotPayments({ mes, ano, limit: 100 });
      setPayments(data.data?.payments ?? []);
      setTotal(data.data?.total ?? 0);
      setTotalAmount(data.data?.total_amount ?? 0);
    } catch {
      setPayments([]);
    } finally {
      setLoading(false);
    }
  }, [mes, ano]);

  useEffect(() => { fetchPayments(); }, [fetchPayments]);

  const handleReconcile = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const { data } = await api.reconcileBotPayments();
      setSyncResult(data.message ?? 'Sincronización completada.');
      if (data.updated > 0) fetchPayments();
    } catch {
      setSyncResult('Error al sincronizar con WispHub.');
    } finally {
      setSyncing(false);
    }
  };

  const mesNombre = MESES.find(m => m.value === mes)?.label ?? '';

  const voucherUrl = (url: string | null) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    return `${API_BASE}${url}`;
  };

  const formatFecha = (p: BotPayment) => {
    const raw = p.payment_date || p.validated_at || p.created_at;
    try {
      return format(new Date(raw), 'dd/MM/yyyy', { locale: es });
    } catch { return raw ?? '-'; }
  };

  return (
    <div className="flex flex-col h-full bg-[#080f1e] text-white overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800/60 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <FileCheck className="w-5 h-5 text-emerald-400" />
            Pagos del Bot
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Pagos registrados automáticamente por WhatsApp</p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={mes}
            onChange={e => setMes(Number(e.target.value))}
            className="bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          >
            {MESES.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>

          <select
            value={ano}
            onChange={e => setAno(Number(e.target.value))}
            className="bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          >
            {years.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>

          <button
            onClick={handleReconcile}
            disabled={syncing}
            title="Verificar en WispHub cuáles pagos ya están registrados"
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 hover:border-blue-500/50 transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Wifi className={clsx('w-4 h-4', syncing && 'animate-pulse')} />
            <span className="hidden sm:inline">{syncing ? 'Sincronizando...' : 'Sync WispHub'}</span>
          </button>

          <button
            onClick={fetchPayments}
            className="p-2 rounded-xl bg-slate-800/60 border border-slate-700/50 text-slate-400 hover:text-white hover:border-slate-600 transition-all"
          >
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className="mx-6 mt-2 px-4 py-2 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300 text-sm flex items-center justify-between">
          <span>{syncResult}</span>
          <button onClick={() => setSyncResult(null)} className="text-blue-400 hover:text-white ml-4 text-lg leading-none">×</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="px-6 py-4 grid grid-cols-2 gap-4">
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <FileCheck className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <p className="text-xs text-slate-400">Pagos en {mesNombre} {ano}</p>
            <p className="text-2xl font-bold text-white">{total}</p>
          </div>
        </div>
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-2xl p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <DollarSign className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <p className="text-xs text-slate-400">Total recaudado</p>
            <p className="text-2xl font-bold text-white">S/ {totalAmount.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
            Cargando pagos...
          </div>
        ) : payments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-slate-500">
            <FileCheck className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No hay pagos registrados en {mesNombre} {ano}</p>
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800/60">
                {['Cliente', 'Teléfono', 'Método', 'Monto', 'Factura', 'Fecha', 'Comprobante'].map(h => (
                  <th key={h} className="text-left text-xs font-semibold text-slate-400 uppercase tracking-wider pb-3 pr-4">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payments.map(p => (
                <tr
                  key={p.id}
                  className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors"
                >
                  <td className="py-3 pr-4">
                    <span className="font-medium text-white">{p.nombre_cliente}</span>
                  </td>
                  <td className="py-3 pr-4 text-slate-300 font-mono text-xs">
                    {p.telefono_cliente ?? '-'}
                  </td>
                  <td className="py-3 pr-4">
                    {p.payment_method ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-slate-700/50 text-xs font-medium text-slate-200">
                        {METHOD_ICONS[p.payment_method] ?? '💳'}
                        {p.payment_method.toUpperCase()}
                      </span>
                    ) : '-'}
                  </td>
                  <td className="py-3 pr-4">
                    <span className="text-emerald-400 font-bold">
                      S/ {Number(p.amount ?? 0).toFixed(2)}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-slate-400 text-xs font-mono">
                    {p.factura_id ? `#${p.factura_id}` : '-'}
                  </td>
                  <td className="py-3 pr-4 text-slate-300 text-xs">
                    {formatFecha(p)}
                  </td>
                  <td className="py-3">
                    {voucherUrl(p.voucher_url) ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setPreview(voucherUrl(p.voucher_url)!)}
                          title="Ver comprobante"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 transition-all"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <a
                          href={voucherUrl(p.voucher_url)!}
                          download
                          target="_blank"
                          rel="noreferrer"
                          title="Descargar comprobante"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all"
                        >
                          <Download className="w-4 h-4" />
                        </a>
                      </div>
                    ) : (
                      <span className="text-slate-600 text-xs">Sin imagen</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Voucher preview modal */}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="relative max-w-lg w-full bg-slate-900 rounded-2xl border border-slate-700 overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <p className="text-sm font-semibold text-white">Comprobante</p>
              <div className="flex items-center gap-2">
                <a
                  href={preview}
                  download
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs hover:bg-emerald-500/20 transition-all"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar
                </a>
                <button
                  onClick={() => setPreview(null)}
                  className="w-7 h-7 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-all flex items-center justify-center text-lg leading-none"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="p-4">
              <img
                src={preview}
                alt="Comprobante"
                className="w-full rounded-xl object-contain max-h-[70vh]"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
