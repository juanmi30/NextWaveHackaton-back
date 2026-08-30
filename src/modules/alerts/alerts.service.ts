import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { NotificationChannel } from './escalation-policy.js';
import type { RecipientRole } from './routing.js';

export type DeliveryResult = {
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string;
};

/** Por que le llega esto a esta persona y en que punto de la cadena estamos. */
export type AlertContext = {
  level: number;
  levelLabel: string;
  totalLevels: number;
  role: RecipientRole;
  recipientName: string;
  routingReason: string;
  escalatedFrom?: number;
  nextEscalationAt?: Date | null;
};

export type IncidentAlert = {
  id: string;
  fingerprint: string;
  anchorFingerprint: string;
  severity: number;
  expectedApprovals: number;
  actualApprovals: number;
  lostApprovals: number;
  averageTicketCents: number;
  lossPerMinuteCents: number;
  startedAt: Date;
  detectedAt: Date;
  summaryOps?: string | null;
  summaryExec?: string | null;
  recommendation?: string | null;
};

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Entrega un mensaje a UN destinatario por UN canal.
   *
   * Antes esto era un broadcast a una lista fija de variables de entorno. Ahora
   * el "a quien" lo decide EscalationService; aqui solo queda el "como".
   */
  async deliver(
    channel: NotificationChannel,
    target: string,
    message: AlertMessage,
  ): Promise<DeliveryResult> {
    try {
      if (channel === 'EMAIL') return await this.sendEmail(target, message);
      if (channel === 'WHATSAPP') return await this.sendWhatsapp(target, message);
      this.logger.log(`[CONSOLE] ${target}: ${message.subject}`);
      return { status: 'SENT' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`No se pudo notificar a ${target} por ${channel}: ${reason}`);
      return { status: 'FAILED', error: reason };
    }
  }

  buildMessage(incident: IncidentAlert, context: AlertContext): AlertMessage {
    return buildIncidentMessage(incident, this.config.get<string>('ALERT_APP_URL')?.trim(), context);
  }

  private async sendEmail(to: string, message: AlertMessage): Promise<DeliveryResult> {
    if (this.config.get<string>('EMAIL_ALERTS_ENABLED') === 'false') {
      return { status: 'SKIPPED', error: 'EMAIL_ALERTS_ENABLED=false' };
    }

    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const from = this.config.get<string>('SMTP_FROM')?.trim();

    // Sin SMTP configurado el escalamiento NO se detiene: se registra la
    // notificacion como omitida y se sigue subiendo de nivel. Durante la demo
    // esto permite ver toda la cadena sin depender de un servidor de correo.
    if (!host || !from) {
      this.logger.log(`[SIN SMTP] Correo para ${to}: ${message.subject}`);
      return { status: 'SKIPPED', error: 'SMTP sin configurar' };
    }

    const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
    const user = this.config.get<string>('SMTP_USER')?.trim();
    const pass = this.config.get<string>('SMTP_PASS')?.trim();

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: this.config.get<string>('SMTP_SECURE') === 'true',
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: this.timeoutMs(),
      greetingTimeout: this.timeoutMs(),
      socketTimeout: this.timeoutMs(),
    });

    await transporter.sendMail({
      from,
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    this.logger.log(`Alerta por correo enviada a ${to}`);
    return { status: 'SENT' };
  }

  private async sendWhatsapp(to: string, message: AlertMessage): Promise<DeliveryResult> {
    if (this.config.get<string>('WHATSAPP_ALERTS_ENABLED') === 'false') {
      return { status: 'SKIPPED', error: 'WHATSAPP_ALERTS_ENABLED=false' };
    }

    const token = this.config.get<string>('WHATSAPP_TOKEN')?.trim();
    const phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID')?.trim();

    if (!token || !phoneNumberId) {
      this.logger.log(`[SIN WHATSAPP] Mensaje para ${to}: ${message.subject}`);
      return { status: 'SKIPPED', error: 'WhatsApp sin configurar' };
    }

    const version = this.config.get<string>('WHATSAPP_GRAPH_API_VERSION')?.trim() || 'v22.0';
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs());

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { preview_url: false, body: message.text },
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`WhatsApp API respondio ${response.status}: ${body.slice(0, 300)}`);
    }

    this.logger.log(`Alerta por WhatsApp enviada a ${to}`);
    return { status: 'SENT' };
  }

  private timeoutMs() {
    return Number(this.config.get<string>('ALERT_DELIVERY_TIMEOUT_MS') ?? 8_000);
  }
}

