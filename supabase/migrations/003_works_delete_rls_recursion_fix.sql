begin;

create schema if not exists medclip_private;

revoke all on schema medclip_private from public, anon, authenticated;
grant usage on schema medclip_private to authenticated;
revoke create on schema medclip_private from authenticated;

create or replace function medclip_private.work_has_no_assets(
  target_work_id uuid,
  target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.work_assets as asset
    where asset.work_id = target_work_id
      and asset.user_id = target_user_id
  );
$$;

revoke execute on function medclip_private.work_has_no_assets(uuid, uuid)
  from public, anon, authenticated;
grant execute on function medclip_private.work_has_no_assets(uuid, uuid)
  to authenticated;

drop policy if exists "Users delete own works" on public.works;
create policy "Users delete own works"
on public.works for delete
to authenticated
using (
  user_id = (select auth.uid())
  and published = false
  and medclip_private.work_has_no_assets(works.id, works.user_id)
);

commit;
