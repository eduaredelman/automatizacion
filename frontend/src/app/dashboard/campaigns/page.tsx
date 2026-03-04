'use client';
import { useEffect, useState, useCallback } from 'react';
import { getApi } from '@/lib/api';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  Send, Plus, RefreshCw, X, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Clock, AlertTriangle, Users,
} from 'lucide-react';
import clsx from 'clsx';

interface Campaign {
  id: string;
  name: string;
  message: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  failed_count: number;
  created_by_name: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface Recipient {
  id: string;
  phone: string;
  name: string;
  status: string;
  sent_at: string | null;
  error_message: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  draft:     'bg-slate-500/10 text-slate-400 border-slate-500/20',
  running:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
  completed: 'bg-green-500/10 text-green-400 border-green-500/20',
  cancelled: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  failed:    'bg-red-500/10 text-red-400 border-red-500/20',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador', running: 'Enviando', completed: 'Completada',
  cancelled: 'Cancelada', failed: 'Fallida',
};

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [detail, setDetail]       = useState<{ campaign: Campaign; recipients: Recipient[] } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Form state
  const [formName, setFormName]         = useState('');
  const [formMsg, setFormMsg]           = useState('');
  const [formFilter, setFormFilter]     = useState('all');
  const [submitting, setSubmitting]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const api = getApi();
      const res = await api.get('/campaigns', { params: { limit: 20 } });
      setCampaigns(res.data.data);
      setTotal(res.data.pagination?.total ?? 0);
    } catch (err) {
      console.error('Error loading campaigns:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDetail = async (id: string) => {
    if (expanded === id) { setExpanded(null); setDetail(null); return; }
    setExpanded(id);
    setLoadingDetail(true);
    try {
      const api = getApi();
      const res = await api.get(`/campaigns/${id}`);
      setDetail(res.data.data);
    } catch (err) {
      console.error('Error loading campaign detail:', err);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleCreate = async () => {
    if (!formName.trim() || !formMsg.trim()) return;
    setSubmitting(true);
    try {
      const api = getApi();
      await api.post('/campaigns', {
        name: formName.trim(),
        message: formMsg.trim(),
        filter_status: formFilter === 'all' ? undefined : formFilter,
      });
      setShowForm(false);
      setFormName('');
      setFormMsg('');
      setFormFilter('all');
      await load();
    } catch (err: any) {
      alert(err?.response?.data?.message || 'Error al crear la campaña');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('¿Cancelar esta campaña? Se detendrá el envío de mensajes pendientes.')) return;
    try {
      const api = getApi();
      await api.post(`/campaigns/${id}/cancel`);
      await load();
    } catch (err) {
      console.error('Cancel error:', err);
    }
  };

  const progressPct = (c: Campaign) => {
    if (!c.total_recipients) return 0;
    return Math.round(((c.sent_count + c.failed_count) / c.total_recipients) * 100);
  };

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="p-6 border-b border-slate-800/60 bg-[#0d1424] sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Send className="w-5 h-5 text-blue-400" />
              Campañas Masivas
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">{total} campañas registradas</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="btn-ghost p-2">
              <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
            </button>
            <button
              onClick={() => setShowForm(v => !v)}
              className="btn-primary px-4 py-2 text-sm flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Nueva Campaña
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {/* Formulario nueva campaña */}
        {showForm && (
          <div className="glass rounded-2xl border border-blue-500/20 p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-white">Nueva campaña</h2>
              <button
                onClick={() => setShowForm(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Nombre de la campaña</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="Ej: Aviso de cobro marzo 2026"
                  className="w-full px-4 py-2.5 rounded-xl bg-slate-900/60 border border-slate-700/60 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500/60"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">
                  Mensaje <span className="text-slate-600 ml-1">— usa {'{nombre}'} para personalizar</span>
                </label>
                <textarea
                  value={formMsg}
                  onChange={e => setFormMsg(e.target.value)}
                  placeholder="Hola {nombre}, tu factura de FiberPeru está disponible..."
                  rows={5}
                  className="w-full px-4 py-3 rounded-xl bg-slate-900/60 border border-slate-700/60 text-sm text-white placeholder-slate-600 resize-none focus:outline-none focus:border-blue-500/60"
                />
              </div>

              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Destinatarios</label>
                <div className="flex gap-2">
                  {[
                    { value: 'all', label: 'Todos los contactos' },
                    { value: 'activo', label: 'Solo activos' },
                    { value: 'cortado', label: 'Solo cortados' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setFormFilter(opt.value)}
                      className={clsx(
                        'px-3 py-1.5 rounded-xl text-xs font-medium border transition-all',
                        formFilter === opt.value
                          ? 'bg-blue-600/30 text-blue-300 border-blue-500/40'
                          : 'text-slate-500 border-slate-700/40 hover:text-slate-300 hover:bg-slate-800/50'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-1">
                <button onClick={() => setShowForm(false)} className="btn-ghost px-4 py-2 text-sm">
                  Cancelar
                </button>
                <button
                  onClick={handleCreate}
                  disabled={submitting || !formName.trim() || !formMsg.trim()}
                  className="btn-primary px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {submitting
                    ? <RefreshCw className="w-4 h-4 animate-spin" />
                    : <Send className="w-4 h-4" />}
                  {submitting ? 'Iniciando...' : 'Iniciar campaña'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Lista de campañas */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="text-center py-20 text-slate-600">
            <Send className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Sin campañas. Crea la primera usando el botón de arriba.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {campaigns.map(c => (
              <div key={c.id} className="glass rounded-2xl border border-slate-700/40 overflow-hidden">
                {/* Row principal */}
                <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-white truncate">{c.name}</h3>
                      <span className={clsx('shrink-0 px-2 py-0.5 rounded-lg text-xs font-medium border', STATUS_BADGE[c.status])}>
                        {STATUS_LABELS[c.status] || c.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-1">{c.message}</p>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="flex items-center gap-1.5 text-xs text-slate-400">
                      <Users className="w-3.5 h-3.5" />
                      <span>{c.total_recipients}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-green-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{c.sent_count}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-red-400">
                      <XCircle className="w-3.5 h-3.5" />
                      <span>{c.failed_count}</span>
                    </div>
                    <span className="text-xs text-slate-600">
                      {format(new Date(c.created_at), 'dd MMM HH:mm', { locale: es })}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {c.status === 'running' && (
                      <button
                        onClick={() => handleCancel(c.id)}
                        className="px-3 py-1.5 rounded-xl text-xs text-red-400 border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 transition-all"
                      >
                        Cancelar
                      </button>
                    )}
                    <button
                      onClick={() => loadDetail(c.id)}
                      className="btn-ghost p-1.5"
                      title="Ver detalle"
                    >
                      {expanded === c.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Barra de progreso para running */}
                {c.status === 'running' && c.total_recipients > 0 && (
                  <div className="px-5 pb-3">
                    <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                      <span>Progreso</span>
                      <span>{progressPct(c)}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-800">
                      <div
                        className="h-1.5 rounded-full bg-blue-500 transition-all duration-500"
                        style={{ width: `${progressPct(c)}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Detalle expandido */}
                {expanded === c.id && (
                  <div className="border-t border-slate-800/60">
                    {loadingDetail ? (
                      <div className="flex justify-center py-6">
                        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : detail ? (
                      <div className="max-h-64 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-slate-600 uppercase border-b border-slate-800/60 bg-slate-900/40">
                              <th className="text-left px-4 py-2">Nombre</th>
                              <th className="text-left px-4 py-2">Teléfono</th>
                              <th className="text-left px-4 py-2">Estado</th>
                              <th className="text-left px-4 py-2">Enviado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.recipients.map(r => (
                              <tr key={r.id} className="border-b border-slate-800/20 hover:bg-slate-800/20">
                                <td className="px-4 py-2 text-slate-300">{r.name || '—'}</td>
                                <td className="px-4 py-2 font-mono text-slate-400">{r.phone}</td>
                                <td className="px-4 py-2">
                                  <span className={clsx(
                                    'px-1.5 py-0.5 rounded font-medium',
                                    r.status === 'sent'    && 'text-green-400 bg-green-500/10',
                                    r.status === 'failed'  && 'text-red-400 bg-red-500/10',
                                    r.status === 'pending' && 'text-slate-500 bg-slate-800',
                                  )}>
                                    {r.status === 'sent' ? 'Enviado' : r.status === 'failed' ? 'Fallido' : 'Pendiente'}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-slate-600">
                                  {r.sent_at ? format(new Date(r.sent_at), 'dd/MM HH:mm', { locale: es }) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
