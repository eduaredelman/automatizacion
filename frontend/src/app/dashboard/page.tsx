'use client';
import { useEffect, useState } from 'react';
import api from '@/lib/api';
import {
  MessageSquare, CreditCard, CheckCircle, Clock,
  TrendingUp, Users, Zap, Activity
} from 'lucide-react';

interface Stats {
  payments: {
    total_validated: number;
    total_amount: number;
    today: number;
    by_status: Array<{ status: string; count: string }>;
    by_method: Array<{ payment_method: string; count: string; total: string }>;
  };
  conversations: {
    by_status: Array<{ status: string; count: string }>;
  };
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  validated:     { label: 'Validados',      color: 'text-green-400' },
  pending:       { label: 'Pendientes',     color: 'text-yellow-400' },
  rejected:      { label: 'Rechazados',     color: 'text-red-400' },
  duplicate:     { label: 'Duplicados',     color: 'text-purple-400' },
  processing:    { label: 'Procesando',     color: 'text-blue-400' },
  manual_review: { label: 'Revisión',       color: 'text-orange-400' },
};

const METHOD_ICONS: Record<string, string> = {
  yape: '💜', plin: '💛', bcp: '💙', interbank: '🟢',
  bbva: '🔵', scotiabank: '🔴', transfer: '🏦', unknown: '💳',
};

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPaymentStats()
      .then(({ data }) => setStats(data.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const convByStatus = (s: string) =>
    parseInt(stats?.conversations.by_status.find(x => x.status === s)?.count || '0');

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const cards = [
    {
      label: 'Pagos Validados',
      value: stats?.payments.total_validated || 0,
      sub: `S/ ${(stats?.payments.total_amount || 0).toFixed(2)} total`,
      icon: CheckCircle, color: 'text-green-400', bg: 'bg-green-500/10 border-green-500/20',
    },
    {
      label: 'Pagos Hoy',
      value: stats?.payments.today || 0,
      sub: 'registrados hoy',
      icon: TrendingUp, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20',
    },
    {
      label: 'Chats Bot',
      value: convByStatus('bot'),
      sub: 'bot activo',
      icon: Zap, color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/20',
    },
    {
      label: 'Chats Humano',
      value: convByStatus('human'),
      sub: 'con asesor',
      icon: Users, color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20',
    },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-slate-400 text-sm mt-1">Resumen de pagos y conversaciones en tiempo real</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        {cards.map((card) => (
          <div key={card.label} className={`glass rounded-2xl p-5 border ${card.bg} cyber-border`}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">{card.label}</p>
                <p className={`text-3xl font-bold ${card.color}`}>{card.value.toLocaleString()}</p>
                <p className="text-xs text-slate-500 mt-1">{card.sub}</p>
              </div>
              <div className={`p-2.5 rounded-xl ${card.bg}`}>
                <card.icon className={`w-5 h-5 ${card.color}`} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Payment Status Breakdown */}
        <div className="glass rounded-2xl p-6 border border-slate-700/50">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold text-white">Estado de Pagos</h3>
          </div>
          <div className="space-y-3">
            {(stats?.payments.by_status || []).map((item) => {
              const total = (stats?.payments.by_status || []).reduce((s, x) => s + parseInt(x.count), 0);
              const pct = total ? Math.round((parseInt(item.count) / total) * 100) : 0;
              const meta = STATUS_LABELS[item.status] || { label: item.status, color: 'text-slate-400' };
              return (
                <div key={item.status}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className={meta.color}>{meta.label}</span>
                    <span className="text-slate-400">{item.count} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-700"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Payment Methods */}
        <div className="glass rounded-2xl p-6 border border-slate-700/50">
          <div className="flex items-center gap-2 mb-4">
            <CreditCard className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold text-white">Medios de Pago</h3>
          </div>
          <div className="space-y-3">
            {(stats?.payments.by_method || []).slice(0, 6).map((item) => (
              <div key={item.payment_method} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{METHOD_ICONS[item.payment_method] || '💳'}</span>
                  <span className="text-sm text-slate-300 capitalize">{item.payment_method}</span>
                </div>
                <div className="text-right">
                  <span className="text-sm font-medium text-white">{item.count}</span>
                  <span className="text-xs text-slate-500 ml-2">S/ {parseFloat(item.total || '0').toFixed(2)}</span>
                </div>
              </div>
            ))}
            {!stats?.payments.by_method?.length && (
              <p className="text-slate-500 text-sm text-center py-4">Sin datos aún</p>
            )}
          </div>
        </div>

        {/* Conversations Status */}
        <div className="glass rounded-2xl p-6 border border-slate-700/50 xl:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="w-5 h-5 text-blue-400" />
            <h3 className="font-semibold text-white">Estado de Conversaciones</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { status: 'bot',      label: 'Bot Activo',  color: 'text-blue-400',   bg: 'bg-blue-500/10' },
              { status: 'human',    label: 'Con Asesor',  color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
              { status: 'resolved', label: 'Resueltos',   color: 'text-green-400',  bg: 'bg-green-500/10' },
              { status: 'spam',     label: 'Spam',        color: 'text-slate-400',  bg: 'bg-slate-500/10' },
            ].map(({ status, label, color, bg }) => (
              <div key={status} className={`rounded-xl p-4 ${bg} text-center`}>
                <p className={`text-2xl font-bold ${color}`}>{convByStatus(status)}</p>
                <p className="text-xs text-slate-400 mt-1">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
