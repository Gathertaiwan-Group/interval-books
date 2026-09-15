-- 只清「載入的物件」，不動 public schema 本身（drop schema public 會連 Supabase 的 default ACL 一起丟掉）
do $$ declare r record; begin
  for r in select quote_ident(n.nspname)||'.'||quote_ident(c.relname) q from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='v' loop execute 'drop view if exists '||r.q||' cascade'; end loop;
  for r in select quote_ident(n.nspname)||'.'||quote_ident(c.relname) q from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='r' and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')
           loop execute 'drop table if exists '||r.q||' cascade'; end loop;
  for r in select quote_ident(n.nspname)||'.'||quote_ident(c.relname) q from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relkind='S' loop execute 'drop sequence if exists '||r.q||' cascade'; end loop;
  for r in select p.oid::regprocedure::text q from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p')
           and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') loop execute 'drop routine if exists '||r.q||' cascade'; end loop;
  for r in select quote_ident(t.typname) q from pg_type t where t.typnamespace='public'::regnamespace and t.typtype='e'
           loop execute 'drop type if exists public.'||r.q||' cascade'; end loop;
end $$;
drop schema if exists inv cascade;
drop schema if exists happyhands cascade; drop schema if exists gooddays cascade; drop schema if exists gooddays_private cascade; drop schema if exists private cascade;
drop trigger if exists gooddays_on_auth_user_created on auth.users; drop trigger if exists happyhands_on_auth_user_created on auth.users; drop trigger if exists interval_on_auth_user_created on auth.users; drop trigger if exists on_auth_user_created on auth.users;
comment on schema public is 'standard public schema';
delete from auth.identities; delete from auth.users;
select (select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','S')) rels,
       (select count(*) from pg_proc where pronamespace='public'::regnamespace) fns,
       (select count(*) from auth.users) users,
       (select string_agg(nspname, ',' order by nspname) from pg_namespace where nspname not like 'pg_%' and nspname<>'information_schema') schemas,
       (select string_agg(extname||'@'||n.nspname, ',') from pg_extension e join pg_namespace n on n.oid=e.extnamespace) exts;
