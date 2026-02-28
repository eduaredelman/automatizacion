'use client';
import { useState } from 'react';
import {
  X, ZoomIn, ZoomOut, CheckCircle, XCircle,
  CreditCard, Hash, Calendar, DollarSign,
  AlertTriangle, Loader2
} from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import clsx from 'clsx';

interface Payment {
  id: string;
  status: string;
  payment_method: string | null;
  amount: number | null;
  operation_code: string | null;
  ocr_confidence: string | null;
  voucher_url: string | null;
  voucher_path?: string | null;
  payer_name?: string | null;
  payment_date?: string | null;
  rejection_reason?: string | null;
  created_at: string;
}

interface VoucherModalProps {
  payment: Payment;
  onClose: () => void;
  onValidate: (notes?: string) => Promise<void>;
  onReject: (reason: string) => Promise<void>;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const CONFIDENCE_COLORS = {
  high:   'text-green-400 bg-green-500/10 border-green-500/30',
  medium: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  low:    'text-orange-400 bg-orange-500/10 border-orange-500/30',
  none:   'text-red-400 bg-red-500/10 border-red-500/30',
};

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  pending:       { label: 'Pendiente',       color: 'text-yellow-400' },
  processing:    { label: 'Procesando',      color: 'text-blue-400' },
  validated:     { label: '✅ Validado',      color: 'text-green-400' },
  rejected:      { label: '❌ Rechazado',     color: 'text-red-400' },
  duplicate:     { label: '⚠️ Duplicado',    color: 'text-purple-400' },
  manual_review: { label: '🔍 Revisión',     color: 'text-orange-400' },
};

const METHOD_ICONS: Record<string, string> = {
  yape: '💜 Yape', plin: '💛 Plin', bcp: '💙 BCP',
  interbank: '🟢 Interbank', bbva: '🔵 BBVA',
  scotiabank: '🔴 Scotiabank', transfer: '🏦 Transferencia', unknown: '💳',
};

