/**
 * Notificaciones de sonido.
 * Usa archivos MP3 reales de /public si existen, con fallback a Web Audio API.
 * Archivos esperados en /public:
 *   - "mesajes.mp3"        → mensajes normales del cliente
 *   - "aletar para asesor.mp3" → alerta cuando cliente pide asesor humano
 */

let audioCtx: AudioContext | null = null;

const getCtx = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return audioCtx;
};

const beep = (freq: number, duration: number, vol = 0.25, type: OscillatorType = 'sine') => {
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
};

/** Reproducir archivo de audio con fallback a beep */
const playFile = (src: string, vol = 0.8): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') { reject(); return; }
    const audio = new Audio(src);
    audio.volume = vol;
    audio.play().then(resolve).catch(reject);
  });
};

export type SoundType = 'message' | 'payment' | 'takeover';

export const playSound = (type: SoundType = 'message') => {
  try {
    switch (type) {
      // Sonido de mensaje nuevo del cliente
      case 'message':
        playFile('/mesajes.mp3', 0.7).catch(() => {
          beep(660, 0.15, 0.2);
        });
        break;

      // Alerta de asesor — sonido más fuerte y llamativo
      case 'takeover':
        playFile('/aletar para asesor.mp3', 1.0).catch(() => {
          beep(660, 0.1, 0.4, 'square');
          setTimeout(() => beep(660, 0.1, 0.4, 'square'), 200);
          setTimeout(() => beep(880, 0.3, 0.4, 'square'), 400);
          setTimeout(() => beep(880, 0.3, 0.4, 'square'), 600);
        });
        break;

      // Pago recibido — usa el mismo sonido de mensaje
      case 'payment':
        playFile('/mesajes.mp3', 0.5).catch(() => {
          beep(880, 0.12, 0.3);
          setTimeout(() => beep(1100, 0.2, 0.3), 130);
        });
        break;
    }
  } catch {
    // Browser puede bloquear audio sin interacción del usuario
  }
};

/** Llamar una vez al hacer click en la app para desbloquear AudioContext */
export const unlockAudio = () => {
  const ctx = getCtx();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume();
  }
};
