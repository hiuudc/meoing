import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-07-29",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          APP_ENV: "test",
          CORS_ORIGINS: "https://app.meoing.test",
          SUPABASE_URL: "https://test.supabase.co",
          SUPABASE_JWT_AUDIENCE: "authenticated",
          R2_ACCOUNT_ID: "test-account",
          R2_BUCKET_NAME: "meoing-test",
          PRESIGNED_UPLOAD_TTL_SECONDS: "900",
          PRESIGNED_DOWNLOAD_TTL_SECONDS: "300",
          INVITE_TOKEN_SECRET: "test-invite-token-secret-that-is-at-least-32-bytes",
          TURNSTILE_SECRET_KEY: "test-turnstile-secret",
          R2_ACCESS_KEY_ID: "test-access-key",
          R2_SECRET_ACCESS_KEY: "test-secret-key",
        },
        r2Buckets: ["FILES"],
      },
    }),
  ],
  test: {
    coverage: {
      enabled: false,
    },
    include: ["test/**/*.test.ts"],
  },
});
