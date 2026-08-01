import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const DEPLOY_ENVIRONMENTS = ["staging", "production"];
const ALERT_DESTINATION = "hiuudc@gmail.com";
const ALERT_SENDER = "no-reply@auth.meoing.com";
const IMMUTABLE_ACTION_REFS = new Map([
  ["checkout", "11d5960a326750d5838078e36cf38b85af677262"],
  ["setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ["upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02"],
]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function containsSecretExpression(source) {
  return /\$\{\{\s*secrets(?:\.|\s*\[)/i.test(source);
}

function assertBootstrapStepsDoNotReceiveSecrets(workflow, label) {
  const markers = [
    "      - uses: actions/checkout@",
    "      - uses: actions/setup-node@",
    "      - run: npm ci",
  ];
  for (const marker of markers) {
    let start = workflow.indexOf(marker);
    if (start < 0) throw new Error(`${label} is missing ${marker.trim()}`);
    while (start >= 0) {
      const next = workflow.indexOf("\n      - ", start + marker.length);
      const block = workflow.slice(start, next < 0 ? workflow.length : next);
      if (containsSecretExpression(block)) {
        throw new Error(`${label} must not expose provider secrets to ${marker.trim()}`);
      }
      start = workflow.indexOf(marker, start + marker.length);
    }
  }
}

function namedStep(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`resume workflow is missing the ${name} step`);
  const next = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

function secretReferences(source) {
  return [...source.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gi)].map(
    ([, name]) => name,
  );
}

function assertExactSecrets(source, expected, label) {
  if (/\$\{\{\s*secrets\s*\[/i.test(source)) {
    throw new Error(`${label} must not use bracket-style secret references`);
  }
  const actual = secretReferences(source).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `${label} must receive exactly these secrets: ${wanted.join(", ")}`,
    );
  }
}

export function assertApiConfigDoesNotManagePublicRoutes(rawConfig) {
  if (hasOwn(rawConfig, "route") || hasOwn(rawConfig, "routes")) {
    throw new Error(
      "top-level API config must omit route/routes because Wrangler environments inherit them",
    );
  }
  if (rawConfig.workers_dev !== false || rawConfig.preview_urls !== false) {
    throw new Error(
      "top-level API config must keep workers_dev and preview_urls disabled",
    );
  }
  for (const environment of DEPLOY_ENVIRONMENTS) {
    const config = rawConfig?.env?.[environment];
    if (!config || typeof config !== "object") {
      throw new Error(`Missing Wrangler environment: ${environment}`);
    }
    if (hasOwn(config, "route") || hasOwn(config, "routes")) {
      throw new Error(
        `${environment} API config must omit route/routes; Cost Guard owns the public-domain lifecycle`,
      );
    }
    if (config.workers_dev !== false || config.preview_urls !== false) {
      throw new Error(
        `${environment} API config must keep workers_dev and preview_urls disabled`,
      );
    }
  }
}

export function assertCostGuardEmailIsDestinationLocked(rawConfig) {
  for (const environment of DEPLOY_ENVIRONMENTS) {
    const bindings = rawConfig?.env?.[environment]?.send_email;
    const alert = Array.isArray(bindings)
      ? bindings.find(({ name }) => name === "ALERT_EMAIL")
      : undefined;
    if (
      alert?.destination_address !== ALERT_DESTINATION ||
      !Array.isArray(alert.allowed_sender_addresses) ||
      !alert.allowed_sender_addresses.includes(ALERT_SENDER)
    ) {
      throw new Error(
        `${environment} ALERT_EMAIL must be locked to the verified destination and sender`,
      );
    }
  }
}

export function assertDeployWorkflowUsesBoundaryCheck(
  workflow,
  label,
  environment,
) {
  const check = "npm run cost-guard:deploy-boundary";
  const deploy =
    `npx wrangler deploy --config wrangler.api.jsonc --env ${environment}`;
  const checkIndex = workflow.lastIndexOf(check);
  const deployIndex = workflow.indexOf(deploy);
  if (deployIndex < 0) {
    throw new Error(`${label} is missing the expected API deploy command`);
  }
  if (checkIndex < 0 || checkIndex > deployIndex) {
    throw new Error(`${label} must run the Cost Guard boundary check before API deploy`);
  }
  if (/wrangler[^\r\n]*(?:--routes?\b|triggers\s+deploy\b)/i.test(workflow)) {
    throw new Error(`${label} must not manage routes through Wrangler CLI flags`);
  }
}

export function assertStagingDeployUsesTrustedPush(workflow) {
  const requiredConditions = [
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.conclusion == 'success'",
  ];
  for (const condition of requiredConditions) {
    if (!workflow.includes(condition)) {
      throw new Error(
        `staging deploy must reject untrusted workflow_run events: missing ${condition}`,
      );
    }
  }
}

export function assertStagingDeployScopesCredentials(workflow) {
  const jobStart = workflow.indexOf("\n  deploy:");
  const stepsStart = workflow.indexOf("\n    steps:", jobStart);
  if (jobStart < 0 || stepsStart < 0) {
    throw new Error("staging deploy job is missing");
  }
  if (containsSecretExpression(workflow.slice(0, stepsStart))) {
    throw new Error("staging deploy must not expose provider credentials job-wide");
  }
  assertBootstrapStepsDoNotReceiveSecrets(workflow, "staging deploy");
}

export function assertResumeWorkflowScopesCredentials(workflow) {
  const jobStart = workflow.indexOf("\n  request-resume:");
  const stepsStart = workflow.indexOf("\n    steps:", jobStart);
  if (jobStart < 0 || stepsStart < 0) {
    throw new Error("resume workflow request-resume job is missing");
  }
  const preSteps = workflow.slice(0, stepsStart);
  if (containsSecretExpression(preSteps)) {
    throw new Error("resume workflow must not expose Cloudflare secrets job-wide");
  }
  assertBootstrapStepsDoNotReceiveSecrets(workflow, "resume workflow");
  if (!workflow.includes("if: github.ref == 'refs/heads/main'")) {
    throw new Error("resume workflow must reject dispatches outside trusted main");
  }
  if (!workflow.includes("ref: ${{ github.sha }}")) {
    throw new Error("resume workflow must checkout its exact trusted dispatch SHA");
  }
  if (
    !workflow.includes(
      "environment: cost-guard-resume-${{ inputs.environment }}",
    )
  ) {
    throw new Error(
      "resume workflow must isolate credentials in the selected protected environment",
    );
  }
  if (
    /CLOUDFLARE_COST_GUARD_RESUME_TOKEN/i.test(workflow) ||
    /CLOUDFLARE_API_TOKEN/i.test(workflow)
  ) {
    throw new Error("resume workflow must not use the legacy combined Cloudflare token");
  }
  if (/\bwrangler\b[\s\S]{0,120}\br2\s+object\b/i.test(workflow)) {
    throw new Error(
      "resume workflow must use bucket-scoped S3 credentials, not native R2 REST",
    );
  }
  if (
    /\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/i.test(workflow)
  ) {
    throw new Error("resume workflow must store the non-secret account ID as an environment variable");
  }

  const download = namedStep(workflow, "Download stopped state");
  const metrics = namedStep(
    workflow,
    "Recheck account usage below five percent",
  );
  const upload = namedStep(
    workflow,
    "Queue one resume request for the next Cron",
  );
  const accountVariable = "${{ vars.CLOUDFLARE_ACCOUNT_ID }}";
  for (const [block, label] of [
    [download, "resume state download"],
    [metrics, "resume metrics recheck"],
    [upload, "resume request upload"],
  ]) {
    if (!block.includes(accountVariable)) {
      throw new Error(`${label} must receive the protected account ID variable`);
    }
  }
  assertExactSecrets(
    download,
    ["R2_COST_GUARD_ACCESS_KEY_ID", "R2_COST_GUARD_SECRET_ACCESS_KEY"],
    "resume state download",
  );
  assertExactSecrets(
    metrics,
    ["CLOUDFLARE_COST_GUARD_ANALYTICS_TOKEN"],
    "resume metrics recheck",
  );
  assertExactSecrets(
    upload,
    ["R2_COST_GUARD_ACCESS_KEY_ID", "R2_COST_GUARD_SECRET_ACCESS_KEY"],
    "resume request upload",
  );
  let outsideProviderSteps = workflow;
  for (const block of [download, metrics, upload]) {
    outsideProviderSteps = outsideProviderSteps.replace(block, "");
  }
  if (containsSecretExpression(outsideProviderSteps)) {
    throw new Error(
      "resume workflow must not expose secrets outside the three provider steps",
    );
  }
  for (const [block, fragments, label] of [
    [
      download,
      [
        "node scripts/cost-guard-resume-r2.mjs",
        "download-state",
        "--output .cost-guard/state.json",
      ],
      "resume state download",
    ],
    [
      upload,
      [
        "node scripts/cost-guard-resume-r2.mjs",
        "upload-request",
        "--input .cost-guard/resume-request.json",
      ],
      "resume request upload",
    ],
  ]) {
    for (const fragment of fragments) {
      if (!block.includes(fragment)) {
        throw new Error(`${label} is missing its fixed S3 helper contract`);
      }
    }
  }
  if (
    !workflow.includes('expected="RESUME STAGING"') ||
    !workflow.includes('expected="RESUME PRODUCTION"')
  ) {
    throw new Error("resume workflow must preserve exact typed confirmation");
  }
  for (const action of ["checkout", "setup-node"]) {
    const expected = IMMUTABLE_ACTION_REFS.get(action);
    if (!workflow.includes(`actions/${action}@${expected}`)) {
      throw new Error(
        `resume workflow must include actions/${action} at the verified immutable SHA`,
      );
    }
  }
  assertImmutableActionRefs(workflow, "resume workflow");
}

export function assertImmutableActionRefs(workflow, label) {
  for (const match of workflow.matchAll(
    /actions\/(checkout|setup-node|upload-artifact)@([^\s#]+)/g,
  )) {
    const [, action, reference] = match;
    const expected = IMMUTABLE_ACTION_REFS.get(action);
    if (reference !== expected) {
      throw new Error(
        `${label} must pin actions/${action} to the verified immutable SHA`,
      );
    }
  }
}

async function main() {
  const configPath = fileURLToPath(
    new URL("../wrangler.api.jsonc", import.meta.url),
  );
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  assertApiConfigDoesNotManagePublicRoutes(rawConfig);
  const costGuardConfigPath = fileURLToPath(
    new URL("../wrangler.cost-guard.jsonc", import.meta.url),
  );
  const { rawConfig: costGuardConfig } = experimental_readRawConfig({
    config: costGuardConfigPath,
  });
  assertCostGuardEmailIsDestinationLocked(costGuardConfig);

  const workflows = [
    {
      label: "staging deploy workflow",
      environment: "staging",
      url: new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    },
    {
      label: "production deploy workflow",
      environment: "production",
      url: new URL("../../.github/workflows/deploy-production.yml", import.meta.url),
    },
  ];
  for (const workflow of workflows) {
    const source = await readFile(workflow.url, "utf8");
    assertDeployWorkflowUsesBoundaryCheck(
      source,
      workflow.label,
      workflow.environment,
    );
    assertImmutableActionRefs(source, workflow.label);
    if (workflow.environment === "staging") {
      assertStagingDeployUsesTrustedPush(source);
      assertStagingDeployScopesCredentials(source);
    }
  }
  const resumeWorkflow = await readFile(
    new URL("../../.github/workflows/resume-cost-guard.yml", import.meta.url),
    "utf8",
  );
  assertResumeWorkflowScopesCredentials(resumeWorkflow);
  const ciWorkflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assertImmutableActionRefs(ciWorkflow, "CI workflow");
  process.stdout.write(
    "Cost Guard boundaries verified: route-free deploys, trusted staging trigger, scoped resume credentials, and locked alert destination.\n",
  );
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedUrl === import.meta.url) await main();
