# Observability and quota alerts

## What the Workers emit

The API Worker writes structured `http_request` and `http_error` events with
request ID, route, status, duration, PostgreSQL duration and query count. It
does not log authorization headers, email, answers, lesson payloads or unit
content.

The hourly maintenance Worker writes:

- `maintenance_complete` with cleanup/finalization counts only;
- `maintenance_observation` with bounded stats-row samples, a point-in-time
  waiting-lock count and connection counts by PostgreSQL `application_name`;
- `maintenance_observation_failed` when observation fails without preventing
  retention/deletion work;
- `maintenance_failed` when the retention/deletion operation itself fails.

Stats size fields are the combined PostgreSQL storage size of `aggregate`,
`words`, `phrases` and `sentences`. The function samples 5% of table blocks,
caps each sample at 10,000 rows and falls back to at most 1,000 rows for a
small table. Consequently:

- `globalStatsP95Bytes` and `collectionStatsP95Bytes` are sampled estimates;
- `maxSampledStatsRowBytes` is not a guaranteed table-wide maximum;
- `estimated*StatsRows` comes from PostgreSQL planner statistics.

`waitingLockCount` is an hourly snapshot. `oldestWaitingQueryAgeMs` is the age
of the waiting query, an upper bound on lock-wait time because PostgreSQL does
not expose the wait start without additional telemetry. These fields must not
be reported as a continuous contention percentage.

## Application signals

Create log queries or a Logpush consumer for at least:

- HTTP 5xx rate and p95 latency by route;
- `RATE_LIMITED`, `REVISION_CONFLICT` and database-unavailable errors;
- any `maintenance_failed` event;
- repeated `maintenance_observation_failed` events;
- `globalStatsP95Bytes` or `collectionStatsP95Bytes` above 262,144 bytes;
- `sampledStatsRowsOver256KiB > 0`;
- `waitingLockCount > 0` in two consecutive hourly observations;
- a sustained rise in `apiConnectionCount`.

The 256 KiB signal starts the planned investigation/migration to normalized
term rows. A sampled breach is a trigger to run an exact, read-only database
analysis during a quiet period; it is not by itself proof that every row is
large. Lock snapshots should be correlated with API database duration and the
Supabase database dashboard before changing schema or query behavior.

## Provider quota alerts

Repository code cannot create or verify billing/quota alarms for Cloudflare,
Supabase or Brevo. Configure the following in their dashboards or in the
organization's external monitoring system, and record the alert IDs in the
private operations inventory:

| Provider signal | Warning | Critical |
| --- | ---: | ---: |
| Workers included requests/CPU allocation | 70% | 85% |
| Supabase database size | 70% | 85% |
| Supabase MAU and egress | 70% | 85% |
| R2 storage and billable operations | 70% | 85% |
| Brevo daily email allowance | 70% | 85% |

Route warning and critical alerts to different severities. Test each
notification channel with a provider test event and retain evidence with the
release checklist. The percentages above are configuration requirements, not
metrics emitted by this repository.

## Release review

After the staging load gate:

1. inspect the load-gate JSON artifact for latency, error rate and readiness;
2. inspect Hyperdrive and PostgreSQL connection graphs for exhaustion;
3. correlate any lock snapshot with `databaseDurationMs`;
4. verify current provider quota utilization is below the warning level;
5. confirm the latest maintenance and backup/restore workflows succeeded.
