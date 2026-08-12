# PostgreSQL backup runbook

The production backup pipeline creates an encrypted tar bundle containing a logical dump
plus a checksummed row-count manifest, then stores the `.tar.age` object in a private R2
backup bucket. Plaintext dumps and the age private identity exist only on an ephemeral
runner.

## Schedule and recovery objective

- **Weekly production database backup** runs every Sunday at 02:23 UTC.
- Scheduled objects use immutable keys under `weekly/`. Uploads are atomic create-only
  `PutObject` requests (`If-None-Match: *`), so a repeated key cannot overwrite an object.
- A manual dispatch creates an immutable object under `manual/`; it never writes or
  overwrites the scheduled prefix. The same automatic restore gate verifies that exact
  object, while weekly retention remains disabled for the manual run.
- The repository-managed logical-backup recovery point objective is seven days when the
  weekly workflow succeeds on schedule. The restore gate rejects an object whose R2
  `LastModified` age is greater than eight days, leaving one day of scheduling grace.
- GitHub schedules are best-effort. Treat a failed workflow or a weekly object/verification
  marker approaching eight days old as an incident; rerun the original scheduled workflow
  so it retains its weekly event context. A normal manual dispatch is an additional manual
  object, not a replacement for the scheduled weekly recovery point.
- **Production backup freshness monitor** runs daily at 06:47 UTC and fails unless the
  newest weekly object, its exact restore marker, and the manifest recovery point are all
  no more than eight days old. Route this independent workflow's failures to the backup
  alert channel so a missed weekly schedule is still detected.

## Backup policy

- Dump application data and the Supabase Auth data needed to recover users.
- Before opening the exported snapshot, require the database URL to contain exactly one
  `sslmode=require` or `sslmode=verify-full`, prove that the current PostgreSQL session uses
  TLS, and match `private.deployment_identity` to `production` plus the independently pinned
  Supabase project ref. A staging URL or an unencrypted session must fail before `pg_dump`.
- Reproduce database structure from committed migrations.
- Encrypt the tar archive with the configured age recipient before any upload.
- Format-v2 encrypted manifests contain the exact R2 object key. The uploader records the
  ciphertext SHA-256 as R2 custom metadata. A restore must match the manifest key, the
  downloaded ciphertext SHA-256, `HeadObject` ETag and size before it can publish a marker.
- Before dumping, explicitly paginate and sum every object in the private backup bucket,
  including `weekly/`,
  `manual/`, legacy `daily/`, verification markers, and any unexpected key. Repeat the
  check with the encrypted archive's size before upload. Both the existing and projected
  allocations must be at most 3 GiB (3,221,225,472 bytes); an object outside a known
  prefix cannot bypass the cap. The restore gate repeats the whole-bucket check before
  creating or replacing its verification marker, so markers cannot push allocation above
  the same ceiling.
- Count manual and unverified objects against the same 3 GiB allocation. They are not
  automatically pruned. Use the protected exact-inventory cleanup described below after
  their incident or change window; do not delete them directly from an ordinary backup job.
- Never place a plaintext dump, age private key, database URL, or decrypted content in the
  repository or Actions artifacts.

If rollout begins without enough headroom for the first weekly archive, run **Cleanup
unretained database backups** in preview mode and remove only its approved candidates. If
that is insufficient, stop and escalate to the backup owner; do not raise or bypass the cap,
and do not bypass the verified-weekly gate for legacy daily deletion.

The `production-backup` GitHub environment must restrict deployments to `main`. The
workflows also fail a non-`main` runtime ref, but that check is defense in depth and cannot
replace the environment deployment-branch policy. Define the non-secret
`EXPECTED_SUPABASE_PROJECT_REF` variable independently from the database URL, and store
these secrets there:

- `SUPABASE_PRODUCTION_DB_URL`, using the production direct/session connection with an
  explicit `sslmode=require` or `sslmode=verify-full`
- `BACKUP_AGE_RECIPIENT`
- `BACKUP_AGE_IDENTITY`
- `R2_BACKUP_READ_ACCESS_KEY_ID` / `R2_BACKUP_READ_SECRET_ACCESS_KEY`: bucket-scoped
  Cloudflare **Object Read only**, used only by freshness checks.
- `R2_BACKUP_WRITE_ACCESS_KEY_ID` / `R2_BACKUP_WRITE_SECRET_ACCESS_KEY`: dedicated
  bucket-scoped writer used only by archive creation.
- `R2_BACKUP_VERIFY_ACCESS_KEY_ID` / `R2_BACKUP_VERIFY_SECRET_ACCESS_KEY`: dedicated
  verifier credential used to read archives and conditionally create/replace markers.
- `R2_BACKUP_RETENTION_ACCESS_KEY_ID` / `R2_BACKUP_RETENTION_SECRET_ACCESS_KEY`:
  dedicated automatic weekly-retention credential.
- `R2_BACKUP_ENDPOINT`
- `R2_BACKUP_BUCKET`

Create a separate `production-backup-destructive` GitHub environment, restrict it to
`main`, and require reviewer approval. Store only the shared endpoint/bucket plus
`R2_BACKUP_DELETE_ACCESS_KEY_ID` / `R2_BACKUP_DELETE_SECRET_ACCESS_KEY` there. Do not use
this credential in freshness, archive creation or restore jobs. Cloudflare currently offers
bucket-scoped **Object Read only** and **Object Read & Write** S3 credentials, not a native
put-without-delete permission. Separate write credentials improve rotation and auditability;
an eight-day R2 bucket lock on `weekly/` and `manual/` is the enforcement that prevents a
writer from overwriting or deleting a fresh recovery object.

