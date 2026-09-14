# happyhands 改寫稽核

- 來源 migration：21 支（跳過 1：20260808000003_seed.sql）
- 本 schema 的表：20 張
- 改寫統計：{'public_dot': 515, 'schema_public': 7, 'search_path': 9}
- 移除：auth_trigger 4, bucket 2, insert 2, migrations_table 0

## 移除的 auth_trigger
- 20260810000001_staff_roles.sql: drop trigger if exists on_auth_user_created on auth.users;
- 20260810000001_staff_roles.sql: create trigger on_auth_user_created after insert on auth.users for each row execute functi
- 20260810000006_member_portal.sql: drop trigger if exists on_auth_user_created on auth.users;
- 20260810000006_member_portal.sql: create trigger on_auth_user_created after insert on auth.users for each row execute functi

## 移除的 bucket
- 20260810000002_media_bucket.sql: insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
- 20260828000001_lesson_content.sql: insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values

## 移除的 insert
- 20260827000004_intake_and_settings.sql: insert into public.site_settings (key, value) values ( 'teacher', jsonb_build_object( 'nam
- 20260827000004_intake_and_settings.sql: insert into public.site_settings (key, value) values ( 'health_notice', jsonb_build_object

## 殘留 public.（應為 0）：0

## 🔴 未限定表名（PostgREST search_path 下會靜默落到小時光 public 同名表）：0
| 行 | 所在函式 | 該函式 search_path | 判定 | 片段 |
|---|---|---|---|---|
