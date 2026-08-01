begin;

drop policy collection_user_language_stats_write_own
  on app.collection_user_language_stats;

create policy collection_user_language_stats_insert_own
  on app.collection_user_language_stats
  for insert to meoing_runtime
  with check (
    user_id = private.current_user_id()
    and private.is_collection_member(collection_id)
  );

create policy collection_user_language_stats_update_own
  on app.collection_user_language_stats
  for update to meoing_runtime
  using (user_id = private.current_user_id())
  with check (
    user_id = private.current_user_id()
    and private.is_collection_member(collection_id)
  );

create policy collection_user_language_stats_delete_own
  on app.collection_user_language_stats
  for delete to meoing_runtime
  using (user_id = private.current_user_id());

commit;
