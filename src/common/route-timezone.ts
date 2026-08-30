/**
 * Resolucion de zona horaria de una ruta.
 *
 * LIMITACION IMPORTANTE, y hay que decirla en voz alta ante el jurado:
 * el modelo de datos actual solo tiene `country`. Pais NO determina zona
 * horaria de forma univoca — Mexico y Brasil tienen varias. El mapa de abajo
 * es una simplificacion valida SOLO para las rutas sinteticas de la demo, donde
 * controlamos la geografia; no es una regla general de producto.
 *
 * Camino correcto en produccion: guardar una zona IANA a nivel de ruta o de
 * conexion (`timeZone: "America/Bogota"`), no derivarla del pais. La firma de
 * `resolveRouteTimeZone` ya acepta ese override para que migrar sea trivial.
 */

/** Zona por defecto cuando no hay informacion. */
export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Mapa pais -> IANA para las rutas de demo. Se elige la zona del mayor centro
 * economico del pais, que es donde vive la mayor parte del trafico simulado.
 */
export const DEMO_COUNTRY_TIME_ZONES: Record<string, string> = {
  CO: 'America/Bogota',
  MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  PE: 'America/Lima',
  US: 'America/New_York',
  ES: 'Europe/Madrid',
};

/** Paises donde el mapeo pais -> zona es una aproximacion, no un hecho. */
export const AMBIGUOUS_TIMEZONE_COUNTRIES = new Set(['MX', 'BR', 'US', 'CL']);

export type RouteTimeZoneResolution = {
  timeZone: string;
  /** 'ROUTE_METADATA' | 'COUNTRY_MAP' | 'DEFAULT' */
  source: 'ROUTE_METADATA' | 'COUNTRY_MAP' | 'DEFAULT';
  /** true si el pais admite varias zonas y estamos aproximando. */
  ambiguous: boolean;
};

export function resolveRouteTimeZone(input: {
  country?: string | null;
  /** Zona explicita de la ruta, si algun dia existe en metadata. */
  timeZone?: string | null;
}): RouteTimeZoneResolution {
  if (input.timeZone) {
    return { timeZone: input.timeZone, source: 'ROUTE_METADATA', ambiguous: false };
  }

  const country = input.country?.trim().toUpperCase();
  if (country && DEMO_COUNTRY_TIME_ZONES[country]) {
    return {
      timeZone: DEMO_COUNTRY_TIME_ZONES[country]!,
      source: 'COUNTRY_MAP',
      ambiguous: AMBIGUOUS_TIMEZONE_COUNTRIES.has(country),
    };
  }

  return { timeZone: DEFAULT_TIME_ZONE, source: 'DEFAULT', ambiguous: false };
}
