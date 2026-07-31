begin;

-- Cover nullable audit/provenance foreign keys so parent updates and deletes
-- do not scan whole child tables as the dataset grows.
create index collection_audit_logs_actor_user_idx
  on app.collection_audit_logs (actor_user_id)
  where actor_user_id is not null;

create index collection_invites_created_by_idx
  on app.collection_invites (created_by)
  where created_by is not null;

create index collection_member_roles_assigned_by_idx
  on app.collection_member_roles (assigned_by)
  where assigned_by is not null;

create index collection_members_invited_by_idx
  on app.collection_members (invited_by)
  where invited_by is not null;

create index collection_profiles_avatar_asset_idx
  on app.collection_profiles (avatar_asset_id)
  where avatar_asset_id is not null;

create index collection_roles_created_by_idx
  on app.collection_roles (created_by)
  where created_by is not null;

create index lesson_progress_lesson_idx
  on app.lesson_progress (lesson_id);

create index lessons_published_by_idx
  on app.lessons (published_by)
  where published_by is not null;

create index profiles_avatar_asset_idx
  on app.profiles (avatar_asset_id)
  where avatar_asset_id is not null;

create index unit_revisions_created_by_idx
  on app.unit_revisions (created_by)
  where created_by is not null;

create index units_created_by_idx
  on app.units (created_by)
  where created_by is not null;

create index username_reservations_user_idx
  on app.username_reservations (user_id)
  where user_id is not null;

-- Existing application indexes cover only narrower active/draft scopes. These
-- broader indexes support foreign-key maintenance and collection-wide cleanup.
create index lessons_created_by_idx
  on app.lessons (created_by)
  where created_by is not null;

create index units_collection_idx
  on app.units (collection_id);

create index settings_collection_idx
  on app.settings (collection_id)
  where collection_id is not null;

commit;