export default function VoucherModal({ payment, onClose, onValidate, onReject }: VoucherModalProps) {
  const [zoom, setZoom] = useState(1);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState('');

  const imageUrl = payment.voucher_url ? `${API_URL}${payment.voucher_url}` : null;
  const confidence = payment.ocr_confidence as keyof typeof CONFIDENCE_COLORS;
  const statusCfg = STATUS_CONFIG[payment.status] || { label: payment.status, color: 'text-slate-400' };
  const canAction = ['pending', 'processing', 'manual_review'].includes(payment.status);

  const handleValidate = async () => {
    setLoading(true);
    try {
      await onValidate(notes || undefined);
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    if (!rejectReason.trim()) return;
    setLoading(true);
    try {
      await onReject(rejectReason);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-2xl glass rounded-2xl border border-slate-700/50 overflow-hidden cyber-border max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
              <CreditCard className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-sm">Comprobante de Pago</h3>
              <p className={clsx('text-xs', statusCfg.color)}>{statusCfg.label}</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-2 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          {/* Image */}
          <div className="md:w-1/2 bg-slate-900/50 flex flex-col items-center justify-center p-4 border-r border-slate-700/50 min-h-[200px]">
            {imageUrl ? (
              <>
                <div className="overflow-auto max-h-[300px] md:max-h-[400px] rounded-xl">
                  <img
                    src={imageUrl}
                    alt="Voucher"
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', transition: 'transform 0.2s' }}
                    className="rounded-xl w-full"
                    onError={(e) => { (e.target as HTMLImageElement).src = ''; }}
                  />
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => setZoom(z => Math.max(0.5, z - 0.25))} className="btn-ghost text-xs p-2">
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-slate-500 self-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom(z => Math.min(3, z + 0.25))} className="btn-ghost text-xs p-2">
                    <ZoomIn className="w-4 h-4" />
                  </button>
                </div>
              </>
            ) : (
              <div className="text-center text-slate-600">
                <CreditCard className="w-12 h-12 mx-auto mb-2" />
                <p className="text-sm">Sin imagen</p>
              </div>
            )}
          </div>

          {/* Details */}
          <div className="md:w-1/2 p-4 overflow-y-auto">
            <div className="space-y-3">
              {/* OCR Confidence */}
              {confidence && (
                <div className={clsx('inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs border', CONFIDENCE_COLORS[confidence] || 'text-slate-400')}>
                  <span className="capitalize">Confianza OCR: {confidence}</span>
                </div>
              )}

              {/* Data Grid */}
              <div className="space-y-2">
                {[
                  { icon: CreditCard, label: 'Medio de pago', value: METHOD_ICONS[payment.payment_method || ''] || payment.payment_method },
                  { icon: DollarSign, label: 'Monto', value: payment.amount != null ? `S/ ${parseFloat(String(payment.amount)).toFixed(2)}` : null },
                  { icon: Hash, label: 'Código operación', value: payment.operation_code, mono: true },
                  { icon: Calendar, label: 'Fecha pago', value: payment.payment_date },
                  { label: 'Nombre pagador', value: payment.payer_name },
                ].map(({ icon: Icon, label, value, mono }) => value ? (
                  <div key={label} className="flex items-start gap-2">
                    {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 mt-0.5 shrink-0" />}
                    {!Icon && <div className="w-3.5" />}
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</p>
                      <p className={clsx('text-sm text-slate-200', mono && 'font-mono text-blue-300')}>{value}</p>
                    </div>
                  </div>
                ) : null)}
              </div>

              {payment.rejection_reason && (
                <div className={clsx(
                  'p-3 rounded-xl border',
                  payment.status === 'duplicate'
                    ? 'bg-purple-500/10 border-purple-500/30'
                    : 'bg-red-500/10 border-red-500/30'
                )}>
                  <p className={clsx('text-xs flex items-start gap-1.5', payment.status === 'duplicate' ? 'text-purple-300' : 'text-red-400')}>
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{payment.rejection_reason}</span>
                  </p>
                  {/* Extraer el ID del pago original del rejection_reason para mostrarlo */}
                  {payment.status === 'duplicate' && (() => {
                    const match = payment.rejection_reason?.match(/ID original: ([a-f0-9-]{36})/i);
                    if (!match) return null;
                    return (
                      <div className="mt-2 pt-2 border-t border-purple-500/20">
                        <p className="text-[10px] text-purple-400 font-mono break-all">
                          Pago original: {match[1]}
                        </p>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          Busca este ID en la tabla de Pagos para ver el original.
                        </p>
                      </div>
                    );
                  })()}
                </div>
              )}

              <p className="text-[10px] text-slate-600">
                Recibido: {format(new Date(payment.created_at), 'dd MMM yyyy HH:mm', { locale: es })}
              </p>
            </div>

            {/* Actions */}
            {canAction && (
              <div className="mt-4 space-y-3">
                {!showRejectInput ? (
                  <>
                    <div>
                      <label className="text-xs text-slate-500 block mb-1">Notas (opcional)</label>
                      <input
                        type="text"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Notas de validación..."
                        className="input-field py-2 text-xs"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleValidate}
                        disabled={loading}
                        className="flex-1 btn-primary justify-center text-xs py-2.5"
                      >
                        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                        Validar Pago
                      </button>
                      <button
                        onClick={() => setShowRejectInput(true)}
                        disabled={loading}
                        className="btn-danger text-xs py-2.5 px-3"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Rechazar
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Motivo del rechazo..."
                      className="input-field py-2 text-xs"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleReject}
                        disabled={!rejectReason.trim() || loading}
                        className="flex-1 btn-danger justify-center text-xs py-2.5"
                      >
                        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                        Confirmar Rechazo
                      </button>
                      <button
                        onClick={() => setShowRejectInput(false)}
                        className="btn-ghost text-xs py-2.5 px-3"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
