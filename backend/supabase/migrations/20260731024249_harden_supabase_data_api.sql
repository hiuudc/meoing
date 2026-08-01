-- Supabase installs this event-trigger function in public so newly-created
-- public tables receive RLS automatically. The event trigger does not require
-- client roles to execute the function directly, and exposing it through
-- PostgREST would turn a SECURITY DEFINER helper into a public RPC.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable()
      from public, anon, authenticated;
  end if;
end
$$;

-- Meoing keeps its application API behind the Worker. New objects in the
-- default exposed schema must therefore remain inaccessible until a future
-- migration grants a role deliberately.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions
  from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions
  from public;
