import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api from '../lib/api';

interface Agent {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar_url: string | null;
}

interface AuthState {
  token: string | null;
  agent: Agent | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setAgent: (agent: Agent) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      agent: null,
      isLoading: false,

      login: async (email, password) => {
        set({ isLoading: true });
        try {
          const { data } = await api.login(email, password);
          // Zustand persist (name: 'wp-auth') escribe automáticamente en localStorage.
          // NO escribir también en 'wp_token' para evitar doble fuente de verdad.
          set({ token: data.data.token, agent: data.data.agent, isLoading: false });
        } catch (err) {
          set({ isLoading: false });
          throw err;
        }
      },

      logout: () => {
        // Zustand persist limpia 'wp-auth' automáticamente al hacer set(null).
        // Limpiar también 'wp_token' legacy por si quedó de versiones anteriores.
        if (typeof window !== 'undefined') localStorage.removeItem('wp_token');
        set({ token: null, agent: null });
      },

      setAgent: (agent) => set({ agent }),
    }),
    {
      name: 'wp-auth',
      partialize: (state) => ({ token: state.token, agent: state.agent }),
    }
  )
);
