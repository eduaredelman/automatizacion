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
  ArrowLeft, Bot, User, Send, UserCheck, CheckCircle2 as CheckCircle,
  CreditCard, Phone, CheckCheck, Clock,
  AlertTriangle, XCircle, Loader2, Image as ImageIcon,
  Pencil, Check, X, Zap, Mic, Paperclip, FileText, ShieldCheck, Trash2, Plus,
  Download, Eye, FileSpreadsheet, FileType2,
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
  bot_intent?: string;
  client_service_status?: string;
  client_debt?: number;
  client_plan?: string;
  client_plan_price?: number;
  client_wisphub_id?: string;
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
  media_filename: string | null;
  whatsapp_status: string;
  agent_name?: string;
  created_at: string;
  is_edited?: boolean;
  is_deleted?: boolean;
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

/** Returns a date label like "Hoy", "Ayer", "lunes", "15 de enero" */
function getDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDate  = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays   = Math.round((startToday - startDate) / 86400000);

  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 7)  return format(date, 'EEEE', { locale: es }); // "lunes", "martes"...
  if (diffDays < 365) return format(date, "d 'de' MMMM", { locale: es });
  return format(date, "d MMM yyyy", { locale: es });
}

export default function ChatWindow({ conversation, onBack, onUpdate }: ChatWindowProps) {
  const { messages, setMessages, addMessage, markRead, removeMessage, updateMessage } = useChatStore();
  const { agent } = useAuthStore();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedVoucher, setSelectedVoucher] = useState<Payment | null>(null);
  const [showPaymentsPanel, setShowPaymentsPanel] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(conversation.display_name || conversation.phone);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [quickReplies, setQuickReplies] = useState<{ id: string; title: string; body: string }[]>([]);
  const [qrSearch, setQrSearch] = useState('');
  const [showAddQR, setShowAddQR] = useState(false);
  const [newQRTitle, setNewQRTitle] = useState('');
  const [newQRBody, setNewQRBody] = useState('');
  const [savingQR, setSavingQR] = useState(false);
  const [deletingMsgId, setDeletingMsgId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingMsgBody, setEditingMsgBody] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Cargar respuestas rápidas al montar
  useEffect(() => {
    api.getQuickReplies().then(r => setQuickReplies(r.data.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    loadMessages();
    joinConversation(conversation.id);

    const socket = getSocket();
    if (socket) {
      const handleMessage = (msg: Message) => { addMessage(msg); };

      const handleMessageDeleted = ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
        if (conversationId === conversation.id) removeMessage(conversationId, messageId);
      };

      const handleMessageDeletedForAll = ({ messageId, conversationId }: { messageId: string; conversationId: string }) => {
        if (conversationId === conversation.id) updateMessage(conversationId, messageId, { is_deleted: true, body: null, media_url: null });
      };

      const handleMessageEdited = (updated: { id: string; conversation_id: string; body: string; is_edited: boolean }) => {
        if (updated.conversation_id === conversation.id) {
          updateMessage(updated.conversation_id, updated.id, { body: updated.body, is_edited: true });
        }
      };

      const handleMediaReady = (data: { conversationId: string; messageId: string; media_url: string; media_mime: string; media_filename: string }) => {
        if (data.conversationId === conversation.id) {
          updateMessage(data.conversationId, data.messageId, {
            media_url: data.media_url,
            media_mime: data.media_mime,
            media_filename: data.media_filename,
          });
        }
      };

      const handleReconnect = () => {
        joinConversation(conversation.id);
        loadMessages();
      };

      socket.on('message', handleMessage);
      socket.on('message_deleted', handleMessageDeleted);
      socket.on('message_deleted_for_all', handleMessageDeletedForAll);
      socket.on('message_edited', handleMessageEdited);
      socket.on('message_media_ready', handleMediaReady);
      socket.on('connect', handleReconnect);

      return () => {
        leaveConversation(conversation.id);
        socket.off('message', handleMessage);
        socket.off('message_deleted', handleMessageDeleted);
        socket.off('message_deleted_for_all', handleMessageDeletedForAll);
        socket.off('message_edited', handleMessageEdited);
        socket.off('message_media_ready', handleMediaReady);
        socket.off('connect', handleReconnect);
      };
    }

    return () => { leaveConversation(conversation.id); };
  }, [conversation.id, loadMessages, addMessage, removeMessage, updateMessage]);

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

  const handleSendMedia = async () => {
    if (!mediaFile || sending) return;
    if (mediaFile.size > 25 * 1024 * 1024) {
      alert('El archivo supera el límite de 25 MB.');
      return;
    }
    setSending(true);
    const formData = new FormData();
    formData.append('file', mediaFile);
    if (text.trim()) formData.append('caption', text.trim());
    try {
      const { data } = await api.sendMedia(conversation.id, formData);
      addMessage(data.data);
      setMediaFile(null);
      setText('');
    } catch (err) {
      console.error('Failed to send media:', err);
    } finally {
      setSending(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      alert('El archivo supera el límite de 25 MB.');
      return;
    }
    setMediaFile(file);
    e.target.value = '';
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

  const handleSaveName = async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === (conversation.display_name || conversation.phone)) {
      setEditingName(false);
      return;
    }
    try {
      await api.updateChatName(conversation.id, trimmed);
      onUpdate();
    } catch (err) {
      console.error('Update name failed:', err);
    }
    setEditingName(false);
  };

  const startEditing = () => {
    setNewName(conversation.display_name || conversation.phone);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 50);
  };

  const handleDeleteMessage = async (msgId: string, scope: 'me' | 'all') => {
    if (scope === 'all') {
      if (!confirm('¿Eliminar para todos? El mensaje mostrará "Este mensaje fue eliminado".')) return;
    } else {
      if (!confirm('¿Eliminar este mensaje del CRM?')) return;
    }
    setDeletingMsgId(msgId);
    try {
      await api.deleteMessage(conversation.id, msgId, scope === 'all' ? 'all' : undefined);
      if (scope === 'me') {
        removeMessage(conversation.id, msgId);
      } else {
        updateMessage(conversation.id, msgId, { is_deleted: true, body: null, media_url: null });
      }
    } catch (err) {
      console.error('Delete message failed:', err);
    } finally {
      setDeletingMsgId(null);
    }
  };

  const handleStartEdit = (msg: Message) => {
    setEditingMsgId(msg.id);
    setEditingMsgBody(msg.body || '');
  };

  const handleSaveEdit = async (msgId: string) => {
    if (!editingMsgBody.trim()) return;
    setSavingEdit(true);
    try {
      await api.editMessage(conversation.id, msgId, editingMsgBody.trim());
      updateMessage(conversation.id, msgId, { body: editingMsgBody.trim(), is_edited: true });
      setEditingMsgId(null);
    } catch (err) {
      console.error('Edit message failed:', err);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSaveQR = async () => {
    if (!newQRTitle.trim() || !newQRBody.trim()) return;
    setSavingQR(true);
    try {
      const { data } = await api.createQuickReply(newQRTitle.trim(), newQRBody.trim());
      setQuickReplies(prev => [...prev, data.data]);
      setNewQRTitle('');
      setNewQRBody('');
      setShowAddQR(false);
    } catch (err) {
      console.error('Create QR failed:', err);
    } finally {
      setSavingQR(false);
    }
  };

  const handleDeleteQR = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.deleteQuickReply(id);
      setQuickReplies(prev => prev.filter(qr => qr.id !== id));
    } catch (err) {
      console.error('Delete QR failed:', err);
    }
  };

  const isHuman    = conversation.status === 'human';
  const isResolved = conversation.status === 'resolved';
  const isBot      = conversation.status === 'bot';

  // Build list with date separators
  const messageItems: ({ type: 'separator'; label: string; key: string } | { type: 'message'; msg: Message })[] = [];
  let lastDateLabel = '';
  for (const msg of convMessages) {
    const label = getDateLabel(msg.created_at);
    if (label !== lastDateLabel) {
      messageItems.push({ type: 'separator', label, key: `sep-${msg.id}` });
      lastDateLabel = label;
    }
    messageItems.push({ type: 'message', msg });
  }

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
            {(conversation.display_name || conversation.phone || '?').charAt(0).toUpperCase()}
          </div>
          <span className={clsx(
            'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0d1424]',
            isHuman    ? 'bg-yellow-500 shadow-[0_0_6px_#f59e0b]' :
            isResolved ? 'bg-green-500' :
                         'bg-blue-500 shadow-[0_0_6px_#3b82f6]'
          )} />
        </div>

        <div className="flex-1 min-w-0">
          {editingName ? (
            <div className="flex items-center gap-1">
              <input
                ref={nameInputRef}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingName(false); }}
                className="bg-slate-800 text-white text-sm rounded px-2 py-0.5 border border-slate-600 focus:border-blue-500 outline-none w-44"
                autoFocus
              />
              <button onClick={handleSaveName} className="text-green-400 hover:text-green-300 p-0.5"><Check className="w-4 h-4" /></button>
              <button onClick={() => setEditingName(false)} className="text-slate-400 hover:text-slate-300 p-0.5"><X className="w-4 h-4" /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 group">
              <h3 className="font-semibold text-white text-sm truncate">
                {conversation.display_name || conversation.phone}
              </h3>
              {conversation.wisphub_id && (
                <span className="shrink-0 text-[9px] bg-green-500/20 text-green-400 border border-green-500/30 rounded px-1 py-0.5 flex items-center gap-0.5">
                  <ShieldCheck className="w-2.5 h-2.5" />WispHub
                </span>
              )}
              {!conversation.wisphub_id && conversation.bot_intent === 'identity_ok' && (
                <span className="shrink-0 text-[9px] bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded px-1 py-0.5">
                  📝 Declarado
                </span>
              )}
              <button
                onClick={startEditing}
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 transition-opacity p-0.5"
                title="Editar nombre"
              >
                <Pencil className="w-3 h-3" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <Phone className="w-3 h-3 text-slate-500 shrink-0" />
            <span className="text-slate-500">{conversation.phone}</span>
            {isHuman ? (
              <span className="text-yellow-400 flex items-center gap-1">
                <User className="w-3 h-3" />
                {conversation.agent_name || 'Asesor'}
              </span>
            ) : isResolved ? (
              <span className="text-green-400 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                Resuelto
              </span>
            ) : (
              <span className="text-blue-400 flex items-center gap-1">
                <Bot className="w-3 h-3" />
                Bot activo
              </span>
            )}
            {(conversation.client_service_status || conversation.client_debt != null) && (
              <span className="flex items-center gap-1.5 ml-1">
                {conversation.client_service_status === 'cortado' && (
                  <span className="text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 rounded px-1.5 py-0.5 font-medium">
                    ⛔ Servicio cortado
                  </span>
                )}
                {conversation.client_service_status === 'activo' && (
                  <span className="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 rounded px-1.5 py-0.5 font-medium">
                    ✓ Activo
                  </span>
                )}
                {conversation.client_debt != null && conversation.client_debt > 0 && (
                  <span className="text-[10px] text-orange-400 font-semibold">
                    Deuda: S/{conversation.client_debt}
                  </span>
                )}
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

          {/* Activar Bot → visible cuando el asesor tiene control O cuando está resuelto */}
          {(isHuman || isResolved) && (
            <button
              onClick={handleRelease}
              disabled={actionLoading}
              className="btn-ghost text-xs text-blue-400 hover:bg-blue-500/10 border border-blue-500/20"
            >
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
              <span className="hidden sm:inline">Activar Bot</span>
            </button>
          )}

          {/* Tomar Control → visible cuando el bot está activo O cuando está resuelto */}
          {(isBot || isResolved) && (
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
          <div className="flex-1 overflow-y-auto p-4 space-y-1">
            {loading ? (
              <div className="flex justify-center py-8">
                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : convMessages.length === 0 ? (
              <p className="text-center text-slate-600 text-sm py-8">Sin mensajes</p>
            ) : (
              messageItems.map((item) => {
                if (item.type === 'separator') {
                  return (
                    <div key={item.key} className="flex items-center gap-3 py-3">
                      <div className="flex-1 h-px bg-slate-800/60" />
                      <span className="text-[10px] text-slate-600 font-medium uppercase tracking-wider px-2">
                        {item.label}
                      </span>
                      <div className="flex-1 h-px bg-slate-800/60" />
                    </div>
                  );
                }
                return (
                  <MessageBubble
                    key={item.msg.id}
                    msg={item.msg}
                    editingId={editingMsgId}
                    editingBody={editingMsgBody}
                    savingEdit={savingEdit}
                    onEditingBodyChange={setEditingMsgBody}
                    onVoucherClick={() => {
                      const p = payments.find(p => p.message_id === item.msg.id);
                      if (p) setSelectedVoucher(p);
                    }}
                    onDelete={handleDeleteMessage}
                    deletingId={deletingMsgId}
                    onStartEdit={handleStartEdit}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={() => setEditingMsgId(null)}
                  />
                );
              })
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-slate-800/60 shrink-0">
            {!isHuman && isBot && (
              <div className="flex items-center gap-2 text-xs text-slate-600 mb-2">
                <Bot className="w-3 h-3" />
                <span>El bot está respondiendo automáticamente. Toma el control para responder.</span>
              </div>
            )}
            {isResolved && (
              <div className="flex items-center gap-2 text-xs text-green-700 mb-2">
                <CheckCircle className="w-3 h-3" />
                <span>Conversación resuelta. Si el cliente escribe, el bot responderá automáticamente.</span>
              </div>
            )}
            <div className="relative">
              {/* Panel respuestas rápidas */}
              {showQuickReplies && isHuman && (
                <div className="absolute bottom-full mb-2 left-0 right-0 bg-[#0d1424] border border-slate-700 rounded-xl shadow-xl z-10 max-h-72 overflow-y-auto">
                  <div className="p-2 border-b border-slate-800 sticky top-0 bg-[#0d1424] flex gap-2">
                    <input
                      value={qrSearch}
                      onChange={e => { setQrSearch(e.target.value); setShowAddQR(false); }}
                      placeholder="Buscar respuesta rápida..."
                      className="input-field text-xs py-1.5 flex-1"
                      autoFocus={!showAddQR}
                    />
                    <button
                      type="button"
                      onClick={() => { setShowAddQR(!showAddQR); setQrSearch(''); }}
                      className={clsx('p-1.5 rounded-lg border transition-all shrink-0',
                        showAddQR
                          ? 'bg-green-500/20 text-green-400 border-green-500/30'
                          : 'text-slate-500 hover:text-green-400 border-slate-700 hover:border-green-500/30 hover:bg-green-500/10'
                      )}
                      title="Agregar respuesta rápida"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {showAddQR && (
                    <div className="p-3 border-b border-slate-800 bg-slate-900/40 space-y-2">
                      <input
                        value={newQRTitle}
                        onChange={e => setNewQRTitle(e.target.value)}
                        placeholder="Título (ej: Bienvenida)"
                        className="input-field text-xs py-1.5 w-full"
                        autoFocus
                      />
                      <textarea
                        value={newQRBody}
                        onChange={e => setNewQRBody(e.target.value)}
                        placeholder="Mensaje completo..."
                        rows={3}
                        className="input-field text-xs py-1.5 w-full resize-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => { setShowAddQR(false); setNewQRTitle(''); setNewQRBody(''); }}
                          className="flex-1 text-xs py-1.5 rounded-lg border border-slate-700 text-slate-500 hover:text-slate-300 transition-all"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveQR}
                          disabled={savingQR || !newQRTitle.trim() || !newQRBody.trim()}
                          className="flex-1 text-xs py-1.5 rounded-lg bg-green-600/20 border border-green-500/30 text-green-400 hover:bg-green-600/40 disabled:opacity-50 transition-all flex items-center justify-center gap-1"
                        >
                          {savingQR ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          Guardar
                        </button>
                      </div>
                    </div>
                  )}

                  {quickReplies
                    .filter(qr => !qrSearch || qr.title.toLowerCase().includes(qrSearch.toLowerCase()) || qr.body.toLowerCase().includes(qrSearch.toLowerCase()))
                    .map(qr => (
                      <div key={qr.id} className="flex items-start border-b border-slate-800/40 last:border-0 group/qr hover:bg-slate-800/60">
                        <button
                          type="button"
                          onClick={() => { setText(qr.body); setShowQuickReplies(false); setQrSearch(''); }}
                          className="flex-1 text-left px-3 py-2.5"
                        >
                          <p className="text-xs font-medium text-white">{qr.title}</p>
                          <p className="text-xs text-slate-500 truncate">{qr.body}</p>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => handleDeleteQR(qr.id, e)}
                          className="opacity-0 group-hover/qr:opacity-100 p-2 m-1 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                          title="Eliminar respuesta rápida"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))
                  }
                  {quickReplies.filter(qr => !qrSearch || qr.title.toLowerCase().includes(qrSearch.toLowerCase()) || qr.body.toLowerCase().includes(qrSearch.toLowerCase())).length === 0 && !showAddQR && (
                    <p className="text-xs text-slate-600 text-center py-4">Sin resultados</p>
                  )}
                </div>
              )}

              {/* Preview de archivo adjunto */}
              {mediaFile && isHuman && (
                <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-slate-800/60 rounded-xl border border-slate-700/40">
                  {mediaFile.type.startsWith('image/') ? (
                    <ImageIcon className="w-4 h-4 text-blue-400 shrink-0" />
                  ) : mediaFile.type.startsWith('audio/') ? (
                    <Mic className="w-4 h-4 text-purple-400 shrink-0" />
                  ) : mediaFile.type === 'application/pdf' ? (
                    <FileText className="w-4 h-4 text-red-400 shrink-0" />
                  ) : mediaFile.type.includes('spreadsheet') || mediaFile.type.includes('excel') ? (
                    <FileSpreadsheet className="w-4 h-4 text-green-400 shrink-0" />
                  ) : (
                    <FileType2 className="w-4 h-4 text-orange-400 shrink-0" />
                  )}
                  <span className="text-xs text-slate-300 truncate flex-1">{mediaFile.name}</span>
                  <span className="text-[10px] text-slate-500 shrink-0">
                    {(mediaFile.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                  <button
                    type="button"
                    onClick={() => setMediaFile(null)}
                    className="text-slate-500 hover:text-red-400 p-0.5 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Input oculto para seleccionar archivo */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,audio/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                className="hidden"
                onChange={handleFileSelect}
              />

              <form onSubmit={mediaFile ? (e) => { e.preventDefault(); handleSendMedia(); } : handleSend} className="flex gap-2">
                {isHuman && (
                  <button
                    type="button"
                    onClick={() => { setShowQuickReplies(!showQuickReplies); setQrSearch(''); }}
                    className={clsx('btn-ghost px-3 py-2.5 shrink-0', showQuickReplies ? 'text-yellow-400 bg-yellow-400/10' : 'text-slate-500 hover:text-yellow-400')}
                    title="Respuestas rápidas"
                  >
                    <Zap className="w-4 h-4" />
                  </button>
                )}
                {isHuman && (
                  <button
                    type="button"
                    onClick={() => { fileInputRef.current?.click(); setShowQuickReplies(false); }}
                    className={clsx('btn-ghost px-3 py-2.5 shrink-0', mediaFile ? 'text-blue-400 bg-blue-400/10' : 'text-slate-500 hover:text-blue-400')}
                    title="Adjuntar imagen, PDF, Word, Excel, audio (máx. 25 MB)"
                  >
                    <Paperclip className="w-4 h-4" />
                  </button>
                )}
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={!isHuman}
                  placeholder={isHuman ? (mediaFile ? 'Escribe un pie de foto (opcional)...' : 'Escribe un mensaje...') : 'Toma control para responder'}
                  className="input-field py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  onFocus={() => setShowQuickReplies(false)}
                />
                <button
                  type="submit"
                  disabled={!isHuman || (!text.trim() && !mediaFile) || sending}
                  className="btn-primary px-4 py-2.5 shrink-0"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </form>
            </div>
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
            const res = await api.validatePayment(selectedVoucher.id, notes);
            const d = res.data?.data;
            loadMessages();
            return { registered: d?.wisphub_registered ?? false, error: d?.wisphub_error ?? null };
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

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────

function getDocIcon(mime: string | null) {
  if (!mime) return <FileText className="w-5 h-5 text-orange-400 shrink-0" />;
  if (mime.includes('pdf'))         return <FileText className="w-5 h-5 text-red-400 shrink-0" />;
  if (mime.includes('spreadsheet') || mime.includes('excel'))
    return <FileSpreadsheet className="w-5 h-5 text-green-400 shrink-0" />;
  return <FileType2 className="w-5 h-5 text-orange-400 shrink-0" />;
}

// ─────────────────────────────────────────────────
// MessageBubble
// ─────────────────────────────────────────────────

function MessageBubble({
  msg,
  editingId,
  editingBody,
  savingEdit,
  onEditingBodyChange,
  onVoucherClick,
  onDelete,
  deletingId,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  msg: Message;
  editingId: string | null;
  editingBody: string;
  savingEdit: boolean;
  onEditingBodyChange: (v: string) => void;
  onVoucherClick: () => void;
  onDelete: (id: string, scope: 'me' | 'all') => void;
  deletingId: string | null;
  onStartEdit: (msg: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
}) {
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const isInbound  = msg.direction === 'inbound';
  const isBot      = msg.sender_type === 'bot';
  const isSystem   = msg.sender_type === 'system';
  const canEdit    = !isInbound && !isSystem && msg.message_type === 'text' && !msg.is_deleted;
  const canDelete  = !isInbound && !isSystem;
  const isEditing  = editingId === msg.id;

  const isDocOrFile = (
    msg.message_type === 'document' ||
    (msg.media_mime && !msg.media_mime.startsWith('image/') && !msg.media_mime.startsWith('audio/') && !msg.media_mime.startsWith('video/'))
  );

  const mediaHref = msg.media_url ? `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}${msg.media_url}` : '';

  return (
    <div
      className={clsx('flex gap-2 group/msg mb-1', isInbound ? 'justify-start' : 'justify-end')}
      onClick={() => showDeleteMenu && setShowDeleteMenu(false)}
    >
      {isInbound && (
        <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center shrink-0 mt-1">
          <span className="text-xs">👤</span>
        </div>
      )}

      <div className="max-w-[75%]">
        {/* Sender label */}
        {!isSystem && (
          <p className={clsx('text-[10px] mb-1', isInbound ? 'text-slate-500' : isBot ? 'text-blue-400' : 'text-green-400')}>
            {isInbound ? 'Cliente' : isBot ? '🤖 Bot' : `👨‍💼 ${msg.agent_name || 'Asesor'}`}
          </p>
        )}

        {/* ── Deleted placeholder ── */}
        {msg.is_deleted ? (
          <div className="rounded-2xl px-3 py-2 bg-slate-800/40 border border-slate-700/30 text-slate-500 text-xs italic flex items-center gap-1.5">
            🚫 Este mensaje fue eliminado
          </div>
        ) : (
          <>
            {/* ── Audio ── */}
            {(msg.message_type === 'audio' || msg.message_type === 'voice') && msg.media_url && (
              <div className="rounded-2xl bg-slate-800/60 px-3 py-2.5 max-w-[280px] border border-slate-700/40">
                <div className="flex items-center gap-2 mb-1.5">
                  <Mic className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="text-[10px] text-slate-500">Nota de voz</span>
                </div>
                <audio controls className="w-full" style={{ height: '36px' }}>
                  <source src={mediaHref} type={msg.media_mime || 'audio/ogg'} />
                </audio>
                {msg.body && (
                  <p className="text-xs text-slate-400 mt-1.5 italic border-t border-slate-700/40 pt-1.5">
                    📝 {msg.body}
                  </p>
                )}
              </div>
            )}

            {/* ── Image ── */}
            {msg.message_type === 'image' && msg.media_url && (
              <div className="rounded-2xl overflow-hidden max-w-[220px]">
                <img
                  src={mediaHref}
                  alt="Imagen"
                  className="w-full rounded-2xl cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={onVoucherClick}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                {msg.body && (
                  <p className="text-xs text-slate-300 mt-1 px-0.5">{msg.body}</p>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <a
                    href={mediaHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    <Eye className="w-3 h-3" /> Ver
                  </a>
                  <a
                    href={mediaHref}
                    download={msg.media_filename || 'imagen'}
                    className="text-xs text-green-400 hover:text-green-300 flex items-center gap-1"
                  >
                    <Download className="w-3 h-3" /> Descargar
                  </a>
                </div>
              </div>
            )}

            {/* ── Document / File ── */}
            {isDocOrFile && msg.media_url && (
              <div className="rounded-2xl bg-slate-800/60 px-3 py-2.5 max-w-[280px] border border-slate-700/40">
                <div className="flex items-start gap-2 mb-2">
                  {getDocIcon(msg.media_mime)}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-200 font-medium truncate">
                      {msg.media_filename || 'Documento'}
                    </p>
                    {msg.media_mime && (
                      <p className="text-[10px] text-slate-500 uppercase">
                        {msg.media_mime.split('/').pop()?.replace('vnd.openxmlformats-officedocument.', '')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-3">
                  <a
                    href={mediaHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium"
                  >
                    <Eye className="w-3 h-3" /> Ver
                  </a>
                  <a
                    href={mediaHref}
                    download={msg.media_filename || 'documento'}
                    className="text-xs text-green-400 hover:text-green-300 flex items-center gap-1 font-medium"
                  >
                    <Download className="w-3 h-3" /> Descargar
                  </a>
                </div>
                {msg.body && (
                  <p className="text-xs text-slate-400 mt-1.5 italic border-t border-slate-700/40 pt-1.5">
                    {msg.body}
                  </p>
                )}
              </div>
            )}

            {/* ── Text ── */}
            {msg.body && msg.message_type === 'text' && !isDocOrFile && (
              isEditing ? (
                <div className="space-y-1.5">
                  <textarea
                    value={editingBody}
                    onChange={e => onEditingBodyChange(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit(msg.id); }
                      if (e.key === 'Escape') onCancelEdit();
                    }}
                    rows={Math.min(6, editingBody.split('\n').length + 1)}
                    className="w-full bg-slate-800 border border-blue-500/40 rounded-xl px-3 py-2 text-sm text-slate-200 outline-none resize-none focus:border-blue-500"
                    autoFocus
                  />
                  <div className="flex gap-1.5 justify-end">
                    <button onClick={onCancelEdit} className="text-xs px-2.5 py-1 rounded-lg text-slate-500 hover:text-slate-300 border border-slate-700 transition-all">
                      Cancelar
                    </button>
                    <button
                      onClick={() => onSaveEdit(msg.id)}
                      disabled={savingEdit || !editingBody.trim()}
                      className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/30 text-blue-300 border border-blue-500/40 hover:bg-blue-600/50 disabled:opacity-50 flex items-center gap-1 transition-all"
                    >
                      {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Guardar
                    </button>
                  </div>
                </div>
              ) : (
                <div className={clsx('msg-bubble', isInbound ? 'inbound' : isBot ? 'bot' : 'agent')}>
                  <p className="text-sm text-slate-200 whitespace-pre-wrap">{msg.body}</p>
                  {msg.is_edited && (
                    <span className="text-[9px] text-slate-500 italic mt-0.5 block">(editado)</span>
                  )}
                </div>
              )
            )}
          </>
        )}

        {/* Timestamp + actions row */}
        {!isEditing && (
          <div className={clsx('flex items-center gap-1 mt-1', isInbound ? 'justify-start' : 'justify-end')}>
            {canDelete && !msg.is_deleted && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowDeleteMenu(v => !v); }}
                  disabled={deletingId === msg.id}
                  className="opacity-0 group-hover/msg:opacity-100 text-slate-600 hover:text-red-400 transition-all p-0.5 rounded disabled:opacity-30"
                  title="Eliminar mensaje"
                >
                  {deletingId === msg.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Trash2 className="w-3 h-3" />
                  }
                </button>
                {showDeleteMenu && (
                  <div className="absolute bottom-full right-0 mb-1 bg-[#0d1424] border border-slate-700 rounded-xl shadow-xl z-20 min-w-[160px] overflow-hidden">
                    <button
                      onClick={() => { setShowDeleteMenu(false); onDelete(msg.id, 'me'); }}
                      className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 flex items-center gap-2"
                    >
                      <Trash2 className="w-3 h-3 text-slate-500" />
                      Eliminar del CRM
                    </button>
                    <button
                      onClick={() => { setShowDeleteMenu(false); onDelete(msg.id, 'all'); }}
                      className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 flex items-center gap-2 border-t border-slate-800"
                    >
                      <Trash2 className="w-3 h-3" />
                      Eliminar para todos
                    </button>
                  </div>
                )}
              </div>
            )}
            {canEdit && (
              <button
                onClick={() => onStartEdit(msg)}
                className="opacity-0 group-hover/msg:opacity-100 text-slate-600 hover:text-blue-400 transition-all p-0.5 rounded"
                title="Editar mensaje"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
            <p className="text-[10px] text-slate-600">
              {format(new Date(msg.created_at), 'HH:mm', { locale: es })}
              {!isInbound && <CheckCheck className="inline w-3 h-3 ml-1 text-blue-400" />}
            </p>
          </div>
        )}
      </div>

      {!isInbound && !isSystem && (
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
