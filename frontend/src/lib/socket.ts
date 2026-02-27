import { io, Socket } from 'socket.io-client';

// En producción: wss://pagos.fiber-peru.com/socket.io
// NPM Custom Location /socket.io → pagos-backend:3001 (con WebSocket ON), bypaseando Next.js
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

let socket: Socket | null = null;

export const getSocket = (): Socket | null => {
  if (typeof window === 'undefined') return null;

  if (!socket) {
    const token = localStorage.getItem('wp_token');
    if (!token) return null;

    socket = io(SOCKET_URL, {
      // Sin path custom → usa /socket.io por defecto
      // NPM enruta wss://pagos.fiber-peru.com/socket.io → pagos-backend:3001 (Custom Location)
      auth: { token },
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket?.id);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
    });

    socket.on('connect_error', (err) => {
      console.error('[Socket] Connection error:', err.message);
    });
  }

  return socket;
};

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export const joinConversation = (conversationId: string) => {
  const s = socket;
  if (!s) return;
  if (s.connected) {
    s.emit('join_conversation', conversationId);
  } else {
    // Si aún no está conectado, esperar el evento connect para unirse
    s.once('connect', () => s.emit('join_conversation', conversationId));
  }
};

export const leaveConversation = (conversationId: string) => {
  socket?.emit('leave_conversation', conversationId);
};

export const emitTyping = (conversationId: string) => {
  socket?.emit('typing', { conversationId });
};

export default { getSocket, disconnectSocket, joinConversation, leaveConversation };
