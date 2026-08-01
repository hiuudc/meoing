import assert from "node:assert/strict";
import test from "node:test";

import { parseMetrics } from "./request-cost-guard-resume.mjs";

function metricsPayload(actionType) {
  return {
    data: {
      viewer: {
        accounts: [{
          workersInvocationsAdaptive: [],
          r2OperationsAdaptiveGroups: [{
            dimensions: { actionType },
            sum: { requests: 5 },
          }],
          r2StorageAdaptiveGroups: [],
        }],
      },
    },
  };
}

test("resume metrics treat Cloudflare bulk deletes as free operations", () => {
  assert.deepEqual(parseMetrics(metricsPayload("DeleteObjects")), {
    workerRequests: 0,
    workerCpuMs: 0,
    r2ClassAOperations: 0,
    r2ClassBOperations: 0,
    r2StorageBytes: 0,
  });
});

test("resume metrics still reject an unknown R2 action", () => {
  assert.throws(
    () => parseMetrics(metricsPayload("FuturePaidOperation")),
    /Unknown R2 action/,
  );
});