type AlertMessage = {
  subject: string;
  text: string;
  html?: string;
};

function buildIncidentMessage(
  incident: IncidentAlert,
  appUrl: string | undefined,
  context: AlertContext,
): AlertMessage {
  const escalationTag =
    context.escalatedFrom !== undefined
      ? ` - ESCALADO (nivel ${context.level}/${context.totalLevels})`
      : '';
  const subject = `[NextWave] Risk Alert - Severity ${incident.severity}${escalationTag}`;
  const text = [
    `${subject} - Action required`,
    '',
    `Para: ${context.recipientName} (${context.role})`,
    `Por que te llega: ${context.routingReason}`,
    `Nivel de escalamiento: ${context.level}/${context.totalLevels} - ${context.levelLabel}`,
    context.escalatedFrom !== undefined
      ? `Escalado desde el nivel ${context.escalatedFrom} por falta de acuse de recibo.`
      : '',
    context.nextEscalationAt
      ? `Si nadie acusa recibo, escala de nuevo a las ${context.nextEscalationAt.toISOString()}.`
      : 'Este es el ultimo nivel de la politica.',
    '',
    incident.summaryExec ?? 'Se detecto una degradacion de pagos.',
    '',
    `Incidente: ${incident.id}`,
    `Segmento: ${incident.fingerprint}`,
    `Detectado: ${incident.detectedAt.toISOString()}`,
    `Inicio estimado: ${incident.startedAt.toISOString()}`,
    `Aprobaciones esperadas: ${incident.expectedApprovals}`,
    `Aprobaciones reales: ${incident.actualApprovals}`,
    `Aprobaciones perdidas: ${incident.lostApprovals}`,
    `Impacto estimado: ${formatUsd(incident.lossPerMinuteCents)} por minuto`,
    '',
    incident.summaryOps ?? '',
    incident.recommendation ?? '',
  ].filter((line) => line !== '');

  return {
    subject,
    text: text.join('\n'),
    html: buildIncidentHtml(incident, appUrl, context),
  };
}

