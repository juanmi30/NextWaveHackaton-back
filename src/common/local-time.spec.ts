import { describe, expect, it } from 'vitest';
import { daypartOf, encodeLocalTime, localHourMinute } from './local-time.js';
import { resolveRouteTimeZone } from './route-timezone.js';

describe('encodeLocalTime — conversion de zona horaria', () => {
  it('07:00 UTC son las 02:00 en Bogota', () => {
    const e = encodeLocalTime(new Date('2026-08-30T07:00:00Z'), 'America/Bogota');
    expect(e.localHour).toBe(2);
    expect(e.localMinute).toBe(0);
  });

  it('el mismo instante UTC da horas locales distintas segun la zona', () => {
    const at = new Date('2026-08-30T07:00:00Z');
    expect(encodeLocalTime(at, 'America/Bogota').localHour).toBe(2);
    expect(encodeLocalTime(at, 'America/Sao_Paulo').localHour).toBe(4);
    expect(encodeLocalTime(at, 'Europe/Madrid').localHour).toBe(9);
    expect(encodeLocalTime(at, 'UTC').localHour).toBe(7);
  });

  it('una zona invalida cae a UTC y lo declara', () => {
    const e = encodeLocalTime(new Date('2026-08-30T07:00:00Z'), 'Marte/Olympus');
    expect(e.fallbackToUtc).toBe(true);
    expect(e.localHour).toBe(7);
  });
});

describe('encodeLocalTime — propiedades ciclicas', () => {
  it('23:59 y 00:01 quedan cerca (sin salto en medianoche)', () => {
    const a = encodeLocalTime(new Date('2026-08-30T23:59:00Z'), 'UTC');
    const b = encodeLocalTime(new Date('2026-08-31T00:01:00Z'), 'UTC');
    const distance = Math.hypot(a.localTimeSin - b.localTimeSin, a.localTimeCos - b.localTimeCos);
    expect(distance).toBeLessThan(0.01);
  });

  it('03:00 y 09:00 comparten seno: por eso hace falta el coseno', () => {
    const a = encodeLocalTime(new Date('2026-08-30T03:00:00Z'), 'UTC');
    const b = encodeLocalTime(new Date('2026-08-30T09:00:00Z'), 'UTC');
    expect(Math.abs(a.localTimeSin - b.localTimeSin)).toBeLessThan(1e-9);
    expect(Math.abs(a.localTimeCos - b.localTimeCos)).toBeGreaterThan(1.3);
  });

  it('06:00 y 18:00 comparten coseno: por eso hace falta el seno', () => {
    const a = encodeLocalTime(new Date('2026-08-30T06:00:00Z'), 'UTC');
    const b = encodeLocalTime(new Date('2026-08-30T18:00:00Z'), 'UTC');
    expect(Math.abs(a.localTimeCos - b.localTimeCos)).toBeLessThan(1e-9);
    expect(Math.abs(a.localTimeSin - b.localTimeSin)).toBeGreaterThan(1.9);
  });

  it('el par (sin, cos) siempre esta sobre la circunferencia unidad', () => {
    for (let hour = 0; hour < 24; hour++) {
      const e = encodeLocalTime(new Date(Date.UTC(2026, 7, 30, hour, 30)), 'UTC');
      expect(Math.hypot(e.localTimeSin, e.localTimeCos)).toBeCloseTo(1, 12);
    }
  });

  it('la misma hora local en zonas distintas produce el mismo vector', () => {
    const bogota = encodeLocalTime(new Date('2026-08-30T07:00:00Z'), 'America/Bogota'); // 02:00
    const madrid = encodeLocalTime(new Date('2026-08-30T00:00:00Z'), 'Europe/Madrid'); // 02:00
    expect(bogota.localHour).toBe(2);
    expect(madrid.localHour).toBe(2);
    expect(bogota.localTimeSin).toBeCloseTo(madrid.localTimeSin, 12);
    expect(bogota.localTimeCos).toBeCloseTo(madrid.localTimeCos, 12);
  });
});

describe('resolveRouteTimeZone', () => {
  it('prefiere la metadata explicita de la ruta', () => {
    const r = resolveRouteTimeZone({ country: 'MX', timeZone: 'America/Tijuana' });
    expect(r.timeZone).toBe('America/Tijuana');
    expect(r.source).toBe('ROUTE_METADATA');
  });

  it('marca como ambiguos los paises con varias zonas', () => {
    expect(resolveRouteTimeZone({ country: 'CO' }).ambiguous).toBe(false);
    expect(resolveRouteTimeZone({ country: 'MX' }).ambiguous).toBe(true);
    expect(resolveRouteTimeZone({ country: 'BR' }).ambiguous).toBe(true);
  });

  it('sin pais conocido cae a UTC', () => {
    expect(resolveRouteTimeZone({ country: 'ZZ' }).timeZone).toBe('UTC');
  });
});

describe('daypartOf', () => {
  it('parte el dia en cuatro tramos', () => {
    expect(daypartOf(2)).toBe('NIGHT');
    expect(daypartOf(9)).toBe('MORNING');
    expect(daypartOf(15)).toBe('AFTERNOON');
    expect(daypartOf(21)).toBe('EVENING');
  });
});

describe('localHourMinute', () => {
  it('medianoche exacta se representa como hora 0, no 24', () => {
    expect(localHourMinute(new Date('2026-08-30T05:00:00Z'), 'America/Bogota').hour).toBe(0);
  });
});
