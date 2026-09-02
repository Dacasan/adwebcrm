import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // Base pública de los webhooks de Twilio. La firma se calcula sobre
      // la URL COMPLETA, así que este valor DEBE coincidir literalmente con
      // el de .github/workflows/ci.yml o las pruebas de firma pasan aquí y
      // fallan en CI (o al revés).
      TWILIO_WEBHOOK_BASE_URL: "https://ci.example.test",
    },
    clearMocks: true,
  },
});
