import { humanizeDimensions, type DimensionMap } from '../../common/dimensions.js';

export type ExplanationInput = {
  dimensions: DimensionMap;
  expectedRate: number;
  observedRate: number;
  observedAttempts: number;
  baselineAttempts: number;
  confidence: number;
  lossPerMinuteCents: number;
  lostApprovals: number;
  startedAt: Date;
  baselineSource: string;
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const hhmm = (date: Date) =>
  `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;

/**
 * Los textos se generan desde los datos, nunca desde plantillas por caso.
 * Una combinacion de dimensiones nunca vista produce una explicacion
 * igual de legible que una ensayada.
 */
export function buildExplanation(input: ExplanationInput) {
  const where = humanizeDimensions(input.dimensions);
  const drop = input.expectedRate - input.observedRate;

  const summaryOps =
    `Caída de aprobación en ${where}. ` +
    `Esperado ${pct(input.expectedRate)}, observado ${pct(input.observedRate)} ` +
    `(−${pct(drop)}) sobre ${input.observedAttempts} intentos desde ${hhmm(input.startedAt)}. ` +
    `Baseline construido con ${input.baselineAttempts} transacciones (${input.baselineSource}).`;

  const summaryExec =
    `La degradación en ${where} está costando aproximadamente ` +
    `${usd(input.lossPerMinuteCents)} por minuto desde ${hhmm(input.startedAt)}.`;

  return {
    summaryOps,
    summaryExec,
    recommendation: buildRecommendation(input.dimensions),
    confidenceStatement: buildConfidenceStatement(input),
  };
}

/**
 * La recomendacion se deriva de QUE dimensiones componen el diagnostico,
 * no de sus valores. Un proveedor desconocido produce la misma
 * recomendacion util que uno conocido.
 */
function buildRecommendation(dimensions: DimensionMap): string {
  const keys = Object.keys(dimensions);
  const parts: string[] = [];

  if (keys.includes('provider')) {
    parts.push(`contactar a ${dimensions.provider} y evaluar desviar tráfico a un proveedor alterno`);
  }
  if (keys.includes('issuingBank')) {
    parts.push(`verificar si ${dimensions.issuingBank} está rechazando de forma anómala y probar reintentos con otra ruta`);
  }
  if (keys.includes('method')) {
    parts.push(`revisar la disponibilidad de ${dimensions.method} y priorizar métodos alternativos`);
  }
  if (keys.includes('country')) {
    parts.push(`confirmar si la degradación es regional en ${dimensions.country}`);
  }
  if (keys.includes('merchant')) {
    parts.push(`revisar cambios recientes de configuración en ${dimensions.merchant}`);
  }
  if (keys.includes('failureReason')) {
    parts.push(`analizar la concentración del código ${dimensions.failureReason}`);
  }

  if (parts.length === 0) return 'Investigar la degradación con el equipo de operaciones.';
  return `Sugerido para el operador: ${parts.join('; ')}. El sistema no ejecuta ninguna acción automáticamente.`;
}

function buildConfidenceStatement(input: ExplanationInput): string {
  if (input.baselineSource === 'none') {
    return 'Evidencia insuficiente: no existe baseline histórico para este segmento. Se reporta la anomalía sin diagnóstico firme.';
  }
  if (input.confidence < 0.4) {
    return `Confianza baja (${pct(input.confidence)}): la muestra de ${input.observedAttempts} intentos es limitada. Conviene esperar más datos antes de actuar.`;
  }
  if (input.confidence < 0.7) {
    return `Confianza media (${pct(input.confidence)}) con ${input.observedAttempts} intentos observados contra ${input.baselineAttempts} de baseline.`;
  }
  return `Confianza alta (${pct(input.confidence)}): la caída es consistente sobre ${input.observedAttempts} intentos y excede la varianza histórica del segmento.`;
}
