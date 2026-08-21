import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApiConfigDoesNotManagePublicRoutes,
  assertApiConfigRequiresSecrets,
  assertCostGuardEmailIsDestinationLocked,
  assertDeployWorkflowUsesBoundaryCheck,
  assertImmutableActionRefs,
  assertProductionDeployVerifiesApiSecrets,
  assertProductionDeployVerifiesWebBoundaryAndSmoke,
  assertProductionReleaseInfrastructureGates,
  assertResumeWorkflowScopesCredentials,
  assertStagingDeployVerifiesApiSecrets,
  assertStagingDeployScopesCredentials,
  assertStagingDeployUsesTrustedPush,
} from "./verify-cost-guard-deploy-boundary.mjs";

const requiredApiSecrets = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "INVITE_TOKEN_SECRET",
  "TURNSTILE_SECRET_KEY",
  "OPENAI_API_KEY",
];
const safeConfig = {
  workers_dev: false,
  preview_urls: false,
  secrets: { required: requiredApiSecrets },
  env: {
    staging: {
      workers_dev: false,
      preview_urls: false,
      secrets: { required: requiredApiSecrets },
    },
    production: {
      workers_dev: false,
      preview_urls: false,
      secrets: { required: requiredApiSecrets },
    },
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

test("API config declares every runtime secret as required in each environment", () => {
  assert.doesNotThrow(() => assertApiConfigRequiresSecrets(safeConfig));
  assert.throws(
    () => assertApiConfigRequiresSecrets({
      ...safeConfig,
      env: {
        ...safeConfig.env,
        production: {
          ...safeConfig.env.production,
          secrets: {
            required: requiredApiSecrets.filter(
              (secret) => secret !== "TURNSTILE_SECRET_KEY",
            ),
          },
        },
      },
    }),
    /production API config must require exactly these secrets/,
  );
  assert.throws(
    () => assertApiConfigRequiresSecrets({
      ...safeConfig,
      secrets: { required: [...requiredApiSecrets, "TURNSTILE_SECRET_KEY"] },
    }),
    /top-level API config must require exactly these secrets/,
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

test("production verifies all API secrets before migrations and deploy", () => {
  const secretCheck = `
      - name: Verify API secret bindings
        run: |
          npx wrangler secret list \\
            --config wrangler.api.jsonc \\
            --env production \\
            --format json
          for required_secret in \\
            R2_ACCESS_KEY_ID \\
            R2_SECRET_ACCESS_KEY \\
            INVITE_TOKEN_SECRET \\
            TURNSTILE_SECRET_KEY \\
            OPENAI_API_KEY
          do
            jq -e \\
              --arg required_secret "$required_secret" \\
              'any(.[]; .name == $required_secret and .type == "secret_text")'
          done
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
  const migration = "      - name: Apply production migrations\n";
  const deploy = "      - name: Deploy API Worker\n";
  assert.doesNotThrow(() =>
    assertProductionDeployVerifiesApiSecrets(secretCheck + migration + deploy)
  );
  assert.throws(
    () => assertProductionDeployVerifiesApiSecrets(
      (secretCheck + migration + deploy).replace(
        "TURNSTILE_SECRET_KEY",
        "UNEXPECTED_SECRET",
      ),
    ),
    /must require TURNSTILE_SECRET_KEY/,
  );
  assert.throws(
    () => assertProductionDeployVerifiesApiSecrets(migration + secretCheck + deploy),
    /before database mutation and API deploy/,
  );
});

test("staging verifies all API secrets before migrations and deploy", () => {
  const secretCheck = `
      - name: Verify API secret bindings
        run: |
          npx wrangler secret list \\
            --config wrangler.api.jsonc \\
            --env staging \\
            --format json
          for required_secret in \\
            R2_ACCESS_KEY_ID \\
            R2_SECRET_ACCESS_KEY \\
            INVITE_TOKEN_SECRET \\
            TURNSTILE_SECRET_KEY \\
            OPENAI_API_KEY
          do
            jq -e \\
              --arg required_secret "$required_secret" \\
              'any(.[]; .name == $required_secret and .type == "secret_text")'
          done
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
  const migration = "      - name: Apply staging migrations\n";
  const deploy = "      - name: Deploy API Worker\n";
  assert.doesNotThrow(() =>
    assertStagingDeployVerifiesApiSecrets(secretCheck + migration + deploy)
  );
  assert.throws(
    () => assertStagingDeployVerifiesApiSecrets(migration + secretCheck + deploy),
    /before database mutation and API deploy/,
  );
});

test("production smokes every public web entrypoint", () => {
  const pagesDeploy = "      - name: Deploy production Pages\n";
  const smoke = `
      - name: Production smoke test
        run: |
          expected_web_origin="https://meoing.com"
          for page_path in "/" "/auth/callback" "/privacy" "/terms"; do
            curl --silent --show-error --fail --location \\
              --retry 5 --retry-all-errors --retry-delay 5 \\
              "\${expected_web_origin}\${page_path}" \\
              --output /dev/null
          done
          curl "\${expected_web_origin}/release.json?release=\${RELEASE_SHA}"
          .environment == $environment and .commitSha == $commit_sha
        env:
          RELEASE_SHA: \${{ steps.release.outputs.release_sha }}
`;
  assert.doesNotThrow(() =>
    assertProductionDeployVerifiesWebBoundaryAndSmoke(pagesDeploy + smoke)
  );
  assert.throws(
    () => assertProductionDeployVerifiesWebBoundaryAndSmoke(
      (pagesDeploy + smoke).replace(
        'expected_web_origin="https://meoing.com"',
        'expected_web_origin="https://staging.meoing.com"',
      ),
    ),
    /production web smoke is incomplete/,
  );
  assert.throws(
    () => assertProductionDeployVerifiesWebBoundaryAndSmoke(
      (pagesDeploy + smoke).replace(' "/terms"', ""),
    ),
    /production web smoke is incomplete/,
  );
  assert.throws(
    () => assertProductionDeployVerifiesWebBoundaryAndSmoke(smoke + pagesDeploy),
    /must run after the production Pages deploy/,
  );
});

test("production proves exact R2 CORS, release SHA, and live Cost Guard", () => {
  const cors = `
      - name: Apply and verify production R2 CORS
        run: |
          bucket_name="meoing-files-production"
          npx wrangler r2 bucket cors set "$bucket_name" \\
            --file config/r2-cors.production.json \\
            --force
          curl "/r2/buckets/\${bucket_name}/cors"
          jq --slurpfile expected config/r2-cors.production.json \\
            '.success == true and .result == $expected[0]'
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_R2_CORS_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`;
  const marker = `
      - name: Write production release marker
        run: |
          jq --arg environment "production" \\
            --arg commit_sha "$RELEASE_SHA" \\
            '{environment: $environment, commitSha: $commit_sha}' \\
            > public/release.json
        env:
          RELEASE_SHA: \${{ steps.release.outputs.release_sha }}
`;
  const guardStep = (phase) => `
      - name: Verify production Cost Guard ${phase}
        run: bash ../.github/scripts/verify-production-cost-guard.sh
        env:
          COST_GUARD_ENVIRONMENT: production
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          R2_COST_GUARD_ACCESS_KEY_ID: \${{ secrets.R2_COST_GUARD_STATE_READ_ACCESS_KEY_ID }}
          R2_COST_GUARD_SECRET_ACCESS_KEY: \${{ secrets.R2_COST_GUARD_STATE_READ_SECRET_ACCESS_KEY }}
`;
  const guardVerifier = `
    worker_name="meoing-cost-guard-production"
    npx wrangler secret list --config wrangler.cost-guard.jsonc --env production
    ["ALERT_RECIPIENT", "CLOUDFLARE_COST_GUARD_TOKEN"]
    bucket_name == "meoing-cost-guard-production"
    text == "production"
    text == $expected_domains
    curl /workers/scripts/\${worker_name}/schedules
    [.result.schedules[].cron] == ["*/5 * * * *"]
    curl /workers/domains
    node scripts/cost-guard-resume-r2.mjs download-state --output "$state_file"
    .status == "NORMAL"
    .consecutiveMetricFailures == 0
    .lastUsage != null
    fromdateiso8601) >= (now - 900)
  `;
  const pgTap = "      - name: Run production-release pgTAP/RLS tests\n";
  const migration = "      - name: Apply production migrations\n";
  const build = "      - name: Build website\n";
  const smoke = "      - name: Production smoke test\n";
  const safe =
    marker + build + pgTap + guardStep("preflight") + cors + migration +
    smoke + guardStep("postflight");
  assert.doesNotThrow(() =>
    assertProductionReleaseInfrastructureGates(safe, guardVerifier),
  );
  assert.throws(
    () => assertProductionReleaseInfrastructureGates(
      safe.replace("--force", ""),
      guardVerifier,
    ),
    /production R2 CORS gate is incomplete/,
  );
  assert.throws(
    () => assertProductionReleaseInfrastructureGates(
      marker + build + pgTap + cors + guardStep("preflight") + migration +
        smoke + guardStep("postflight"),
      guardVerifier,
    ),
    /production infrastructure gates must finish local tests/,
  );
  assert.throws(
    () => assertProductionReleaseInfrastructureGates(
      safe,
      `${guardVerifier}\nnpx wrangler r2 object get bucket/key`,
    ),
    /bucket-scoped S3 credentials/,
  );
});

test("staging workflow_run deploy accepts only an enabled successful main push", () => {
  assert.doesNotThrow(() => assertStagingDeployUsesTrustedPush(`
    if: >-
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_branch == 'main' &&
      github.event.workflow_run.conclusion == 'success' &&
      vars.STAGING_DEPLOY_ENABLED == 'true'
  `));
  assert.throws(
    () => assertStagingDeployUsesTrustedPush(
      "if: github.event.workflow_run.conclusion == 'success'",
    ),
    /trusted main push and explicit enablement/,
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
    environment: cost-guard-resume-\${{ inputs.environment }}
    env:
      COST_GUARD_ENVIRONMENT: staging
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: \${{ github.sha }}
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
      - run: npm ci
      - name: Validate explicit confirmation
        run: |
          expected="RESUME STAGING"
          expected="RESUME PRODUCTION"
      - name: Download stopped state
        env:
          CLOUDFLARE_ACCOUNT_ID: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          R2_COST_GUARD_ACCESS_KEY_ID: \${{ secrets.R2_COST_GUARD_ACCESS_KEY_ID }}
          R2_COST_GUARD_SECRET_ACCESS_KEY: \${{ secrets.R2_COST_GUARD_SECRET_ACCESS_KEY }}
        run: >-
          node scripts/cost-guard-resume-r2.mjs
          download-state
          --output .cost-guard/state.json
      - name: Recheck account usage below five percent
        env:
          CLOUDFLARE_ACCOUNT_ID: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_COST_GUARD_ANALYTICS_TOKEN: \${{ secrets.CLOUDFLARE_COST_GUARD_ANALYTICS_TOKEN }}
        run: node scripts/request-cost-guard-resume.mjs
      - name: Queue one resume request for the next Cron
        env:
          CLOUDFLARE_ACCOUNT_ID: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          R2_COST_GUARD_ACCESS_KEY_ID: \${{ secrets.R2_COST_GUARD_ACCESS_KEY_ID }}
          R2_COST_GUARD_SECRET_ACCESS_KEY: \${{ secrets.R2_COST_GUARD_SECRET_ACCESS_KEY }}
        run: >-
          node scripts/cost-guard-resume-r2.mjs
          upload-request
          --input .cost-guard/resume-request.json
  `;
  assert.doesNotThrow(() => assertResumeWorkflowScopesCredentials(secureWorkflow));
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(
      secureWorkflow.replace(
        "COST_GUARD_ENVIRONMENT: staging",
        "TOKEN: ${{ secrets.PROVIDER_TOKEN }}",
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
        "        env:\n          TOKEN: ${{ secrets.PROVIDER_TOKEN }}",
    )),
    /must not expose provider secrets to - uses: actions\/setup-node/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "environment: cost-guard-resume-${{ inputs.environment }}",
      "environment: cost-guard-resume",
    )),
    /isolate credentials in the selected protected environment/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "CLOUDFLARE_COST_GUARD_ANALYTICS_TOKEN",
      "CLOUDFLARE_COST_GUARD_RESUME_TOKEN",
    )),
    /legacy combined Cloudflare token/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "node scripts/cost-guard-resume-r2.mjs\n          download-state",
      "npx wrangler --config resume.jsonc r2 object get\n          download-state",
    )),
    /not native R2 REST/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
      "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    )),
    /non-secret account ID/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "R2_COST_GUARD_SECRET_ACCESS_KEY: ${{ secrets.R2_COST_GUARD_SECRET_ACCESS_KEY }}",
      "R2_COST_GUARD_SECRET_ACCESS_KEY: ${{ secrets.R2_COST_GUARD_SECRET_ACCESS_KEY }}\n" +
        "          LEAKED_ANALYTICS: ${{ secrets.CLOUDFLARE_COST_GUARD_ANALYTICS_TOKEN }}",
    )),
    /resume state download must receive exactly these secrets/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "R2_COST_GUARD_SECRET_ACCESS_KEY: ${{ secrets.R2_COST_GUARD_SECRET_ACCESS_KEY }}",
      "R2_COST_GUARD_SECRET_ACCESS_KEY: ${{ secrets.R2_COST_GUARD_SECRET_ACCESS_KEY }}\n" +
        "          LEAKED: ${{ secrets['CLOUDFLARE_COST_GUARD_ANALYTICS_TOKEN'] }}",
    )),
    /must not use bracket-style secret references/,
  );
  assert.throws(
    () => assertResumeWorkflowScopesCredentials(secureWorkflow.replace(
      "      - name: Download stopped state",
      "      - name: Unexpected credential consumer\n" +
        "        env:\n" +
        "          TOKEN: ${{ secrets.R2_COST_GUARD_SECRET_ACCESS_KEY }}\n" +
        "        run: node unexpected.mjs\n" +
        "      - name: Download stopped state",
    )),
    /must not expose secrets outside the three provider steps/,
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
