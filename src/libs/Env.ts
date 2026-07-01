import { createEnv } from '@t3-oss/env-nextjs';
import * as z from 'zod';

export const Env = createEnv({
  server: {
    OPENAI_API_KEY: z.string().optional(),
    CLERK_SECRET_KEY: z.string().min(1),
    DATABASE_URL: z.string().min(1),
    // Root dir for on-disk uploads (business logos, etc.). In production point
    // this at a persistent volume (e.g. /data/uploads in EasyPanel) so files
    // survive redeploys. Optional: falls back to a project-local folder in dev.
    UPLOAD_DIR: z.string().optional(),
    // Email delivery (Resend). Optional: when absent, invitations fall back to a
    // copyable link instead of an automatic email.
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().optional(),
    // WhatsApp via Evolution API (Domicilios L2/L3). All optional: when absent,
    // inbound intake and outbound notifications no-op so the module works
    // without the integration wired. EVOLUTION_INSTANCE is the connected number
    // instance; WHATSAPP_WEBHOOK_TOKEN authenticates the inbound webhook;
    // WHATSAPP_DEFAULT_ORG_ID maps inbound messages to an org until a
    // per-instance mapping is persisted.
    EVOLUTION_API_URL: z.string().optional(),
    EVOLUTION_API_KEY: z.string().optional(),
    EVOLUTION_INSTANCE: z.string().optional(),
    WHATSAPP_WEBHOOK_TOKEN: z.string().optional(),
    WHATSAPP_DEFAULT_ORG_ID: z.string().optional(),
    // Shared n8n webhook every WhatsApp channel forwards inbound messages to.
    // One URL for all instances; n8n maps to an org from the payload `instance`.
    WHATSAPP_N8N_WEBHOOK_URL: z.string().optional(),
    // Shared service secret for n8n → agent API calls. When set, n8n can
    // authenticate as a channel by sending this secret as the Bearer token and
    // the Evolution instance name in X-Agent-Channel. Must be a strong random
    // string; if unset the service path is completely disabled.
    N8N_SERVICE_SECRET: z.string().optional(),
    // MATIAS electronic invoicing — app-level "Casa de Software" account (ONE
    // account for all tenants). Base URL is locked to the DIAN sandbox; production
    // is intentionally not wired here. Email/password optional: when absent,
    // e-invoicing is simply unavailable (the Fiscal tab shows "not configured").
    MATIAS_API_BASE_URL: z
      .string()
      .default('https://sandbox-api.matias-api.com/api/ubl2.1'),
    MATIAS_ACCOUNT_EMAIL: z.string().optional(),
    MATIAS_ACCOUNT_PASSWORD: z.string().optional(),
    // Wompi payments (sandbox for MVP). All optional: when the secrets are
    // absent, the buy-credits flow is simply unavailable (no checkout offered).
    // These three are SECRET — server only, never exposed to the client.
    // WOMPI_PRIVATE_KEY: server-to-server API calls (query/confirm transactions).
    // WOMPI_INTEGRITY_SECRET: signs the Web Checkout so the amount can't be tampered.
    // WOMPI_EVENTS_SECRET: verifies inbound webhook event signatures.
    WOMPI_PRIVATE_KEY: z.string().optional(),
    WOMPI_INTEGRITY_SECRET: z.string().optional(),
    WOMPI_EVENTS_SECRET: z.string().optional(),
    // API base is locked to the Wompi sandbox for now; production is intentionally
    // not wired here (mirrors the MATIAS sandbox-only approach).
    WOMPI_API_BASE_URL: z.string().default('https://sandbox.wompi.co/v1'),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().optional(),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_LOGGING_LEVEL: z.enum(['error', 'info', 'debug', 'warning', 'trace', 'fatal']).default('info'),
    NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN: z.string().optional(),
    NEXT_PUBLIC_BETTER_STACK_INGESTING_HOST: z.string().optional(),
    // Wompi public key (pub_test_/pub_prod_). Public by design — safe on the
    // client. Optional: absent = payments not configured.
    NEXT_PUBLIC_WOMPI_PUBLIC_KEY: z.string().optional(),
  },
  shared: {
    NODE_ENV: z.enum(['test', 'development', 'production']).optional(),
  },
  // Allow skipping validation during the Docker image build, where server
  // secrets aren't (and shouldn't be) present. Runtime still validates fully.
  skipValidation: process.env.SKIP_ENV_VALIDATION === 'true',
  // You need to destructure all the keys manually
  runtimeEnv: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    UPLOAD_DIR: process.env.UPLOAD_DIR,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    EVOLUTION_API_URL: process.env.EVOLUTION_API_URL,
    EVOLUTION_API_KEY: process.env.EVOLUTION_API_KEY,
    EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE,
    WHATSAPP_WEBHOOK_TOKEN: process.env.WHATSAPP_WEBHOOK_TOKEN,
    WHATSAPP_DEFAULT_ORG_ID: process.env.WHATSAPP_DEFAULT_ORG_ID,
    WHATSAPP_N8N_WEBHOOK_URL: process.env.WHATSAPP_N8N_WEBHOOK_URL,
    N8N_SERVICE_SECRET: process.env.N8N_SERVICE_SECRET,
    MATIAS_API_BASE_URL: process.env.MATIAS_API_BASE_URL,
    MATIAS_ACCOUNT_EMAIL: process.env.MATIAS_ACCOUNT_EMAIL,
    MATIAS_ACCOUNT_PASSWORD: process.env.MATIAS_ACCOUNT_PASSWORD,
    WOMPI_PRIVATE_KEY: process.env.WOMPI_PRIVATE_KEY,
    WOMPI_INTEGRITY_SECRET: process.env.WOMPI_INTEGRITY_SECRET,
    WOMPI_EVENTS_SECRET: process.env.WOMPI_EVENTS_SECRET,
    WOMPI_API_BASE_URL: process.env.WOMPI_API_BASE_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_LOGGING_LEVEL: process.env.NEXT_PUBLIC_LOGGING_LEVEL,
    NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN: process.env.NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN,
    NEXT_PUBLIC_BETTER_STACK_INGESTING_HOST: process.env.NEXT_PUBLIC_BETTER_STACK_INGESTING_HOST,
    NEXT_PUBLIC_WOMPI_PUBLIC_KEY: process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY,
    NODE_ENV: process.env.NODE_ENV,
  },
});
