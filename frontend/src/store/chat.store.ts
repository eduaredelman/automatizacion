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
  whatsapp_status: string;
  agent_name?: string;
  created_at: string;
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
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  unreadTotal: number;
  setConversations: (convs: Conversation[]) => void;
  setActiveConversation: (id: string | null) => void;
  addMessage: (msg: Message) => void;
  setMessages: (conversationId: string, msgs: Message[]) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  prependConversation: (conv: Conversation) => void;
  markRead: (id: string) => void;
  computeUnread: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},
  unreadTotal: 0,

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
      const filtered = state.conversations.filter((c) => c.id !== conv.id);
      return { conversations: [conv, ...filtered] };
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
}));
