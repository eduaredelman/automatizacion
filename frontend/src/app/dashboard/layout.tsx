'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth.store';
import Sidebar from '@/components/Sidebar';
import { getSocket, disconnectSocket } from '@/lib/socket';
import { useChatStore } from '@/store/chat.store';
import { playSound, unlockAudio } from '@/lib/sounds';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { logout } = useAuthStore();
  const { prependConversation, updateConversation, addMessage } = useChatStore();

  // Guard: redirigir si no hay token
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('wp_token');
    if (!token) router.replace('/login');
  }, [router]);

  // Desbloquear AudioContext con la primera interacción del usuario
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('click', unlock, { once: true });
    return () => window.removeEventListener('click', unlock);
  }, []);

  // Socket.IO - eventos en tiempo real + sonidos
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewMessage = ({ conversation, message }: {
      conversation: Parameters<typeof prependConversation>[0];
      message: Parameters<typeof addMessage>[0];
    }) => {
      prependConversation(conversation);
      addMessage(message);
      // Sonido solo si el mensaje es del cliente (inbound)
      if ((message as { direction?: string }).direction === 'inbound') {
        playSound('message');
      }
    };

    const handleConversationUpdate = ({ conversationId, status, agent }: {
      conversationId: string;
      status: 'bot' | 'human' | 'resolved' | 'spam';
      agent?: { name: string } | null;
    }) => {
      updateConversation(conversationId, { status, agent_name: agent?.name });
      // Sonido de alerta cuando un cliente pide asesor humano
      if (status === 'human') {
        playSound('takeover');
      }
    };

    const handlePaymentUpdate = ({ status }: { conversationId: string; status: string }) => {
      // Sonido de pago cuando se valida un voucher
      if (status === 'success' || status === 'validated') {
        playSound('payment');
      }
    };

    socket.on('new_message', handleNewMessage);
    socket.on('conversation_update', handleConversationUpdate);
    socket.on('payment_update', handlePaymentUpdate);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('conversation_update', handleConversationUpdate);
      socket.off('payment_update', handlePaymentUpdate);
    };
  }, [prependConversation, addMessage, updateConversation]);

  const handleLogout = () => {
    disconnectSocket();
    logout();
    router.push('/login');
  };

  return (
    <div className="h-screen flex overflow-hidden bg-[#0a0f1e]">
      <Sidebar onLogout={handleLogout} />
      <main className="flex-1 overflow-hidden min-w-0">
        {children}
      </main>
    </div>
  );
}
