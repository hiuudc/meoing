-- Cover the composite invite foreign key in its declared column order. The
-- primary key starts with invite_id but pairs it with role_id, while cascades
-- and integrity checks for this FK filter by invite_id plus collection_id.
create index collection_invite_roles_invite_collection_idx
  on app.collection_invite_roles (invite_id, collection_id);