## Automatic restore and retention gate

Every successful weekly or manually dispatched upload calls the reusable **Restore
encrypted production backup** workflow with the exact newly created key. The restore job:

1. Confirms that the exact R2 object exists and is no more than eight days old, then records
   its ETag, size, `LastModified` and ciphertext SHA-256 metadata.
2. Downloads it conditionally with that ETag, verifies its size and ciphertext SHA-256, and
   decrypts it only inside an ephemeral runner.
3. Starts a disposable PostgreSQL instance matching production's major version.
4. Applies committed migrations, validates the manifest version, exact object key, creation
   timestamp and dump checksum, then restores the data-only dump with triggers temporarily
   disabled.
5. Rebuilds and validates foreign keys, validates file ownership/reference invariants, and
   compares all 20 application tables plus `auth.users` and `auth.identities` against the
   manifest row counts.
6. Rechecks that `HeadObject` is unchanged, then conditionally writes a format-v2
   `verified/<backup-key>.json` marker containing the exact ETag, ciphertext size and
   SHA-256. A final `HeadObject` check catches a change during publication. The runner then
   destroys the disposable database and plaintext files.

The pipeline prunes `weekly/` only when the upload was scheduled and both the backup job
and its exact restore job succeeded, with a verification marker that still matches that
object. A manual upload is restored and marked but never enters this automatic retention
job. Weekly retention validates every
marker against the current object ETag/size/SHA metadata, sorts the corresponding backup
objects by R2 `LastModified`, retains the four
newest **verified** weekly objects, and removes older verified objects and their markers.
An unverified object never consumes one of the four retention slots and is left untouched
for diagnosis. It still counts against the 3 GiB cap and therefore requires explicit
operator resolution through **Cleanup unretained database backups**. A backup, restore,
marker or identity check failure performs no pruning; investigate and rerun the failed
scheduled workflow.

Migration-era format-v1 markers are not trusted for retention because they do not bind the
ciphertext ETag, size and checksum. Restore the corresponding legacy key to replace its
marker with format v2, or use the approved `unverified-weekly` cleanup after its retention
window.

The standalone restore workflow remains manually dispatchable for re-verification. With no
key it selects the newest weekly object; an exact immutable `weekly/` or `manual/` key can
be supplied. It uses the same eight-day freshness and full restore checks. A standalone
manual restore writes a verification marker but does not invoke scheduled retention.

Record the selected recovery point and total restore time from each workflow run. An
encrypted object without a successful marker-producing restore is not a verified backup.

## One-time legacy daily cleanup

The weekly rollout deliberately stops creating and pruning `daily/` objects. Existing
legacy daily objects continue to count against the 3 GiB allocation until an operator
removes them with **Cleanup legacy daily database backups**.

Preview mode is read-only and may be run during rollout. Do not run delete mode until the
first new immutable weekly object has completed its automatic restore. Delete mode
independently requires a fresh marker for a new-style weekly key and confirms that the
referenced weekly object still exists.

1. Dispatch the cleanup workflow with `mode=preview`. Retain the printed object count and
   review every exact `daily/` key and the total bytes.
2. Confirm that the referenced weekly backup and its automatic restore workflow succeeded.
3. Dispatch it again with `mode=delete`, copy both `expected_object_count` and the
   `expected_inventory_digest` SHA-256 from preview, and type
   `DELETE LEGACY DAILY BACKUPS` in `confirmation`.
4. If the exact sorted key/size/LastModified/ETag inventory changed (even when its count did
   not), a key is unexpected, the marker no longer matches the weekly ciphertext, or the
   verified weekly object is missing, the workflow fails before deleting anything.
   Investigate and preview again.

R2 object deletion is destructive; retain the workflow log as the cleanup record. The
script addresses each validated legacy object explicitly and never performs a recursive
bucket deletion.

R2 `DeleteObject` does not provide the conditional `If-Match` precondition used for reads
and writes. Each destructive script therefore validates the complete approved inventory,
rechecks every relevant `HeadObject`, and only then issues explicit deletes while all
repository backup writers share the `production-backup-storage` concurrency group. Do not
run external writes against the backup bucket during cleanup. If a credential or external
writer may be active, revoke or rotate it and preview again before approving deletion; the
repository checks narrow but cannot eliminate the final provider-side check/delete race.

## Controlled cleanup for manual and unverified objects

Use **Cleanup unretained database backups** to recover allocation without weakening the
3-GiB or restore-before-prune gates. It has two scopes:

- `manual`: new-style manual archives older than eight days; a matching marker is removed
  with each selected archive.
- `unverified-weekly`: new-style or migration-era legacy weekly archives older than eight
  days that have no valid format-v2 marker matching their current ETag, ciphertext size and,
  where present, SHA-256 metadata. A format-v1, malformed, replayed or mismatched marker is
  included in the exact approved candidate record and removed with its archive; a valid
  marker keeps the archive out of this cleanup path.

Run `preview` first. Review every candidate and retain the emitted count and SHA-256 digest
of the sorted candidate records. Then run `delete` from `main`, provide the exact count and
digest, type `DELETE UNRETAINED BACKUPS`, and approve the
`production-backup-destructive` environment. The script recomputes the candidate set and
checks every archive and marker identity again before issuing explicit object deletes. A
same-count replacement, a candidate younger than eight days, a newly valid marker, or any
malformed prefix causes a fail-closed exit.
