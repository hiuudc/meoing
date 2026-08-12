import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApiApp } from "../src/app";

const app = createApiApp({
  repositoryFactory: () => {
    throw new Error("The OpenAPI export must not access PostgreSQL.");
  },
});

const response = await app.request(
  "http://openapi.local/openapi.json",
  {},
  {
    APP_ENV: "openapi",
    CORS_ORIGINS: "http://openapi.local",
  } as ApiEnv,
);

if (!response.ok) {
  throw new Error(`OpenAPI export failed with HTTP ${response.status}.`);
}

const document = `${JSON.stringify(await response.json(), null, 2)}\n`;
await writeFile(resolve(process.cwd(), "openapi.json"), document, "utf8");
