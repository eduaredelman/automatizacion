'use client';
import { useEffect, useState } from 'react';
import { getApi } from '@/lib/api';
import {
  Calendar, Play, RefreshCw, Bell, Scissors,
  Clock, AlertTriangle, Loader2
} from 'lucide-react';
import clsx from 'clsx';

interface SchedulerStatus {
  current_day: number;
  jobs: Array<{
    name: string;
    schedule: string;
    active_today: boolean;
    description: string;
  }>;
}

export default function SchedulerPage() {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, string>>({});

  useEffect(() => {
    getApi().get('/scheduler/status')
      .then(({ data }) => setStatus(data.data))
      .catch(console.error);
  }, []);

  const runJob = async (jobKey: string, endpoint: string, label: string, warning: string | null) => {
    if (warning && !confirm(warning)) return;
    setRunning(r => ({ ...r, [jobKey]: true }));
    setResults(r => ({ ...r, [jobKey]: '' }));
    try {
      await getApi().post(endpoint);
      setResults(r => ({ ...r, [jobKey]: `✅ ${label} iniciado correctamente en background` }));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      setResults(r => ({ ...r, [jobKey]: `❌ Error: ${e.response?.data?.message || 'Falló la ejecución'}` }));
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
      description: 'Envía recordatorio de pago a todos los clientes con deuda pendiente. Se ejecuta automáticamente los días 1 al 5.',
      warning: '⚠️ Enviará mensajes de WhatsApp a TODOS los clientes con deuda. ¿Confirmar ejecución manual?',
    },
    {
      key: 'corte',
      endpoint: '/scheduler/run/corte',
      icon: Scissors,
      label: 'Corte de Servicio',
      color: 'text-red-400',
      bg: 'bg-red-500/10 border-red-500/20',
      btnClass: 'bg-red-600/20 hover:bg-red-600/40 text-red-400 border-red-500/30',
      description: 'Suspende el servicio de todos los clientes con deuda. Se ejecuta automáticamente el día 10 a las 9:00 AM.',
      warning: '🚨 ACCIÓN CRÍTICA: Se cortará el servicio de todos los clientes morosos. ¿Confirmar?',
    },
    {
      key: 'sync',
      endpoint: '/scheduler/run/sync',
      icon: RefreshCw,
      label: 'Sincronizar Clientes',
      color: 'text-green-400',
      bg: 'bg-green-500/10 border-green-500/20',
      btnClass: 'bg-green-600/20 hover:bg-green-600/40 text-green-400 border-green-500/30',
      description: 'Actualiza la base de datos local con todos los clientes de WispHub. Se ejecuta diariamente a las 7:00 AM.',
      warning: null,
    },
  ];

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

      {/* Flujo mensual visual */}
      <div className="glass rounded-2xl p-6 border border-slate-700/50 mb-6">
        <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
          <Clock className="w-4 h-4 text-blue-400" />
          Ciclo mensual de cobros
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          {[
            { days: 'Días 1 al 5', action: '📨 Aviso de cobro', sub: '8:00 AM', color: 'bg-blue-500/15 border-blue-500/30 text-blue-300' },
            { days: '→', action: '', sub: '', color: 'text-slate-600' },
            { days: 'Días 6 al 9', action: '⏳ Período de gracia', sub: 'Sin acción', color: 'bg-slate-700/40 border-slate-600/30 text-slate-400' },
            { days: '→', action: '', sub: '', color: 'text-slate-600' },
            { days: 'Día 10', action: '✂️ Corte automático', sub: '9:00 AM', color: 'bg-red-500/15 border-red-500/30 text-red-300' },
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
          const result = results[key];
          const job = status?.jobs[key === 'cobro' ? 0 : key === 'corte' ? 1 : 2];

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
              {result && (
                <div className={clsx(
                  'text-xs p-3 rounded-xl leading-relaxed',
                  result.startsWith('✅') ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                                          : 'bg-red-500/10 text-red-400 border border-red-500/20'
                )}>
                  {result}
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
          <li>• Los mensajes se personalizan con el <strong className="text-slate-200">nombre del cliente</strong> y su <strong className="text-slate-200">monto de deuda real</strong></li>
          <li>• El tono escala progresivamente: amable el día 1, urgente el día 5 con aviso de corte</li>
          <li>• Hay un delay de 500ms entre mensajes para respetar los límites de la API de Meta</li>
          <li>• Si un cliente paga antes del día 10, <strong className="text-slate-200">NO será cortado</strong> — el sistema verifica deuda en tiempo real</li>
          <li>• El corte en WispHub requiere que la API tenga habilitado el endpoint de suspensión</li>
        </ul>
      </div>
    </div>
  );
}
