/**
 * Las seis dimensiones sobre las que el sistema razona.
 *
 * Todo el pipeline (baselines, deteccion, evidencia) itera sobre este array.
 * Nunca se escribe una condicion del tipo `if (provider === 'dLocal')`:
 * el sistema debe diagnosticar combinaciones que jamas ha visto.
 */
export const DIMENSIONS = [
  'merchant',
  'provider',
  'method',
  'country',
  'issuingBank',
  'failureReason',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export type DimensionMap = Partial<Record<Dimension, string>>;

/**
 * Serializa un segmento de forma canonica y estable.
 *
 * El `sort` es critico: si el job de baselines produce
 * "provider=dLocal|country=BR" y el detector produce
 * "country=BR|provider=dLocal", nunca hay match, no se detecta nada
 * y NO falla nada visiblemente. Una sola implementacion, un solo sitio.
 */
export function buildSegmentKey(dims: DimensionMap): string {
  return Object.entries(dims)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
}

/** Un fingerprint es exactamente la misma clave canonica. */
export const buildFingerprint = buildSegmentKey;

/** "provider|country" — que dimensiones fija un segmento, sin sus valores. */
export function buildDimensionKey(dims: DimensionMap): string {
  return Object.keys(dims)
    .filter((key) => dims[key as Dimension] !== undefined)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}

/** Todas las combinaciones de tamaño `size` de las dimensiones dadas. */
export function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [[]];
  if (size > items.length) return [];

  const out: T[][] = [];
  const walk = (start: number, current: T[]) => {
    if (current.length === size) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      walk(i + 1, current);
      current.pop();
    }
  };
  walk(0, []);
  return out;
}

/** ¿`child` fija todo lo que fija `parent`, con los mismos valores? */
export function isRefinementOf(child: DimensionMap, parent: DimensionMap): boolean {
  return Object.entries(parent).every(([key, value]) => child[key as Dimension] === value);
}

export function humanizeDimensions(dims: DimensionMap): string {
  const labels: Record<string, string> = {
    merchant: 'comercio',
    provider: 'proveedor',
    method: 'método',
    country: 'país',
    issuingBank: 'banco emisor',
    failureReason: 'motivo de rechazo',
  };
  return Object.entries(dims)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${labels[key] ?? key} ${value}`)
    .join(', ');
}
