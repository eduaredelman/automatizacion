import { create } from 'zustand';

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

interface Conversation {
  id: string;
  phone: string;
  display_name: string;
  status: 'bot' | 'human' | 'resolved' | 'spam';
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
  agent_name?: string;
  payment_count?: number;
  bot_intent?: string;
  client_service_status?: string;
  client_debt?: number;
  client_plan?: string;
  client_plan_price?: number;
  client_wisphub_id?: string;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  unreadTotal: number;
  pendingOpenPhone: string | null;
  pendingOpenConvId: string | null;
  setConversations: (convs: Conversation[]) => void;
  setActiveConversation: (id: string | null) => void;
  addMessage: (msg: Message) => void;
  setMessages: (conversationId: string, msgs: Message[]) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  prependConversation: (conv: Conversation) => void;
  markRead: (id: string) => void;
  computeUnread: () => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  setPendingOpenPhone: (phone: string | null) => void;
  setPendingOpenConvId: (id: string | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},
  unreadTotal: 0,
  pendingOpenPhone: null,
  pendingOpenConvId: null,

  setConversations: (convs) => {
    set({ conversations: convs });
    get().computeUnread();
  },

  setActiveConversation: (id) => set({ activeConversationId: id }),

  addMessage: (msg) => {
    const { messages } = get();
    const existing = messages[msg.conversation_id] || [];
    // Evitar duplicados: el layout (new_message) y el ChatWindow (message) pueden
    // recibir el mismo mensaje si el agente está en la sala de la conversación
    if (existing.some((m) => m.id === msg.id)) return;
    set({
      messages: {
        ...messages,
        [msg.conversation_id]: [...existing, msg],
      },
    });
  },

  setMessages: (conversationId, msgs) => {
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
    }));
  },

  updateConversation: (id, updates) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    }));
    get().computeUnread();
  },

  prependConversation: (conv) => {
    set((state) => {
      const existing = state.conversations.find((c) => c.id === conv.id);
      // Merge con datos existentes para no perder campos si conv llega incompleto
      const merged = existing ? { ...existing, ...conv } : conv;
      const filtered = state.conversations.filter((c) => c.id !== conv.id);
      return { conversations: [merged, ...filtered] };
    });
    get().computeUnread();
  },

  markRead: (id) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, unread_count: 0 } : c
      ),
    }));
    get().computeUnread();
  },

  computeUnread: () => {
    const total = get().conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    set({ unreadTotal: total });
  },

  removeMessage: (conversationId, messageId) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).filter(m => m.id !== messageId),
      },
    }));
  },

  updateMessage: (conversationId, messageId, updates) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).map(m =>
          m.id === messageId ? { ...m, ...updates } : m
        ),
      },
    }));
  },

  setPendingOpenPhone: (phone) => set({ pendingOpenPhone: phone }),
  setPendingOpenConvId: (id) => set({ pendingOpenConvId: id }),
}));
