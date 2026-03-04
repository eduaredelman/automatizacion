'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { getApi } from '@/lib/api';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  Users, RefreshCw, Search, Send, X, CheckCircle2, Wifi, WifiOff,
} from 'lucide-react';
import clsx from 'clsx';

interface Contact {
  id: string;
  wisphub_id: string;
  phone: string;
  name: string;
  plan: string | null;
  plan_price: number | null;
  service_status: string;
  last_synced_at: string | null;
}

interface SyncStatus {
  total: string;
  activos: string;
  cortados: string;
  last_sync: string | null;
}

const STATUS_FILTER = [
  { value: '', label: 'Todos' },
  { value: 'activo', label: 'Activos' },
  { value: 'cortado', label: 'Cortados' },
];

export default function ContactsPage() {
  const [contacts, setContacts]     = useState<Contact[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);
  const [syncing, setSyncing]       = useState(false);
  const [search, setSearch]         = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  // Mensaje individual
  const [msgModal, setMsgModal]     = useState<Contact | null>(null);
  const [msgText, setMsgText]       = useState('');
  const [sending, setSending]       = useState(false);

  const searchRef = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async (q?: string, st?: string, pg?: number) => {
    setLoading(true);
    try {
      const api = getApi();
      const [contactsRes, syncRes] = await Promise.all([
        api.get('/contacts', { params: { search: q ?? search, status: st ?? statusFilter, page: pg ?? page, limit: 50 } }),
        api.get('/contacts/sync/status'),
      ]);
      setContacts(contactsRes.data.data);
      setTotal(contactsRes.data.pagination?.total ?? 0);
      setSyncStatus(syncRes.data.data);
    } catch (err) {
      console.error('Error loading contacts:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, page]);

  useEffect(() => { load(); }, [load]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => { setPage(1); load(val, statusFilter, 1); }, 400);
  };

  const handleStatusFilter = (val: string) => {
    setStatusFilter(val);
    setPage(1);
    load(search, val, 1);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const api = getApi();
      await api.post('/contacts/sync');
      await load();
    } catch (err) {
      console.error('Sync error:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleSendMessage = async () => {
    if (!msgModal || !msgText.trim()) return;
    setSending(true);
    try {
      const api = getApi();
      await api.post(`/contacts/${msgModal.wisphub_id}/message`, { message: msgText });
      setMsgModal(null);
      setMsgText('');
    } catch (err) {
      console.error('Send error:', err);
      alert('Error al enviar el mensaje. Verifica que el contacto tenga teléfono registrado.');
    } finally {
      setSending(false);
    }
  };

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="p-6 border-b border-slate-800/60 bg-[#0d1424] sticky top-0 z-10">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-400" />
              Contactos WispHub
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">
              {total} contactos
              {syncStatus?.last_sync && (
                <span className="ml-2 text-slate-600">
                  · Sync: {format(new Date(syncStatus.last_sync), 'dd/MM HH:mm', { locale: es })}
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* KPI pills */}
            {syncStatus && (
              <>
                <span className="px-2.5 py-1 rounded-xl text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                  {syncStatus.activos} activos
                </span>
                <span className="px-2.5 py-1 rounded-xl text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                  {syncStatus.cortados} cortados
                </span>
              </>
            )}

            <button
              onClick={handleSync}
              disabled={syncing}
              className="btn-ghost px-3 py-1.5 text-xs flex items-center gap-1.5"
            >
              <RefreshCw className={clsx('w-3.5 h-3.5', syncing && 'animate-spin')} />
              {syncing ? 'Sincronizando...' : 'Sincronizar ahora'}
            </button>

            <a href="/dashboard/campaigns" className="btn-primary px-3 py-1.5 text-xs flex items-center gap-1.5">
              <Send className="w-3.5 h-3.5" />
              Nueva Campaña
            </a>
          </div>
        </div>

        {/* Search + filter bar */}
        <div className="flex items-center gap-3 mt-4">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Buscar nombre o teléfono..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700/60 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500/60"
            />
          </div>

          <div className="flex items-center gap-1">
            {STATUS_FILTER.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => handleStatusFilter(value)}
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
          </div>
        </div>
      </div>

      <div className="p-6">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : contacts.length === 0 ? (
          <div className="text-center py-20 text-slate-600">
            <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Sin contactos. Pulsa "Sincronizar ahora" para cargar desde WispHub.</p>
          </div>
        ) : (
          <div className="glass rounded-2xl border border-slate-700/40 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[11px] text-slate-500 uppercase tracking-wide border-b border-slate-800/60 bg-slate-900/40">
                    <th className="text-left px-4 py-3">Nombre</th>
                    <th className="text-left px-4 py-3">Teléfono</th>
                    <th className="text-left px-4 py-3">Plan</th>
                    <th className="text-left px-4 py-3">Precio</th>
                    <th className="text-left px-4 py-3">Estado</th>
                    <th className="text-left px-4 py-3">Último sync</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-slate-800/30 hover:bg-slate-800/25 transition-colors group"
                    >
                      <td className="px-4 py-3.5">
                        <p className="text-sm text-white font-medium truncate max-w-[180px]">{c.name}</p>
                        <p className="text-xs text-slate-600 font-mono">{c.wisphub_id}</p>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="text-sm text-slate-300 font-mono">{c.phone || '—'}</p>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="text-sm text-slate-300 truncate max-w-[140px]">{c.plan || '—'}</p>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="text-sm font-semibold text-white">
                          {c.plan_price != null ? `S/ ${parseFloat(String(c.plan_price)).toFixed(2)}` : '—'}
                        </p>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={clsx(
                          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-medium',
                          c.service_status === 'activo'
                            ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                            : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        )}>
                          {c.service_status === 'activo'
                            ? <Wifi className="w-3 h-3" />
                            : <WifiOff className="w-3 h-3" />}
                          {c.service_status === 'activo' ? 'Activo' : 'Cortado'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-slate-600 whitespace-nowrap">
                        {c.last_synced_at
                          ? format(new Date(c.last_synced_at), 'dd/MM HH:mm', { locale: es })
                          : '—'}
                      </td>
                      <td className="px-4 py-3.5">
                        <button
                          onClick={() => { setMsgModal(c); setMsgText(''); }}
                          disabled={!c.phone}
                          title="Enviar mensaje WhatsApp"
                          className="opacity-0 group-hover:opacity-100 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Send className="w-3.5 h-3.5" />
                          Mensaje
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Paginación */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 py-4 border-t border-slate-800/40">
                <button
                  onClick={() => { const p = Math.max(1, page - 1); setPage(p); load(search, statusFilter, p); }}
                  disabled={page === 1}
                  className="btn-ghost text-xs px-4 py-2 disabled:opacity-30"
                >
                  ← Anterior
                </button>
                <span className="text-sm text-slate-400">{page} / {totalPages}</span>
                <button
                  onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); load(search, statusFilter, p); }}
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

      {/* Modal: Enviar mensaje individual */}
      {msgModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="glass rounded-2xl border border-slate-700/60 w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-base font-semibold text-white">Enviar mensaje</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {msgModal.name} · {msgModal.phone}
                </p>
              </div>
              <button
                onClick={() => setMsgModal(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <textarea
              value={msgText}
              onChange={e => setMsgText(e.target.value)}
              placeholder="Escribe el mensaje... Usa {nombre} para personalizar"
              rows={5}
              className="w-full px-4 py-3 rounded-xl bg-slate-900/60 border border-slate-700/60 text-sm text-white placeholder-slate-600 resize-none focus:outline-none focus:border-blue-500/60"
            />

            <div className="flex items-center justify-end gap-3 mt-4">
              <button
                onClick={() => setMsgModal(null)}
                className="btn-ghost px-4 py-2 text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleSendMessage}
                disabled={sending || !msgText.trim()}
                className="btn-primary px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {sending
                  ? <RefreshCw className="w-4 h-4 animate-spin" />
                  : <Send className="w-4 h-4" />}
                {sending ? 'Enviando...' : 'Enviar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
