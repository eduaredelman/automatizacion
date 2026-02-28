'use client';
import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import VoucherModal from '@/components/VoucherModal';
import {
  CreditCard, RefreshCw, Trash2, CheckCircle2,
  Clock, AlertTriangle, DollarSign, TrendingUp,
} from 'lucide-react';
import clsx from 'clsx';

interface Payment {
  id: string;
  phone: string;
  display_name: string;
  status: string;
  payment_method: string | null;
  amount: number | null;
  operation_code: string | null;
  ocr_confidence: string | null;
  voucher_url: string | null;
  payer_name: string | null;
  payment_date: string | null;
  rejection_reason: string | null;
  created_at: string;
}

interface Stats {
  total_validated: number;
  total_amount: number;
  today: number;
  by_status: { status: string; count: string }[];
}

const STATUS_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'validated', label: 'Validados' },
  { value: 'rejected', label: 'Rechazados' },
  { value: 'manual_review', label: 'En revisión' },
  { value: 'duplicate', label: 'Duplicados' },
];

const STATUS_BADGE: Record<string, string> = {
  pending:       'badge-pending',
  validated:     'badge-validated',
  rejected:      'badge-rejected',
  duplicate:     'badge-duplicate',
  processing:    'badge-processing',
  manual_review: 'badge-manual',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente', validated: 'Validado', rejected: 'Rechazado',
  duplicate: 'Duplicado', processing: 'Procesando', manual_review: 'En revisión',
};

