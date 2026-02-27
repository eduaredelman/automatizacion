import { io, Socket } from 'socket.io-client';

// Misma URL base que el API — en producción es el dominio público
// y Next.js tiene el rewrite /api/:path* → http://backend:3001/api/:path*
// El path /api/socket.io cruza por ese rewrite llegando al backend correctamente.
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

let socket: Socket | null = null;

export const getSocket = (): Socket | null => {
  if (typeof window === 'undefined') return null;

  if (!socket) {
    const token = localStorage.getItem('wp_token');
    if (!token) return null;

    socket = io(SOCKET_URL, {
      path: '/api/socket.io',
      auth: { token },
      // polling primero (funciona a través del rewrite de Next.js),
      // luego intenta upgrade a WebSocket si NPM lo permite
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
