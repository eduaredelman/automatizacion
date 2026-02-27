'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import api from '@/lib/api';
import { useChatStore } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { joinConversation, leaveConversation, getSocket } from '@/lib/socket';
import VoucherModal from './VoucherModal';
import {
  ArrowLeft, Bot, User, Send, UserCheck, Wifi,
  CreditCard, Phone, MoreVertical, CheckCheck, Clock,
  AlertTriangle, CheckCircle, XCircle, Loader2, Image as ImageIcon
} from 'lucide-react';
import clsx from 'clsx';

interface Conversation {
  id: string;
  phone: string;
  display_name: string;
  status: string;
  agent_name?: string;
  wisphub_id?: string;
  plan?: string;
  debt_amount?: number;
}

interface Message {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: 'client' | 'bot' | 'agent' | 'system';
  message_type: string;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  whatsapp_status: string;
  agent_name?: string;
  created_at: string;
}

interface Payment {
  id: string;
  message_id?: string;
  status: string;
  payment_method: string | null;
  amount: number | null;
  operation_code: string | null;
  ocr_confidence: string | null;
  voucher_url: string | null;
  created_at: string;
}

interface ChatWindowProps {
  conversation: Conversation;
  onBack: () => void;
  onUpdate: () => void;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const PAYMENT_STATUS: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  pending:       { icon: Clock,        color: 'text-yellow-400', label: 'Pendiente' },
  processing:    { icon: Loader2,      color: 'text-blue-400',   label: 'Procesando' },
  validated:     { icon: CheckCircle,  color: 'text-green-400',  label: 'Validado' },
  rejected:      { icon: XCircle,      color: 'text-red-400',    label: 'Rechazado' },
  duplicate:     { icon: AlertTriangle,color: 'text-purple-400', label: 'Duplicado' },
  manual_review: { icon: AlertTriangle,color: 'text-orange-400', label: 'Revisión' },
};

