# PostgreSQL backup runbook

The production backup workflow creates a daily encrypted tar bundle containing a logical
dump plus a checksummed row-count manifest, then stores the `.tar.age` object in a private
R2 backup bucket.

## Backup policy

- Dump application data and the Supabase Auth data needed to recover users.
- Database structure is reproduced from committed migrations.
- Encrypt before upload with an age recipient.
- Keep seven daily and four weekly objects.
- Never place a plaintext dump or age private key in the repository or Actions
  artifacts.

Required GitHub secrets:

- `SUPABASE_PRODUCTION_DB_URL`
- `BACKUP_AGE_RECIPIENT`
- `R2_BACKUP_ACCESS_KEY_ID`
- `R2_BACKUP_SECRET_ACCESS_KEY`
- `R2_BACKUP_ENDPOINT`
- `R2_BACKUP_BUCKET`

## Restore drill

At least monthly:

1. Download the newest encrypted object.
2. Decrypt it only inside an ephemeral runner or approved recovery machine.
3. Start a disposable PostgreSQL instance matching production's major version.
4. Apply committed migrations, verify the encrypted manifest checksum, then restore the
   data-only dump with triggers temporarily disabled.
5. Rebuild and validate foreign keys, validate file ownership/reference invariants, and
   compare all 20 application tables plus `auth.users` and `auth.identities` against the
   manifest row counts.
6. Record the recovery point and total restore time.
7. Destroy the disposable database and plaintext files.

An encrypted object that has not passed a restore drill is not considered a
verified backup.
