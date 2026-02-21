/**
 * Notificaciones de sonido usando Web Audio API
 * No requiere archivos de audio externos.
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

export type SoundType = 'message' | 'payment' | 'takeover';

export const playSound = (type: SoundType = 'message') => {
  try {
    switch (type) {
      // Ping suave - mensaje nuevo
      case 'message':
        beep(660, 0.15, 0.2);
        break;

      // Dos tonos ascendentes - pago recibido ✅
      case 'payment':
        beep(880, 0.12, 0.3);
        setTimeout(() => beep(1100, 0.2, 0.3), 130);
        break;

      // Tono de alerta - cliente quiere asesor 🔔
      case 'takeover':
        beep(660, 0.1, 0.35, 'square');
        setTimeout(() => beep(660, 0.1, 0.35, 'square'), 200);
        setTimeout(() => beep(880, 0.25, 0.35, 'square'), 400);
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
