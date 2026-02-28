'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import api from '@/lib/api';
import { useChatStore } from '@/store/chat.store';
import ChatList from '@/components/ChatList';
import ChatWindow from '@/components/ChatWindow';
import { MessageSquare, Plus, X, Send, Loader2 } from 'lucide-react';

export default function ChatsPage() {
  const { conversations, setConversations, activeConversationId, setActiveConversation } = useChatStore();
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [newPhone, setNewPhone] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [newChatError, setNewChatError] = useState('');
  // Guardar la última conversación activa vista para que no desaparezca al refrescar la lista
  const lastActiveRef = useRef<(typeof conversations)[0] | null>(null);

  const loadChats = useCallback(async () => {
    try {
      const { data } = await api.getChats({
        limit: 50,
        search: search || undefined,
        status: statusFilter || undefined,
      });
      setConversations(data.data);
    } catch (err) {
      console.error('Failed to load chats:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, setConversations]);

  useEffect(() => { loadChats(); }, [loadChats]);

  // Polling fallback cada 15s (respaldo del socket)
  useEffect(() => {
    const interval = setInterval(loadChats, 15000);
    return () => clearInterval(interval);
  }, [loadChats]);

  const handleArchive = useCallback(async (id: string) => {
    try {
      await api.archiveChat(id);
      // Si estaba seleccionado, deseleccionar
      if (activeConversationId === id) setActiveConversation(null);
      // Remover de la lista local inmediatamente
      setConversations(conversations.filter(c => c.id !== id));
    } catch (err) {
      console.error('Archive failed:', err);
    }
  }, [activeConversationId, conversations, setActiveConversation, setConversations]);

  const handleStartChat = async () => {
    if (!newPhone.trim() || !newMessage.trim()) {
      setNewChatError('Completa el número y el mensaje.');
      return;
    }
    setNewChatLoading(true);
    setNewChatError('');
    try {
      const { data } = await api.startChat(newPhone.trim(), newMessage.trim());
      setShowNewChat(false);
      setNewPhone('');
      setNewMessage('');
      await loadChats();
      setActiveConversation(data.data.conversationId);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Error al iniciar conversación';
      setNewChatError(msg);
    } finally {
      setNewChatLoading(false);
    }
  };

  // Usar la conversación activa de la lista o la última conocida (evita que desaparezca al refrescar)
  const foundConversation = conversations.find(c => c.id === activeConversationId);
  const activeConversation = foundConversation ?? lastActiveRef.current ?? undefined;
  useEffect(() => {
    if (foundConversation) lastActiveRef.current = foundConversation;
  }, [foundConversation]);

  return (
    <div className="h-full flex overflow-hidden">
      {/* Modal: Nuevo Chat */}
      {showNewChat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[#0d1424] border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between p-5 border-b border-slate-800">
              <h3 className="font-semibold text-white">Nuevo chat</h3>
              <button onClick={() => { setShowNewChat(false); setNewChatError(''); }} className="text-slate-500 hover:text-slate-300 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Número de teléfono</label>
                <input
                  type="text"
                  value={newPhone}
                  onChange={e => setNewPhone(e.target.value)}
                  placeholder="Ej: 51999888777 o 999888777"
                  className="input-field w-full"
                  autoFocus
                />
                <p className="text-[10px] text-slate-600 mt-1">Se añadirá el prefijo 51 (Perú) si no lo incluyes.</p>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Mensaje inicial</label>
                <textarea
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  placeholder="Escribe el primer mensaje..."
                  rows={3}
                  className="input-field w-full resize-none"
                  onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleStartChat(); }}
                />
                <p className="text-[10px] text-slate-600 mt-1">Ctrl+Enter para enviar</p>
              </div>
              {newChatError && (
                <p className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">{newChatError}</p>
              )}
            </div>
            <div className="flex gap-2 p-5 pt-0">
              <button
                onClick={() => { setShowNewChat(false); setNewChatError(''); }}
                className="btn-ghost flex-1 justify-center py-2.5 text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleStartChat}
                disabled={newChatLoading || !newPhone.trim() || !newMessage.trim()}
                className="btn-primary flex-1 justify-center py-2.5 text-sm gap-2"
              >
                {newChatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Iniciar conversación
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Panel lista de chats */}
      <div className={`${activeConversationId ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-96 xl:w-[420px] border-r border-slate-800/60 relative`}>
        {/* Botón nuevo chat — sobre el header de ChatList */}
        <div className="absolute top-3.5 right-14 z-10">
          <button
            onClick={() => { setShowNewChat(true); setNewChatError(''); }}
            className="btn-ghost px-2.5 py-1.5 text-xs text-blue-400 hover:bg-blue-500/10 border border-blue-500/20 flex items-center gap-1"
            title="Iniciar nueva conversación"
          >
            <Plus className="w-3.5 h-3.5" />
            Nuevo
          </button>
        </div>
        <ChatList
          conversations={conversations}
          loading={loading}
          search={search}
          onSearch={setSearch}
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          activeId={activeConversationId}
          onSelect={(id) => setActiveConversation(id)}
          onRefresh={loadChats}
          onArchive={handleArchive}
        />
      </div>

      {/* Ventana de chat */}
      <div className={`${activeConversationId ? 'flex' : 'hidden lg:flex'} flex-col flex-1 overflow-hidden`}>
        {activeConversationId && activeConversation ? (
          <ChatWindow
            conversation={activeConversation}
            onBack={() => setActiveConversation(null)}
            onUpdate={loadChats}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4">
            <div className="w-20 h-20 rounded-2xl bg-slate-800/50 flex items-center justify-center">
              <MessageSquare className="w-10 h-10 text-slate-600" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-slate-400">Selecciona una conversación</h3>
              <p className="text-sm text-slate-600 mt-1">Elige un chat de la lista para comenzar</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