function parseList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function buildIncidentHtml(
  incident: IncidentAlert,
  appUrl: string | undefined,
  context: AlertContext,
): string {
  const tone = severityTone(incident.severity);
  const segmentRows = incident.fingerprint
    .split('|')
    .map((part) => {
      const [key, ...rest] = part.split('=');
      return tableRow(labelize(key), rest.join('=') || '-');
    })
    .join('');

  const actionButton = appUrl
    ? `<tr>
        <td style="padding: 18px 0 0;">
          <a href="${escapeHtml(appUrl)}" style="display: inline-block; background: #111827; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 6px; font-weight: 700;">
            Abrir dashboard
          </a>
        </td>
      </tr>`
    : '';

  return `<!doctype html>
<html lang="es">
  <body style="margin:0; padding:0; background:#f4f6f8; font-family: Arial, Helvetica, sans-serif; color:#111827;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8; padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="width:680px; max-width:94%; background:#ffffff; border-radius:8px; overflow:hidden; border:1px solid #e5e7eb;">
            <tr>
              <td style="background:${tone.background}; color:#ffffff; padding:22px 28px;">
                <div style="font-size:12px; letter-spacing:.08em; text-transform:uppercase; font-weight:700; opacity:.9;">NextWave Payment Operations</div>
                <h1 style="margin:8px 0 0; font-size:24px; line-height:1.25;">Risk Alert - Action Required</h1>
                <div style="margin-top:10px; display:inline-block; background:${tone.badge}; color:#ffffff; padding:6px 10px; border-radius:999px; font-size:13px; font-weight:700;">
                  Severity ${incident.severity} - ${tone.label}
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:26px 28px 12px;">
                <p style="margin:0; font-size:15px; line-height:1.6;">Hola ${escapeHtml(context.recipientName)},</p>
                <p style="margin:10px 0 0; font-size:15px; line-height:1.6;">${escapeHtml(context.routingReason)}</p>
                <p style="margin:10px 0 0; font-size:13px; line-height:1.6; color:#6b7280;">Nivel ${context.level} de ${context.totalLevels} &middot; ${escapeHtml(context.levelLabel)}${context.escalatedFrom !== undefined ? ` &middot; escalado desde el nivel ${context.escalatedFrom}` : ''}</p>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 28px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff7ed; border:1px solid #fed7aa; border-radius:8px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <div style="font-size:13px; font-weight:700; color:#9a3412; text-transform:uppercase;">Resumen ejecutivo</div>
                      <div style="margin-top:6px; font-size:17px; line-height:1.45; font-weight:700; color:#111827;">
                        ${escapeHtml(incident.summaryExec ?? 'Se detecto una degradacion de pagos.')}
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    ${metricCard('Impacto/min', formatUsd(incident.lossPerMinuteCents), '#b42318')}
                    ${metricCard('Aprobaciones perdidas', String(incident.lostApprovals), '#92400e')}
                    ${metricCard('Esperadas vs reales', `${incident.expectedApprovals} / ${incident.actualApprovals}`, '#1d4ed8')}
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb; border-radius:8px; overflow:hidden;">
                  <tr>
                    <td colspan="2" style="background:#f9fafb; padding:12px 16px; font-size:13px; font-weight:700; text-transform:uppercase; color:#374151;">Segmento afectado</td>
                  </tr>
                  ${segmentRows}
                  ${tableRow('Incidente', incident.id)}
                  ${tableRow('Detectado', formatDateUtc(incident.detectedAt))}
                  ${tableRow('Inicio estimado', formatDateUtc(incident.startedAt))}
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dbeafe; border-radius:8px; background:#eff6ff;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <div style="font-size:13px; font-weight:700; color:#1e40af; text-transform:uppercase;">Evidencia</div>
                      <p style="margin:8px 0 0; font-size:14px; line-height:1.6; color:#1f2937;">${escapeHtml(incident.summaryOps ?? 'El sistema detecto una desviacion relevante frente al baseline historico.')}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 26px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #dcfce7; border-radius:8px; background:#f0fdf4;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <div style="font-size:13px; font-weight:700; color:#166534; text-transform:uppercase;">Accion recomendada</div>
                      <p style="margin:8px 0 0; font-size:14px; line-height:1.6; color:#1f2937;">${escapeHtml(incident.recommendation ?? 'Revisar el incidente y decidir una accion operativa.')}</p>
                      ${actionButton ? `<table role="presentation" cellspacing="0" cellpadding="0">${actionButton}</table>` : ''}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="background:#f9fafb; border-top:1px solid #e5e7eb; padding:14px 28px; font-size:12px; line-height:1.5; color:#6b7280;">
                Mensaje automatico de NextWave Payment Operations. El sistema recomienda acciones para un operador humano y no ejecuta remediaciones automaticamente.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function metricCard(label: string, value: string, color: string): string {
  return `<td width="33.33%" style="padding-right:8px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb; border-radius:8px;">
      <tr>
        <td style="padding:14px 12px;">
          <div style="font-size:12px; text-transform:uppercase; color:#6b7280; font-weight:700;">${escapeHtml(label)}</div>
          <div style="margin-top:7px; font-size:20px; line-height:1.2; color:${color}; font-weight:800;">${escapeHtml(value)}</div>
        </td>
      </tr>
    </table>
  </td>`;
}

function tableRow(label: string, value: string): string {
  return `<tr>
    <td style="width:38%; padding:11px 16px; border-top:1px solid #e5e7eb; font-size:13px; color:#6b7280; font-weight:700;">${escapeHtml(label)}</td>
    <td style="padding:11px 16px; border-top:1px solid #e5e7eb; font-size:13px; color:#111827;">${escapeHtml(value)}</td>
  </tr>`;
}

function severityTone(severity: number) {
  if (severity >= 4) return { label: 'Critico', background: '#991b1b', badge: '#dc2626' };
  if (severity === 3) return { label: 'Alto', background: '#9a3412', badge: '#ea580c' };
  if (severity === 2) return { label: 'Medio', background: '#92400e', badge: '#d97706' };
  return { label: 'Bajo', background: '#1f2937', badge: '#4b5563' };
}

function labelize(value?: string): string {
  const labels: Record<string, string> = {
    merchant: 'Comercio',
    provider: 'Proveedor',
    method: 'Metodo',
    country: 'Pais',
    issuingBank: 'Banco emisor',
    failureReason: 'Motivo de fallo',
  };
  return value ? labels[value] ?? value : '-';
}

function formatDateUtc(date: Date): string {
  return date.toISOString().replace('.000Z', 'Z');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
