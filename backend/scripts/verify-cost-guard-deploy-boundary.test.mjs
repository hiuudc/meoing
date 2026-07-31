import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApiConfigDoesNotManagePublicRoutes,
  assertCostGuardEmailIsDestinationLocked,
  assertDeployWorkflowUsesBoundaryCheck,
  assertImmutableActionRefs,
  assertResumeWorkflowScopesCredentials,
  assertStagingDeployScopesCredentials,
  assertStagingDeployUsesTrustedPush,
} from "./verify-cost-guard-deploy-boundary.mjs";

const safeConfig = {
  workers_dev: false,
  preview_urls: false,
  env: {
    staging: { workers_dev: false, preview_urls: false },
    production: { workers_dev: false, preview_urls: false },
  },
};

test("ordinary API config omits every Wrangler-managed public route", () => {
  assert.doesNotThrow(() => assertApiConfigDoesNotManagePublicRoutes(safeConfig));
  assert.throws(
    () => assertApiConfigDoesNotManagePublicRoutes({
      ...safeConfig,
      routes: [{ pattern: "api.meoing.com", custom_domain: true }],
    }),
    /top-level API config must omit route\/routes/,
  );
  assert.throws(
    () => assertApiConfigDoesNotManagePublicRoutes({
      ...safeConfig,
      env: {
        ...safeConfig.env,
        staging: {
          ...safeConfig.env.staging,
          routes: [{ pattern: "api-staging.meoing.com", custom_domain: true }],
        },
      },
    }),
    /must omit route\/routes/,
  );
  assert.throws(
    () => assertApiConfigDoesNotManagePublicRoutes({
      ...safeConfig,
      env: {
        ...safeConfig.env,
        production: { ...safeConfig.env.production, routes: [] },
      },
    }),
    /must omit route\/routes/,
  );
  assert.throws(
    () => assertApiConfigDoesNotManagePublicRoutes({
      ...safeConfig,
      workers_dev: true,
    }),
    /top-level API config must keep workers_dev and preview_urls disabled/,
  );
  assert.throws(
    () => assertApiConfigDoesNotManagePublicRoutes({
      env: safeConfig.env,
    }),
    /top-level API config must keep workers_dev and preview_urls disabled/,
  );
});

test("Cost Guard email binding is locked to the verified destination", () => {
  const binding = {
    name: "ALERT_EMAIL",
    destination_address: "hiuudc@gmail.com",
    allowed_sender_addresses: ["no-reply@auth.meoing.com"],
  };
  assert.doesNotThrow(() => assertCostGuardEmailIsDestinationLocked({
    env: {
      staging: { send_email: [binding] },
      production: { send_email: [binding] },
    },
  }));
  assert.throws(
    () => assertCostGuardEmailIsDestinationLocked({
      env: {
        staging: { send_email: [{ ...binding, destination_address: undefined }] },
        production: { send_email: [binding] },
      },
    }),
    /locked to the verified destination/,
  );
});

test("deploy workflow must run the guard before the route-free deploy", () => {
  const deploy =
    "npm run cost-guard:deploy-boundary\nnpx wrangler deploy --config wrangler.api.jsonc --env staging";
  assert.doesNotThrow(() =>
    assertDeployWorkflowUsesBoundaryCheck(deploy, "staging", "staging"),
  );
  assert.throws(
    () => assertDeployWorkflowUsesBoundaryCheck(
      "npm run cost-guard:deploy-boundary\n" +
        "npx wrangler deploy --config wrangler.api.jsonc --env staging --route api.example.com",
      "staging",
      "staging",
    ),
    /must not manage routes/,
  );
});

test("staging workflow_run deploy accepts only a successful main push", () => {
  assert.doesNotThrow(() => assertStagingDeployUsesTrustedPush(`
    if: >-
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_branch == 'main' &&
      github.event.workflow_run.conclusion == 'success'
  `));
  assert.throws(
    () => assertStagingDeployUsesTrustedPush(
      "if: github.event.workflow_run.conclusion == 'success'",
    ),
    /reject untrusted workflow_run events/,
  );
});

test("staging deploy keeps provider credentials out of the job preamble", () => {
  const scoped = `
  deploy:
    environment: staging
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
      - run: npm ci
      - run: wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
  `;
  assert.doesNotThrow(() => assertStagingDeployScopesCredentials(scoped));
  assert.throws(
    () => assertStagingDeployScopesCredentials(scoped.replace(
      "environment: staging",
      "env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    )),
    /must not expose provider credentials job-wide/,
  );
  assert.throws(
    () => assertStagingDeployScopesCredentials(scoped.replace(
      "- run: npm ci",
      "- run: npm ci\n        env:\n          TOKEN: ${{ secrets.PROVIDER_TOKEN }}",
    )),
    /must not expose provider secrets to - run: npm ci/,
  );
});

test("resume workflow keeps secrets out of setup and pins immutable Actions", () => {
  const secureWorkflow = `
  request-resume:
    if: github.ref == 'refs/heads/main'
    env:
      COST_GUARD_ENVIRONMENT: staging
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ github.sha }}
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
      - run: npm ci
      - run: wrangler r2 object get
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.RESUME_TOKEN }}
  `;
  assert.doesNotThrow(() => assertResumeWorkflowScopesCredentials(secureWorkflow));
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(
      secureWorkflow.replace(
        "COST_GUARD_ENVIRONMENT: staging",
        "CLOUDFLARE_API_TOKEN: ${{ secrets.RESUME_TOKEN }}",
      ),
    ),
    /must not expose Cloudflare secrets job-wide/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(
      secureWorkflow.replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      ),
    ),
    /verified immutable SHA/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(
      secureWorkflow.replace("refs/heads/main", "refs/heads/review-branch"),
    ),
    /outside trusted main/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n" +
        "        env:\n          TOKEN: ${{ secrets.RESUME_TOKEN }}",
    )),
    /must not expose provider secrets to - uses: actions\/setup-node/,
  );
});

test("deploy artifacts use the verified immutable action reference", () => {
  assert.doesNotThrow(() => assertImmutableActionRefs(
    "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "deploy",
  ));
  assert.throws(
    () => assertImmutableActionRefs(
      "uses: actions/upload-artifact@v4",
      "deploy",
    ),
    /verified immutable SHA/,
  );
});
