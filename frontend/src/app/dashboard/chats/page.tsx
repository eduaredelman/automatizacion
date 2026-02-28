'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import api from '@/lib/api';
import { useChatStore } from '@/store/chat.store';
import ChatList from '@/components/ChatList';
import ChatWindow from '@/components/ChatWindow';
import { MessageSquare } from 'lucide-react';

export default function ChatsPage() {
  const { conversations, setConversations, activeConversationId, setActiveConversation } = useChatStore();
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
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

  // Usar la conversación activa de la lista o la última conocida (evita que desaparezca al refrescar)
  const foundConversation = conversations.find(c => c.id === activeConversationId);
  const activeConversation = foundConversation ?? lastActiveRef.current ?? undefined;
  useEffect(() => {
    if (foundConversation) lastActiveRef.current = foundConversation;
  }, [foundConversation]);

  return (
    <div className="h-full flex overflow-hidden">
      {/* Panel lista de chats */}
      <div className={`${activeConversationId ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-96 xl:w-[420px] border-r border-slate-800/60`}>
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
