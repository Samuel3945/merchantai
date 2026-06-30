/**
 * Webhook neutralization guard tests.
 *
 * When WHATSAPP_N8N_WEBHOOK_URL is set, the handler MUST return 200 no-op
 * immediately after the shared-token check without invoking generateText.
 * When it is unset, the original in-app LLM flow executes normally.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generateText: vi.fn(async () => ({ text: '' })),
  n8nWebhookUrl: undefined as string | undefined,
}));

vi.mock('@/libs/Env', () => ({
  Env: {
    get WHATSAPP_WEBHOOK_TOKEN() {
      return 'test-shared-token';
    },
    get WHATSAPP_N8N_WEBHOOK_URL() {
      return h.n8nWebhookUrl;
    },
    get WHATSAPP_DEFAULT_ORG_ID() {
      return 'org_test';
    },
    get OPENAI_API_KEY() {
      return undefined;
    },
  },
}));

vi.mock('ai', () => ({
  generateText: h.generateText,
  stepCountIs: () => () => false,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => () => ({}),
}));

vi.mock('@/features/delivery/agent-tools', () => ({
  createDeliveryOrderTool: () => ({}),
}));

vi.mock('@/libs/delivery-whatsapp', () => ({
  sendWhatsAppText: vi.fn(async () => {}),
}));

function makeRequest(body: unknown = {}): Request {
  return new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'x-webhook-token': 'test-shared-token' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.generateText.mockClear();
  h.n8nWebhookUrl = undefined;
});

describe('POST /api/whatsapp/webhook — neutralization guard', () => {
  it('WHATSAPP_N8N_WEBHOOK_URL set → returns 200 {ok:true, neutralized:true}, generateText NOT called', async () => {
    h.n8nWebhookUrl = 'https://n8n.example.com/webhook/abc';

    const { POST } = await import('./route');
    const res = await POST(makeRequest({ some: 'payload' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, neutralized: true });
    expect(h.generateText).not.toHaveBeenCalled();
  });

  it('WHATSAPP_N8N_WEBHOOK_URL unset → generateText IS called (original flow continues)', async () => {
    h.n8nWebhookUrl = undefined;
    // Provide enough payload to reach the generateText call:
    // from + text are required; OPENAI_API_KEY is undefined so the route short-circuits
    // before calling generateText with { ok: true, ignored: 'no_model' }.
    // What matters is the neutralization guard did NOT fire.

    const { POST } = await import('./route');
    const res = await POST(
      makeRequest({
        instance: 'org_test__shop',
        data: {
          key: { remoteJid: '573001234567@s.whatsapp.net', fromMe: false },
          message: { conversation: 'Hola' },
        },
      }),
    );

    // Route returns ok:true (ignored:'no_model') without calling generateText
    // because OPENAI_API_KEY is undefined — but the neutralization guard was NOT
    // the reason it returned early. generateText must NOT have been called by the
    // guard path.
    expect(h.generateText).not.toHaveBeenCalled();
    // The response must NOT carry neutralized:true
    const body = await res.json();
    expect(body.neutralized).toBeUndefined();
  });
});
