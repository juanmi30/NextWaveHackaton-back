import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';

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

  async notifyIncidentCreated(incident: IncidentAlert) {
    const message = buildIncidentMessage(incident, this.config.get<string>('ALERT_APP_URL')?.trim());
    const results = await Promise.allSettled([this.sendEmail(message), this.sendWhatsapp(message)]);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `No se pudo enviar una alerta: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        );
      }
    }
  }

  private async sendEmail(message: AlertMessage) {
    if (this.config.get<string>('EMAIL_ALERTS_ENABLED') === 'false') return;

    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const from = this.config.get<string>('SMTP_FROM')?.trim();
    const to = parseList(this.config.get<string>('ALERT_EMAIL_TO'));

    if (!host || !from || to.length === 0) {
      this.logger.debug('Alertas por correo sin configurar; se omite envio.');
      return;
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

    this.logger.log(`Alerta por correo enviada a ${to.join(', ')}`);
  }

  private async sendWhatsapp(message: AlertMessage) {
    if (this.config.get<string>('WHATSAPP_ALERTS_ENABLED') === 'false') return;

    const token = this.config.get<string>('WHATSAPP_TOKEN')?.trim();
    const phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID')?.trim();
    const recipients = parseList(this.config.get<string>('WHATSAPP_TO'));

    if (!token || !phoneNumberId || recipients.length === 0) {
      this.logger.debug('Alertas por WhatsApp sin configurar; se omite envio.');
      return;
    }

    const version = this.config.get<string>('WHATSAPP_GRAPH_API_VERSION')?.trim() || 'v22.0';
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

    await Promise.all(
      recipients.map(async (to) => {
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
              text: {
                preview_url: false,
                body: message.text,
              },
            }),
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`WhatsApp API respondio ${response.status}: ${body.slice(0, 300)}`);
        }
      }),
    );

    this.logger.log(`Alerta por WhatsApp enviada a ${recipients.join(', ')}`);
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

function buildIncidentMessage(incident: IncidentAlert, appUrl?: string): AlertMessage {
  const subject = `[NextWave] Risk Alert - Severity ${incident.severity}`;
  const text = [
    `${subject} - Action required`,
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
    html: buildIncidentHtml(incident, appUrl),
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

function buildIncidentHtml(incident: IncidentAlert, appUrl?: string): string {
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
                <p style="margin:0; font-size:15px; line-height:1.6;">Hola Yuno Admin,</p>
                <p style="margin:10px 0 0; font-size:15px; line-height:1.6;">Se detecto una caida de conversion que requiere revision del equipo de operaciones.</p>
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
