'use client';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { Search, RefreshCw, Bot, Trash2 } from 'lucide-react';
import clsx from 'clsx';

interface Conversation {
  id: string;
  phone: string;
  display_name: string;
  status: string;
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
  payment_count?: number;
  bot_intent?: string;
}

interface ChatListProps {
  conversations: Conversation[];
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onArchive?: (id: string) => void;
}

const STATUS_CONFIG = {
  bot:      { dot: 'bg-blue-500 shadow-[0_0_6px_#3b82f6]', label: 'Bot' },
  human:    { dot: 'bg-yellow-500 shadow-[0_0_6px_#f59e0b]', label: 'Asesor' },
  resolved: { dot: 'bg-green-500', label: 'Resuelto' },
  spam:     { dot: 'bg-slate-500', label: 'Spam' },
};

const INTENT_EMOJI: Record<string, string> = {
  payment: '💳', support: '🔧', complaint: '😠',
  sales: '🛒', info: 'ℹ️', greeting: '👋',
};

export default function ChatList({
  conversations, loading, search, onSearch,
  statusFilter, onStatusFilter, activeId, onSelect, onRefresh, onArchive,
}: ChatListProps) {
  return (
    <div className="flex flex-col h-full bg-[#0d1424]">
      {/* Header */}
      <div className="p-4 border-b border-slate-800/60">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-white">Conversaciones</h2>
          <button onClick={onRefresh} className="btn-ghost p-2 text-xs">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Buscar por nombre o teléfono..."
            className="input-field pl-9 py-2 text-xs"
          />
        </div>

        {/* Status filter */}
        <div className="flex gap-1 flex-wrap">
          {[
            { value: '', label: 'Todos' },
            { value: 'bot', label: '🤖 Bot' },
            { value: 'human', label: '👤 Asesor' },
            { value: 'resolved', label: '✅ Resuelto' },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => onStatusFilter(value)}
              className={clsx(
                'px-2.5 py-1 rounded-lg text-xs font-medium transition-all',
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

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && conversations.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center text-slate-600 py-16 text-sm">
            Sin conversaciones
          </div>
        ) : (
          conversations.map((conv) => {
            const cfg = STATUS_CONFIG[conv.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.bot;
            const isActive = conv.id === activeId;
            const timeAgo = conv.last_message_at
              ? formatDistanceToNow(new Date(conv.last_message_at), { addSuffix: true, locale: es })
              : '';

            return (
              <div
                key={conv.id}
                className={clsx(
                  'relative group border-b border-slate-800/40 transition-all duration-150',
                  isActive
                    ? 'bg-blue-600/15 border-l-2 border-l-blue-500'
                    : 'hover:bg-slate-800/40'
                )}
              >
                {/* Botón eliminar permanentemente (visible en hover) */}
                {onArchive && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const name = conv.display_name || conv.phone;
                      const ok = window.confirm(
                        `⚠️ ELIMINAR CONVERSACIÓN PERMANENTEMENTE\n\n` +
                        `Cliente: ${name}\n\n` +
                        `Se eliminarán todos los mensajes, pagos y eventos de esta conversación.\n` +
                        `Esta acción NO se puede deshacer.\n\n` +
                        `¿Confirmas la eliminación?`
                      );
                      if (ok) onArchive(conv.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 absolute top-2 right-2 z-10 p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition-all"
                    title="Eliminar conversación permanentemente"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => onSelect(conv.id)}
                  className="w-full text-left p-4"
                >
                <div className="flex items-start gap-3">
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-700 to-slate-600 flex items-center justify-center text-white font-semibold text-sm">
                      {(conv.display_name || conv.phone || '?').charAt(0).toUpperCase()}
                    </div>
                    {/* Status dot */}
                    <span className={clsx('absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0d1424]', cfg.dot)} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 overflow-hidden min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-white truncate">
                        {conv.display_name || conv.phone}
                        {conv.bot_intent && INTENT_EMOJI[conv.bot_intent] && (
                          <span className="ml-1">{INTENT_EMOJI[conv.bot_intent]}</span>
                        )}
                      </span>
                      <span className="text-[10px] text-slate-600 shrink-0 whitespace-nowrap">{timeAgo}</span>
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {conv.last_message || 'Sin mensajes'}
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className={clsx(
                        'text-[10px] px-1.5 py-0.5 rounded-md font-medium',
                        conv.status === 'bot'      && 'bg-blue-500/15 text-blue-400',
                        conv.status === 'human'    && 'bg-yellow-500/15 text-yellow-400',
                        conv.status === 'resolved' && 'bg-green-500/15 text-green-400',
                        conv.status === 'spam'     && 'bg-slate-700 text-slate-400',
                      )}>
                        {conv.status === 'bot' ? <><Bot className="w-2.5 h-2.5 inline mr-0.5" />Bot</> : cfg.label}
                      </span>
                      {conv.payment_count ? (
                        <span className="text-[10px] text-slate-600">
                          💳 {conv.payment_count}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Unread badge */}
                  {conv.unread_count > 0 && (
                    <span className="shrink-0 min-w-[20px] h-5 bg-blue-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1">
                      {conv.unread_count > 99 ? '99+' : conv.unread_count}
                    </span>
                  )}
                </div>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
