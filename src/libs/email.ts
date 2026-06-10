import { Resend } from 'resend';
import { Env } from '@/libs/Env';

// Resend's shared sandbox sender. Works without a verified domain, but only
// delivers to the Resend account owner's own email. Set RESEND_FROM_EMAIL to a
// verified domain address (e.g. "Mi Negocio <hola@minegocio.com>") for real use.
const DEFAULT_FROM = 'MerchantAI <onboarding@resend.dev>';

type InvitationEmailInput = {
  to: string;
  name: string;
  organizationName: string | null;
  inviteUrl: string;
};

function renderText({ name, inviteUrl }: InvitationEmailInput, org: string): string {
  return [
    `Hola ${name},`,
    '',
    `Te invitaron a unirte a ${org} en MerchantAI.`,
    'Abre este enlace para crear tu contraseña y activar tu cuenta:',
    inviteUrl,
    '',
    'El enlace vence en 72 horas.',
  ].join('\n');
}

function renderHtml({ name, inviteUrl }: InvitationEmailInput, org: string): string {
  return `<!doctype html>
<html lang="es">
  <body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 8px;">
                <p style="margin:0 0 16px;font-size:18px;font-weight:600;">Te invitaron a ${org}</p>
                <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#334155;">
                  Hola ${name}, te sumaron como usuario de <strong>${org}</strong> en MerchantAI.
                  Creá tu contraseña para activar tu cuenta.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px 28px;">
                <a href="${inviteUrl}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">
                  Activar mi cuenta
                </a>
                <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                  Si el botón no funciona, copiá y pegá este enlace en tu navegador:<br />
                  <a href="${inviteUrl}" style="color:#0ea5e9;word-break:break-all;">${inviteUrl}</a>
                </p>
                <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">El enlace vence en 72 horas.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Best-effort invitation email. Returns true only when Resend accepted the send.
 * NEVER throws: a missing/misconfigured provider must not break the invite flow,
 * which always also exposes a copyable link as a fallback.
 */
export async function sendInvitationEmail(
  input: InvitationEmailInput,
): Promise<boolean> {
  const apiKey = Env.RESEND_API_KEY;
  if (!apiKey) {
    return false;
  }

  try {
    const resend = new Resend(apiKey);
    const org = input.organizationName ?? 'tu negocio';
    const { error } = await resend.emails.send({
      from: Env.RESEND_FROM_EMAIL || DEFAULT_FROM,
      to: input.to,
      subject: `Te invitaron a ${org} en MerchantAI`,
      html: renderHtml(input, org),
      text: renderText(input, org),
    });
    return !error;
  } catch {
    return false;
  }
}
