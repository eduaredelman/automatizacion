const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

let io;

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    // /api/socket.io → funciona a través del rewrite de Next.js (/api/:path* → backend)
    // Esto evita que Next.js bloquee la conexión (Next.js no puede proxy WebSocket)
    path: '/api/socket.io',
    cors: {
      origin: '*',
      credentials: false,
    },
    transports: ['polling', 'websocket'],
    pingInterval: 10000,
    pingTimeout: 20000,
    upgradeTimeout: 30000,
  });

  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.agent = decoded;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info('Agent connected via WebSocket', { agentId: socket.agent?.id });

    // Join agent to their personal room
    socket.join(`agent:${socket.agent.id}`);
    socket.join('agents'); // broadcast room

    socket.on('join_conversation', (conversationId) => {
      socket.join(`conversation:${conversationId}`);
      logger.debug('Agent joined conversation room', { conversationId });
    });

    socket.on('leave_conversation', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    socket.on('typing', ({ conversationId }) => {
      socket.to(`conversation:${conversationId}`).emit('agent_typing', {
        agentId: socket.agent.id,
        conversationId,
      });
    });

    socket.on('disconnect', (reason) => {
      logger.info('Agent disconnected', { agentId: socket.agent?.id, reason });
    });
  });

  return io;
};

// Emit to all connected agents
const emitToAgents = (event, data) => {
  if (io) io.to('agents').emit(event, data);
};

// Emit to agents watching a specific conversation
const emitToConversation = (conversationId, event, data) => {
  if (io) io.to(`conversation:${conversationId}`).emit(event, data);
};

// New incoming message event
const notifyNewMessage = (conversation, message) => {
  emitToAgents('new_message', { conversation, message });
  emitToConversation(conversation.id, 'message', message);
};

// Payment status update
const notifyPaymentUpdate = (payment) => {
  emitToAgents('payment_update', payment);
  if (payment.conversation_id) {
    emitToConversation(payment.conversation_id, 'payment_update', payment);
  }
};

// Takeover event
const notifyTakeover = (conversationId, agent) => {
  emitToConversation(conversationId, 'takeover', { conversationId, agent });
  emitToAgents('conversation_update', { conversationId, status: 'human', agent });
};

const getIO = () => io;

module.exports = { initSocket, getIO, emitToAgents, emitToConversation, notifyNewMessage, notifyPaymentUpdate, notifyTakeover };
