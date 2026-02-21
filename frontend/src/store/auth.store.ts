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
          localStorage.setItem('wp_token', data.data.token);
          set({ token: data.data.token, agent: data.data.agent, isLoading: false });
        } catch (err) {
          set({ isLoading: false });
          throw err;
        }
      },

      logout: () => {
        localStorage.removeItem('wp_token');
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
