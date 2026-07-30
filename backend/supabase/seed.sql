insert into app.username_reservations (
  username,
  reservation_type,
  reason
)
values
  ('admin', 'permanent', 'system'),
  ('administrator', 'permanent', 'system'),
  ('api', 'permanent', 'system'),
  ('everyone', 'permanent', 'system'),
  ('help', 'permanent', 'system'),
  ('meoi', 'permanent', 'brand'),
  ('meoing', 'permanent', 'brand'),
  ('moderator', 'permanent', 'system'),
  ('null', 'permanent', 'system'),
  ('official', 'permanent', 'system'),
  ('root', 'permanent', 'system'),
  ('security', 'permanent', 'system'),
  ('staff', 'permanent', 'system'),
  ('support', 'permanent', 'system'),
  ('system', 'permanent', 'system'),
  ('undefined', 'permanent', 'system'),
  ('www', 'permanent', 'system')
on conflict (username) do nothing;