export default function ChatWindow({ conversation, onBack, onUpdate }: ChatWindowProps) {
  const { messages, setMessages, addMessage, markRead } = useChatStore();
  const { agent } = useAuthStore();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedVoucher, setSelectedVoucher] = useState<Payment | null>(null);
  const [showPaymentsPanel, setShowPaymentsPanel] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const convMessages = messages[conversation.id] || [];

  const loadMessages = useCallback(async () => {
    try {
      const { data } = await api.getChat(conversation.id);
      setMessages(conversation.id, data.data.messages);
      setPayments(data.data.payments || []);
      markRead(conversation.id);
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoading(false);
    }
  }, [conversation.id, setMessages, markRead]);

  useEffect(() => {
    setLoading(true);
    loadMessages();
    joinConversation(conversation.id);

    const socket = getSocket();
    if (socket) {
      const handleMessage = (msg: Message) => {
        addMessage(msg);
      };

      // Al reconectar el socket, volver a unirse a la sala y recargar mensajes
      const handleReconnect = () => {
        joinConversation(conversation.id);
        loadMessages();
      };

      socket.on('message', handleMessage);
      socket.on('connect', handleReconnect);

      return () => {
        leaveConversation(conversation.id);
        socket.off('message', handleMessage);
        socket.off('connect', handleReconnect);
      };
    }

    return () => { leaveConversation(conversation.id); };
  }, [conversation.id, loadMessages, addMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [convMessages.length]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;

    setSending(true);
    const tempText = text.trim();
    setText('');

    try {
      const { data } = await api.sendMessage(conversation.id, tempText);
      addMessage(data.data);
    } catch (err) {
      console.error('Failed to send:', err);
      setText(tempText);
    } finally {
      setSending(false);
    }
  };

  const handleTakeover = async () => {
    setActionLoading(true);
    try {
      await api.takeover(conversation.id, 'Intervención manual del agente');
      onUpdate();
    } catch (err) {
      console.error('Takeover failed:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRelease = async () => {
    setActionLoading(true);
    try {
      await api.release(conversation.id);
      onUpdate();
    } catch (err) {
      console.error('Release failed:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const isHuman = conversation.status === 'human';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-slate-800/60 bg-[#0d1424] shrink-0">
        <button onClick={onBack} className="lg:hidden btn-ghost p-2">
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* Avatar */}
        <div className="relative">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-700 to-slate-600 flex items-center justify-center text-white font-semibold">
            {(conversation.display_name || conversation.phone).charAt(0).toUpperCase()}
          </div>
          <span className={clsx(
            'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0d1424]',
            isHuman ? 'bg-yellow-500 shadow-[0_0_6px_#f59e0b]' : 'bg-blue-500 shadow-[0_0_6px_#3b82f6]'
          )} />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white text-sm truncate">
            {conversation.display_name || conversation.phone}
          </h3>
          <div className="flex items-center gap-2 text-xs">
            <Phone className="w-3 h-3 text-slate-500" />
            <span className="text-slate-500">{conversation.phone}</span>
            {isHuman ? (
              <span className="text-yellow-400 flex items-center gap-1">
                <User className="w-3 h-3" />
                {conversation.agent_name || 'Asesor'}
              </span>
            ) : (
              <span className="text-blue-400 flex items-center gap-1">
                <Bot className="w-3 h-3" />
                Bot activo
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {payments.length > 0 && (
            <button
              onClick={() => setShowPaymentsPanel(!showPaymentsPanel)}
              className={clsx('btn-ghost text-xs', showPaymentsPanel && 'text-blue-400')}
            >
              <CreditCard className="w-4 h-4" />
              <span className="hidden sm:inline">{payments.length} pago{payments.length !== 1 ? 's' : ''}</span>
            </button>
          )}

          {isHuman ? (
            <button
              onClick={handleRelease}
              disabled={actionLoading}
              className="btn-ghost text-xs text-green-400 hover:bg-green-500/10 border border-green-500/20"
            >
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
              <span className="hidden sm:inline">Activar Bot</span>
            </button>
          ) : (
            <button
              onClick={handleTakeover}
              disabled={actionLoading}
              className="btn-ghost text-xs text-yellow-400 hover:bg-yellow-500/10 border border-yellow-500/20"
            >
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
              <span className="hidden sm:inline">Tomar Control</span>
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Messages */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {loading ? (
              <div className="flex justify-center py-8">
                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : convMessages.length === 0 ? (
              <p className="text-center text-slate-600 text-sm py-8">Sin mensajes</p>
            ) : (
              convMessages.map((msg) => <MessageBubble key={msg.id} msg={msg} onVoucherClick={() => {
                const p = payments.find(p => p.message_id === msg.id);
                if (p) setSelectedVoucher(p);
              }} />)
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-slate-800/60 shrink-0">
            {!isHuman && (
              <div className="flex items-center gap-2 text-xs text-slate-600 mb-2">
                <Bot className="w-3 h-3" />
                <span>El bot está respondiendo automáticamente. Toma el control para responder.</span>
              </div>
            )}
            <form onSubmit={handleSend} className="flex gap-2">
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={!isHuman}
                placeholder={isHuman ? 'Escribe un mensaje...' : 'Toma control para responder'}
                className="input-field py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                disabled={!isHuman || !text.trim() || sending}
                className="btn-primary px-4 py-2.5 shrink-0"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </form>
          </div>
        </div>

        {/* Payments Side Panel */}
        {showPaymentsPanel && (
          <div className="w-72 border-l border-slate-800/60 flex flex-col bg-[#0d1424] overflow-y-auto">
            <div className="p-3 border-b border-slate-800/60">
              <h4 className="text-sm font-medium text-white flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-blue-400" />
                Comprobantes
              </h4>
            </div>
            <div className="p-3 space-y-2">
              {payments.map((p) => {
                const cfg = PAYMENT_STATUS[p.status] || PAYMENT_STATUS.pending;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedVoucher(p)}
                    className="w-full text-left p-3 rounded-xl bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 transition-all"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={clsx('text-xs font-medium flex items-center gap-1', cfg.color)}>
                        <cfg.icon className="w-3 h-3" />
                        {cfg.label}
                      </span>
                      {p.amount && <span className="text-xs font-bold text-white">S/{p.amount}</span>}
                    </div>
                    <p className="text-[10px] text-slate-500 capitalize">{p.payment_method || 'Desconocido'}</p>
                    {p.operation_code && (
                      <p className="text-[10px] text-slate-600 font-mono truncate">{p.operation_code}</p>
                    )}
                    {p.voucher_url && (
                      <div className="flex items-center gap-1 mt-1.5 text-blue-400 text-[10px]">
                        <ImageIcon className="w-3 h-3" />
                        Ver voucher
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Voucher Modal */}
      {selectedVoucher && (
        <VoucherModal
          payment={selectedVoucher}
          onClose={() => setSelectedVoucher(null)}
          onValidate={async (notes) => {
            await api.validatePayment(selectedVoucher.id, notes);
            loadMessages();
            setSelectedVoucher(null);
          }}
          onReject={async (reason) => {
            await api.rejectPayment(selectedVoucher.id, reason);
            loadMessages();
            setSelectedVoucher(null);
          }}
        />
      )}
    </div>
  );
}

function MessageBubble({ msg, onVoucherClick }: { msg: Message; onVoucherClick: () => void }) {
  const isInbound = msg.direction === 'inbound';
  const isBot = msg.sender_type === 'bot';
  const isAgent = msg.sender_type === 'agent';

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  return (
    <div className={clsx('flex gap-2', isInbound ? 'justify-start' : 'justify-end')}>
      {isInbound && (
        <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center shrink-0 mt-1">
          <span className="text-xs">👤</span>
        </div>
      )}

      <div className="max-w-[75%]">
        {/* Sender label */}
        <p className={clsx('text-[10px] mb-1', isInbound ? 'text-slate-500' : isBot ? 'text-blue-400' : 'text-green-400')}>
          {isInbound ? 'Cliente' : isBot ? '🤖 Bot' : `👨‍💼 ${msg.agent_name || 'Asesor'}`}
        </p>

        {/* Media message */}
        {msg.message_type === 'image' && msg.media_url && (
          <div
            className="rounded-2xl overflow-hidden cursor-pointer max-w-[220px]"
            onClick={onVoucherClick}
          >
            <img
              src={`${API_URL}${msg.media_url}`}
              alt="Voucher"
              className="w-full rounded-2xl hover:opacity-80 transition-opacity"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <div className="text-xs text-blue-400 mt-1 flex items-center gap-1">
              <ImageIcon className="w-3 h-3" />
              Ver comprobante
            </div>
          </div>
        )}

        {/* Text message */}
        {msg.body && (
          <div className={clsx(
            'msg-bubble',
            isInbound ? 'inbound' : isBot ? 'bot' : 'agent',
          )}>
            <p className="text-sm text-slate-200 whitespace-pre-wrap">{msg.body}</p>
          </div>
        )}

        {/* Timestamp */}
        <p className={clsx('text-[10px] mt-1', isInbound ? 'text-slate-600' : 'text-right text-slate-600')}>
          {format(new Date(msg.created_at), 'HH:mm', { locale: es })}
          {!isInbound && <CheckCheck className="inline w-3 h-3 ml-1 text-blue-400" />}
        </p>
      </div>

      {!isInbound && (
        <div className={clsx(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-1 text-xs',
          isBot ? 'bg-blue-600/30 text-blue-400' : 'bg-green-600/30 text-green-400'
        )}>
          {isBot ? <Bot className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
        </div>
      )}
    </div>
  );
}