const METHOD_ICONS: Record<string, string> = {
  yape: '💜', plin: '💛', bcp: '💙', interbank: '🟢',
  bbva: '🔵', scotiabank: '🔴', transfer: '🏦', unknown: '💳',
};

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [paymentsRes, statsRes] = await Promise.all([
        api.getPayments({ page, limit: 20, status: statusFilter || undefined }),
        api.getPaymentStats(),
      ]);
      setPayments(paymentsRes.data.data);
      setTotal(paymentsRes.data.pagination?.total || 0);
      setStats(statsRes.data.data?.payments || null);
    } catch (err) {
      console.error('Failed to load payments:', err);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / 20);

  const getStatCount = (status: string) => {
    const found = stats?.by_status?.find(s => s.status === status);
    return parseInt(found?.count || '0');
  };

  const handleDelete = async (p: Payment, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = window.confirm(
      `⚠️ ELIMINAR PAGO PERMANENTEMENTE\n\n` +
      `Cliente: ${p.display_name || p.payer_name || p.phone}\n` +
      `Monto: ${p.amount != null ? `S/ ${parseFloat(String(p.amount)).toFixed(2)}` : 'N/A'}\n` +
      `Estado: ${STATUS_LABELS[p.status] || p.status}\n\n` +
      `Esta acción NO se puede deshacer. ¿Confirmas la eliminación?`
    );
    if (!confirmed) return;

    setDeletingId(p.id);
    try {
      await api.deletePayment(p.id);
      setPayments(prev => prev.filter(x => x.id !== p.id));
      setTotal(prev => prev - 1);
    } catch (err) {
      alert('Error al eliminar el pago. Intenta nuevamente.');
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="p-6 border-b border-slate-800/60 bg-[#0d1424] sticky top-0 z-10">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-blue-400" />
              Pagos Recibidos
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">{total} comprobantes registrados</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {STATUS_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => { setStatusFilter(value); setPage(1); }}
                className={clsx(
                  'px-3 py-1.5 rounded-xl text-xs font-medium transition-all',
                  statusFilter === value
                    ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
                )}
              >
                {label}
              </button>
            ))}
            <button onClick={load} className="btn-ghost p-2 text-xs">
              <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="glass rounded-2xl p-4 border border-green-500/20">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              <span className="text-xs text-slate-400">Validados hoy</span>
            </div>
            <p className="text-2xl font-bold text-green-400">{stats?.today ?? '—'}</p>
            <p className="text-xs text-slate-500 mt-1">{getStatCount('validated')} total validados</p>
          </div>

          <div className="glass rounded-2xl p-4 border border-blue-500/20">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-4 h-4 text-blue-400" />
              <span className="text-xs text-slate-400">Total cobrado</span>
            </div>
            <p className="text-2xl font-bold text-blue-400">
              S/ {stats ? parseFloat(String(stats.total_amount)).toFixed(2) : '—'}
            </p>
            <p className="text-xs text-slate-500 mt-1">solo pagos validados</p>
          </div>

          <div className="glass rounded-2xl p-4 border border-yellow-500/20">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-yellow-400" />
              <span className="text-xs text-slate-400">Pendientes</span>
            </div>
            <p className="text-2xl font-bold text-yellow-400">{getStatCount('pending')}</p>
            <p className="text-xs text-slate-500 mt-1">esperando revisión</p>
          </div>

          <div className="glass rounded-2xl p-4 border border-orange-500/20">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
              <span className="text-xs text-slate-400">En revisión</span>
            </div>
            <p className="text-2xl font-bold text-orange-400">{getStatCount('manual_review')}</p>
            <p className="text-xs text-slate-500 mt-1">
              {getStatCount('duplicate')} duplicados · {getStatCount('rejected')} rechazados
            </p>
          </div>
        </div>

        {/* Tabla */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : payments.length === 0 ? (
          <div className="text-center py-16 text-slate-600">
            <CreditCard className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Sin pagos encontrados</p>
          </div>
        ) : (
          <div className="glass rounded-2xl border border-slate-700/40 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[11px] text-slate-500 uppercase tracking-wide border-b border-slate-800/60 bg-slate-900/40">
                    <th className="text-left px-4 py-3">Cliente</th>
                    <th className="text-left px-4 py-3">Medio</th>
                    <th className="text-left px-4 py-3">Monto</th>
                    <th className="text-left px-4 py-3">Código op.</th>
                    <th className="text-left px-4 py-3">Estado</th>
                    <th className="text-left px-4 py-3">Confianza IA</th>
                    <th className="text-left px-4 py-3">Recibido</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => setSelectedPayment(p)}
                      className="border-b border-slate-800/30 hover:bg-slate-800/25 cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3.5">
                        <p className="text-sm text-white font-medium group-hover:text-blue-300 transition-colors truncate max-w-[160px]">
                          {p.display_name || p.payer_name || 'N/A'}
                        </p>
                        <p className="text-xs text-slate-500">{p.phone}</p>
                      </td>
                      <td className="px-4 py-3.5 text-sm whitespace-nowrap">
                        <span className="mr-1">{METHOD_ICONS[p.payment_method || ''] || '💳'}</span>
                        <span className="text-slate-300 capitalize">{p.payment_method || '—'}</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="text-sm font-bold text-white">
                          {p.amount != null ? `S/ ${parseFloat(String(p.amount)).toFixed(2)}` : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="text-xs font-mono text-blue-300 truncate max-w-[130px] block">
                          {p.operation_code || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={STATUS_BADGE[p.status] || 'badge'}>
                          {STATUS_LABELS[p.status] || p.status}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={clsx(
                          'text-xs px-2 py-0.5 rounded-md font-medium',
                          p.ocr_confidence === 'high'   && 'text-green-400 bg-green-500/10',
                          p.ocr_confidence === 'medium' && 'text-yellow-400 bg-yellow-500/10',
                          p.ocr_confidence === 'low'    && 'text-orange-400 bg-orange-500/10',
                          p.ocr_confidence === 'none'   && 'text-red-400 bg-red-500/10',
                          !p.ocr_confidence             && 'text-slate-600',
                        )}>
                          {p.ocr_confidence || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-500 whitespace-nowrap">
                        {format(new Date(p.created_at), 'dd MMM HH:mm', { locale: es })}
                      </td>
                      <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={(e) => handleDelete(p, e)}
                          disabled={deletingId === p.id}
                          title="Eliminar permanentemente"
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
                        >
                          {deletingId === p.id
                            ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            : <Trash2 className="w-3.5 h-3.5" />
                          }
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Paginación dentro del card */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 py-4 border-t border-slate-800/40">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="btn-ghost text-xs px-4 py-2 disabled:opacity-30"
                >
                  ← Anterior
                </button>
                <span className="text-sm text-slate-400">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="btn-ghost text-xs px-4 py-2 disabled:opacity-30"
                >
                  Siguiente →
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal de voucher */}
      {selectedPayment && (
        <VoucherModal
          payment={selectedPayment}
          onClose={() => setSelectedPayment(null)}
          onValidate={async (notes) => {
            await api.validatePayment(selectedPayment.id, notes);
            setSelectedPayment(null);
            load();
          }}
          onReject={async (reason) => {
            await api.rejectPayment(selectedPayment.id, reason);
            setSelectedPayment(null);
            load();
          }}
        />
      )}
    </div>
  );
}
