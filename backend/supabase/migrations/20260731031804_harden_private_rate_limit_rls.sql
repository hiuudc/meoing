begin;

alter table private.rate_limit_buckets enable row level security;
alter table private.rate_limit_buckets force row level security;

revoke all on table private.rate_limit_buckets
  from public, anon, authenticated, meoing_runtime, meoing_maintenance;

comment on table private.rate_limit_buckets is
  'Private abuse quota state. No direct RLS policy: access is limited to audited SECURITY DEFINER functions owned by a BYPASSRLS role.';

commit;
