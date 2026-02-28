import axios, { AxiosInstance } from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

let apiInstance: AxiosInstance;

export const getApi = (): AxiosInstance => {
  if (!apiInstance) {
    apiInstance = axios.create({
      baseURL: `${API_URL}/api`,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });

    apiInstance.interceptors.request.use((config) => {
      const token = typeof window !== 'undefined'
        ? localStorage.getItem('wp_token')
        : null;
      if (token) config.headers.Authorization = `Bearer ${token}`;
      return config;
    });

    apiInstance.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err.response?.status === 401) {
          if (typeof window !== 'undefined') {
            localStorage.removeItem('wp_token');
            window.location.href = '/login';
          }
        }
        return Promise.reject(err);
      }
    );
  }
  return apiInstance;
};

export const api = {
  // Auth
  login: (email: string, password: string) =>
    getApi().post('/auth/login', { email, password }),
  me: () => getApi().get('/auth/me'),

  // Chats
  getChats: (params?: Record<string, unknown>) =>
    getApi().get('/chats', { params }),
  getChat: (id: string, params?: Record<string, unknown>) =>
    getApi().get(`/chats/${id}`, { params }),
  sendMessage: (id: string, text: string) =>
    getApi().post(`/chats/${id}/send`, { text }),
  takeover: (id: string, reason?: string) =>
    getApi().post(`/chats/${id}/takeover`, { reason }),
  release: (id: string) =>
    getApi().post(`/chats/${id}/release`),
  resolveChat: (id: string) =>
    getApi().post(`/chats/${id}/resolve`),
  getChatPayments: (id: string) =>
    getApi().get(`/chats/${id}/payments`),
  updateChatName: (id: string, name: string) =>
    getApi().patch(`/chats/${id}/name`, { name }),
  archiveChat: (id: string) =>
    getApi().delete(`/chats/${id}`),
  sendMedia: (chatId: string, formData: FormData) =>
    getApi().post(`/chats/${chatId}/send-media`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    }),
  startChat: (phone: string, message: string) =>
    getApi().post('/chats/start', { phone, message }),
  getQuickReplies: () =>
    getApi().get('/chats/quick-replies'),
  createQuickReply: (title: string, body: string, tags?: string[]) =>
    getApi().post('/chats/quick-replies', { title, body, tags }),
  deleteQuickReply: (id: string) =>
    getApi().delete(`/chats/quick-replies/${id}`),

  // Payments
  getPayments: (params?: Record<string, unknown>) =>
    getApi().get('/payments', { params }),
  getPaymentStats: () => getApi().get('/payments/stats'),
  getPayment: (id: string) => getApi().get(`/payments/${id}`),
  validatePayment: (id: string, notes?: string) =>
    getApi().patch(`/payments/${id}/validate`, { notes }),
  rejectPayment: (id: string, reason: string) =>
    getApi().patch(`/payments/${id}/reject`, { reason }),
  deletePayment: (id: string) =>
    getApi().delete(`/payments/${id}`),
};

export default api;
