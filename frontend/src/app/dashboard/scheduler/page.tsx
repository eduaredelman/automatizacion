'use client';
import { useEffect, useState } from 'react';
import { getApi } from '@/lib/api';
import {
  Calendar, Play, RefreshCw, Bell, Scissors,
  Clock, AlertTriangle, Loader2, CheckCircle2, XCircle, BarChart3,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import clsx from 'clsx';

interface SchedulerStatus {
  current_day: number;
  stats: {
    cobro_sent_today: number;
    corte_this_month: number;
    last_cobro_at: string | null;
    last_corte_at: string | null;
  };
  jobs: Array<{
    name: string;
    schedule: string;
    active_today: boolean;
    description: string;
  }>;
}

interface JobResult {
  enviados?: number;
  cortados?: number;
  errores?: number;
  total?: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

export default function SchedulerPage() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string; detail?: JobResult }>>({});

  const loadStatus = () => {
    getApi().get('/scheduler/status')
      .then(({ data }) => setStatus(data.data))
      .catch(console.error);
  };

  useEffect(() => { loadStatus(); }, []);

  const runJob = async (
    jobKey: string,
    endpoint: string,
    label: string,
    warning: string | null,
  ) => {
    if (warning && !confirm(warning)) return;
    setRunning(r => ({ ...r, [jobKey]: true }));
    setResults(r => ({ ...r, [jobKey]: { ok: true, text: '' } }));
    try {
      const { data } = await getApi().post(endpoint);
      const detail: JobResult = data.data || {};

      let text = '';
      if (detail.skipped) {
        text = `⚠️ Omitido: ${detail.reason || 'fuera de rango'}`;
      } else if (detail.enviados !== undefined) {
        text = `✅ ${detail.enviados} mensajes enviados de ${detail.total} clientes${detail.errores ? ` (${detail.errores} errores)` : ''}`;
      } else if (detail.cortados !== undefined) {
        text = `✅ ${detail.cortados} servicios cortados de ${detail.total} clientes${detail.errores ? ` (${detail.errores} errores)` : ''}`;
      } else {
        text = `✅ ${label} ejecutado correctamente`;
      }

      setResults(r => ({ ...r, [jobKey]: { ok: true, text, detail } }));
      loadStatus(); // Refrescar estadísticas
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setResults(r => ({
        ...r,
        [jobKey]: { ok: false, text: `❌ Error: ${e.response?.data?.message || 'Falló la ejecución'}` },
      }));
    } finally {
      setRunning(r => ({ ...r, [jobKey]: false }));
    }
  };

  const JOB_CONFIG = [
    {
      key: 'cobro',
      endpoint: '/scheduler/run/cobro',
      icon: Bell,
      label: 'Avisos de Cobro',
      color: 'text-blue-400',
      bg: 'bg-blue-500/10 border-blue-500/20',
      btnClass: 'bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border-blue-500/30',
      description: 'Envía recordatorio de pago a todos los clientes con deuda. Usa los contactos sincronizados de WispHub para los teléfonos. Se ejecuta automáticamente los días 1 al 5 a las 8:00 AM.',
      warning: '⚠️ Enviará mensajes de WhatsApp a TODOS los clientes con deuda pendiente. ¿Confirmar ejecución manual?',
    },
    {
      key: 'corte',
      endpoint: '/scheduler/run/corte',
      icon: Scissors,
      label: 'Corte de Servicio',
      color: 'text-red-400',
      bg: 'bg-red-500/10 border-red-500/20',
      btnClass: 'bg-red-600/20 hover:bg-red-600/40 text-red-400 border-red-500/30',
      description: 'Suspende el servicio de todos los clientes con deuda y les notifica por WhatsApp. Se ejecuta automáticamente el día 10 a las 9:00 AM.',
      warning: '🚨 ACCIÓN CRÍTICA: Se cortará el servicio de todos los clientes morosos en WispHub. ¿Confirmar?',
    },
    {
      key: 'sync',
      endpoint: '/scheduler/run/sync',
      icon: RefreshCw,
      label: 'Sincronizar Contactos',
      color: 'text-green-400',
      bg: 'bg-green-500/10 border-green-500/20',
      btnClass: 'bg-green-600/20 hover:bg-green-600/40 text-green-400 border-green-500/30',
      description: 'Actualiza la base de datos local con todos los contactos de WispHub (activos e inactivos). Se ejecuta automáticamente cada 5 minutos.',
      warning: null,
    },
  ];

  const stats = status?.stats;

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Calendar className="w-6 h-6 text-blue-400" />
          Automatizaciones Programadas
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Día actual del mes: <span className="text-white font-semibold">{status?.current_day || '...'}</span>
          &nbsp;·&nbsp;Los trabajos se ejecutan automáticamente según el calendario
        </p>
      </div>

      {/* Stats del día */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="glass rounded-xl p-4 border border-slate-700/50">
            <p className="text-xs text-slate-500 mb-1">Avisos enviados hoy</p>
            <p className="text-2xl font-bold text-blue-400">{stats.cobro_sent_today}</p>
          </div>
          <div className="glass rounded-xl p-4 border border-slate-700/50">
            <p className="text-xs text-slate-500 mb-1">Cortes este mes</p>
            <p className="text-2xl font-bold text-red-400">{stats.corte_this_month}</p>
          </div>
          <div className="glass rounded-xl p-4 border border-slate-700/50">
            <p className="text-xs text-slate-500 mb-1">Último aviso enviado</p>
            <p className="text-sm text-slate-300">
              {stats.last_cobro_at
                ? formatDistanceToNow(new Date(stats.last_cobro_at), { addSuffix: true, locale: es })
                : 'Nunca'}
            </p>
          </div>
          <div className="glass rounded-xl p-4 border border-slate-700/50">
            <p className="text-xs text-slate-500 mb-1">Último corte</p>
            <p className="text-sm text-slate-300">
              {stats.last_corte_at
                ? formatDistanceToNow(new Date(stats.last_corte_at), { addSuffix: true, locale: es })
                : 'Nunca'}
            </p>
          </div>
        </div>
      )}

      {/* Flujo mensual visual */}
      <div className="glass rounded-2xl p-6 border border-slate-700/50 mb-6">
        <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
          <Clock className="w-4 h-4 text-blue-400" />
          Ciclo mensual de cobros
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          {[
            { days: 'Días 1 al 5', action: '📨 Aviso de cobro', sub: '8:00 AM Lima', color: 'bg-blue-500/15 border-blue-500/30 text-blue-300' },
            { days: '→', action: '', sub: '', color: 'text-slate-600' },
            { days: 'Días 6 al 9', action: '⏳ Período de gracia', sub: 'Sin acción', color: 'bg-slate-700/40 border-slate-600/30 text-slate-400' },
            { days: '→', action: '', sub: '', color: 'text-slate-600' },
            { days: 'Día 10', action: '✂️ Corte automático', sub: '9:00 AM Lima', color: 'bg-red-500/15 border-red-500/30 text-red-300' },
          ].map((item, i) => (
            item.action ? (
              <div key={i} className={clsx('px-4 py-3 rounded-xl border text-sm font-medium min-w-[140px]', item.color)}>
                <span className="block text-[10px] opacity-60 mb-0.5">{item.days}</span>
                <span className="block">{item.action}</span>
                <span className="block text-[10px] opacity-60 mt-0.5">{item.sub}</span>
              </div>
            ) : (
              <span key={i} className="text-slate-600 text-xl font-light">→</span>
            )
          ))}
        </div>
      </div>

      {/* Tarjetas de jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {JOB_CONFIG.map(({ key, endpoint, icon: Icon, label, color, bg, btnClass, description, warning }) => {
          const isRunning = running[key];
          const result    = results[key];
          const job       = status?.jobs[key === 'cobro' ? 0 : key === 'corte' ? 1 : 2];

          return (
            <div key={key} className={clsx('glass rounded-2xl p-5 border flex flex-col gap-4', bg)}>
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className={clsx('p-2.5 rounded-xl', bg)}>
                    <Icon className={clsx('w-5 h-5', color)} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-white text-sm">{label}</h3>
                    <p className="text-[10px] text-slate-500">{job?.schedule || '—'}</p>
                  </div>
                </div>
                {job?.active_today && (
                  <span className="text-[10px] font-medium text-green-400 bg-green-500/10 px-2 py-1 rounded-full border border-green-500/20 whitespace-nowrap">
                    ● Activo hoy
                  </span>
                )}
              </div>

              {/* Description */}
              <p className="text-xs text-slate-400 leading-relaxed flex-1">{description}</p>

              {/* Result */}
              {result?.text && (
                <div className={clsx(
                  'text-xs p-3 rounded-xl leading-relaxed flex items-start gap-2',
                  result.ok
                    ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                )}>
                  {result.ok
                    ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    : <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  }
                  <span>{result.text}</span>
                </div>
              )}

              {/* Running indicator */}
              {isRunning && (
                <div className="text-xs text-slate-400 flex items-center gap-2 animate-pulse">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Ejecutando… puede tardar varios minutos según la cantidad de clientes
                </div>
              )}

              {/* Button */}
              <button
                onClick={() => runJob(key, endpoint, label, warning)}
                disabled={isRunning}
                className={clsx(
                  'flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium',
                  'border transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed',
                  btnClass
                )}
              >
                {isRunning
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Ejecutando...</>
                  : <><Play className="w-4 h-4" /> Ejecutar manualmente</>
                }
              </button>
            </div>
          );
        })}
      </div>

      {/* Notas */}
      <div className="glass rounded-2xl p-5 border border-slate-700/50">
        <h3 className="font-semibold text-white text-sm mb-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-yellow-400" />
          Notas importantes
        </h3>
        <ul className="space-y-1.5 text-xs text-slate-400">
          <li>• Los teléfonos se obtienen de los <strong className="text-slate-200">contactos sincronizados de WispHub</strong> (tabla local) — es más rápido y confiable</li>
          <li>• Los montos de deuda se obtienen en tiempo real desde WispHub. Si WispHub no responde, se usan los montos guardados localmente</li>
          <li>• El tono escala progresivamente: amable el día 1, urgente el día 5 con aviso de corte</li>
          <li>• Hay un delay de 500ms entre mensajes para respetar los límites de la API de Meta</li>
          <li>• <strong className="text-slate-200">El botón "Ejecutar manualmente" funciona cualquier día del mes</strong> (ignora el rango 1-5)</li>
          <li>• El cron automático corre a las <strong className="text-slate-200">8:00 AM hora Lima</strong> los días 1-5</li>
        </ul>
      </div>
    </div>
  );
}
