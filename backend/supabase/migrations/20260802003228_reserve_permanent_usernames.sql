begin;

-- These names are application policy, not development fixtures. Keep them in
-- migration history so every hosted database receives the same permanent
-- reservations even though production deployments deliberately skip seed.sql.
-- api_change_username takes a row lock in this table before checking
-- username_reservations. Taking ACCESS EXCLUSIVE here makes every in-flight
-- username mutation finish before the precheck and keeps later mutations
-- blocked until all permanent reservations are visible at commit.
lock table app.profiles in access exclusive mode;

do $$
declare
  v_conflicting_usernames text;
begin
  select string_agg(profile.username, ', ' order by profile.username)
  into v_conflicting_usernames
  from app.profiles as profile
  where profile.username = any (array[
    'admin',
    'administrator',
    'api',
    'everyone',
    'help',
    'meoi',
    'meoing',
    'moderator',
    'null',
    'official',
    'root',
    'security',
    'staff',
    'support',
    'system',
    'undefined',
    'www'
  ]::text[]);

  if v_conflicting_usernames is not null then
    raise exception using
      errcode = '23514',
      message = 'PERMANENT_USERNAME_ALREADY_IN_USE',
      detail = v_conflicting_usernames;
  end if;
end
$$;

insert into app.username_reservations (
  username,
  reservation_type,
  user_id,
  expires_at,
  reason
)
values
  ('admin', 'permanent', null, null, 'system'),
  ('administrator', 'permanent', null, null, 'system'),
  ('api', 'permanent', null, null, 'system'),
  ('everyone', 'permanent', null, null, 'system'),
  ('help', 'permanent', null, null, 'system'),
  ('meoi', 'permanent', null, null, 'brand'),
  ('meoing', 'permanent', null, null, 'brand'),
  ('moderator', 'permanent', null, null, 'system'),
  ('null', 'permanent', null, null, 'system'),
  ('official', 'permanent', null, null, 'system'),
  ('root', 'permanent', null, null, 'system'),
  ('security', 'permanent', null, null, 'system'),
  ('staff', 'permanent', null, null, 'system'),
  ('support', 'permanent', null, null, 'system'),
  ('system', 'permanent', null, null, 'system'),
  ('undefined', 'permanent', null, null, 'system'),
  ('www', 'permanent', null, null, 'system')
on conflict (username) do update
set reservation_type = excluded.reservation_type,
    user_id = null,
    expires_at = null,
    reason = excluded.reason;

commit;
