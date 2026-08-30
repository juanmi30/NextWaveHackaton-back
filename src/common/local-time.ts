/**
 * Contexto temporal local — codificacion ciclica.
 * =============================================
 *
 * POR QUE NO SE USA LA HORA CRUDA
 * Una regresion logistica es lineal en sus features. Meterle `hour = 23` y
 * `hour = 0` le dice que estan a 23 unidades de distancia, cuando operativamente
 * son consecutivas. El modelo aprenderia un salto artificial a medianoche.
 *
 * POR QUE SENO **Y** COSENO
 * El seno solo no identifica la fase: sin(3h) == sin(9h). Hacen falta las dos
 * proyecciones para ubicar univocamente un punto del ciclo de 24 h.
 *
 * FORMULA (identica en ml/local_time.py):
 *   local_minutes = local_hour * 60 + local_minute
 *   angle         = 2 * PI * local_minutes / 1440
 *   local_time_sin = sin(angle)
 *   local_time_cos = cos(angle)
 *
 * SEMANTICA: es la hora LOCAL de la ruta evaluada en el instante ancla de la
 * prediccion (el final de la ventana de observacion). No es hora UTC del
 * servidor ni la hora de cada transaccion individual.
 */

export const MINUTES_PER_DAY = 1440;

export type LocalTimeEncoding = {
  timeZone: string;
  localHour: number;
  localMinute: number;
  localMinutes: number;
  localTimeSin: number;
  localTimeCos: number;
  /** true si la zona horaria no se pudo resolver y se cayo a UTC. */
  fallbackToUtc: boolean;
};

/**
 * Hora local en una zona IANA, usando Intl (estandar de la plataforma).
 * Se prefiere IANA sobre offsets fijos porque el offset no captura el horario
 * de verano.
 */
export function localHourMinute(
  at: Date,
  timeZone: string,
): { hour: number; minute: number; fallbackToUtc: boolean } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);

    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    const minutePart = parts.find((p) => p.type === 'minute')?.value;
    // Intl puede devolver "24" para medianoche en algunas plataformas.
    const hour = Number(hourPart) % 24;
    const minute = Number(minutePart);
    if (Number.isNaN(hour) || Number.isNaN(minute)) throw new Error('parse');
    return { hour, minute, fallbackToUtc: false };
  } catch {
    return { hour: at.getUTCHours(), minute: at.getUTCMinutes(), fallbackToUtc: true };
  }
}

export function encodeLocalTime(at: Date, timeZone: string): LocalTimeEncoding {
  const { hour, minute, fallbackToUtc } = localHourMinute(at, timeZone);
  const localMinutes = hour * 60 + minute;
  const angle = (2 * Math.PI * localMinutes) / MINUTES_PER_DAY;
  return {
    timeZone,
    localHour: hour,
    localMinute: minute,
    localMinutes,
    localTimeSin: Math.sin(angle),
    localTimeCos: Math.cos(angle),
    fallbackToUtc,
  };
}

export type Daypart = 'NIGHT' | 'MORNING' | 'AFTERNOON' | 'EVENING';

export function daypartOf(localHour: number): Daypart {
  if (localHour < 6) return 'NIGHT';
  if (localHour < 12) return 'MORNING';
  if (localHour < 18) return 'AFTERNOON';
  return 'EVENING';
}
