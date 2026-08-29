/**
 * Estadistica interpretable. Nada de cajas negras: cada numero que el
 * sistema muestra tiene que poder explicarse a un juez en una frase.
 */

export function approvalRate(approved: number, attempts: number): number {
  return attempts > 0 ? approved / attempts : 0;
}

/**
 * Error estandar de una proporcion. Es lo que separa "cayo del 91% al 42%
 * con 400 intentos" (real) de "cayo del 91% al 42% con 7 intentos" (ruido).
 */
export function standardError(rate: number, attempts: number): number {
  if (attempts <= 0) return 1;
  return Math.sqrt(Math.max(rate * (1 - rate), 1e-6) / attempts);
}

/**
 * Cuantas desviaciones estandar separan lo observado de lo esperado.
 * Combina la varianza historica del baseline con la del propio muestreo.
 */
export function zScore(
  observedRate: number,
  expectedRate: number,
  observedAttempts: number,
  baselineVariance: number,
): number {
  const sampling = standardError(expectedRate, observedAttempts);
  const combined = Math.sqrt(sampling * sampling + Math.max(baselineVariance, 0) ** 2);
  if (combined <= 0) return 0;
  return (expectedRate - observedRate) / combined;
}

/**
 * Confianza en [0,1]. Crece con la magnitud de la caida y con el tamaño
 * de muestra, y se satura: nunca devuelve 1, porque el sistema nunca
 * deberia afirmar certeza absoluta.
 */
export function confidenceFrom(z: number, observedAttempts: number, minSample: number): number {
  if (observedAttempts < minSample) return 0;
  const evidence = 1 - Math.exp(-Math.max(z, 0) / 3);
  const sample = Math.min(1, observedAttempts / (minSample * 4));
  return Number(Math.min(0.99, evidence * sample).toFixed(4));
}

/** Desviacion estandar poblacional. */
export function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? null;
}

export function round(value: number, decimals = 4): number {
  return Number(value.toFixed(decimals));
}
