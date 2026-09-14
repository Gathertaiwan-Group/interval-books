# gooddays 改寫稽核

- 來源 migration：16 支（跳過 1：20260719000002_seed_artwork_images.sql）
- 本 schema 的表：16 張
- 改寫統計：{'public_dot': 248, 'schema_public': 1, 'search_path': 9, 'private_dot': 27, 'schema_private': 2}
- 移除：auth_trigger 1, bucket 2, insert 7, migrations_table 1

## 移除的 auth_trigger
- 20260718000001_init.sql: create trigger on_auth_user_created after insert on auth.users for each row execute functi

## 移除的 bucket
- 20260720000001_checkout_v2.sql: insert into storage.buckets (id, name, public) values ('chat-uploads', 'chat-uploads', tru
- 20260806000002_product_images_bucket.sql: insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values

## 移除的 insert
- 20260718000001_init.sql: insert into public.settings (key, value) values ('company_profile', '{"name": "interval", 
- 20260719000001_littlemoments.sql: insert into public.products (slug, name, description, price, currency, category, stock, st
- 20260719000001_littlemoments.sql: insert into public.products (slug, name, description, price, currency, category, stock, st
- 20260719000001_littlemoments.sql: insert into public.membership_tiers (slug, name, price_yearly, rebate_rate, perks, sort) v
- 20260719000001_littlemoments.sql: insert into public.products (slug, name, description, price, currency, category, stock, st
- 20260719000001_littlemoments.sql: insert into public.settings (key, value) values ('company_profile', '{ "name": "小時光 little
- 20260720000001_checkout_v2.sql: insert into public.settings (key, value) values ('shipping', '{"fee_home": 200, "free_thre

## 移除的 migrations_table
- 20260819000001_security_hardening.sql: alter table public._migrations enable row level security;

## 殘留 public.（應為 0）：0

## 殘留 private.（應為 0）：0

## 🔴 未限定表名（PostgREST search_path 下會靜默落到小時光 public 同名表）：2
| 行 | 所在函式 | 該函式 search_path | 判定 | 片段 |
|---|---|---|---|---|
| 1043 | gooddays_private.is_admin | gooddays | ✅ 安全 | `FROM products p` |
| 1069 | gooddays_private.is_admin | gooddays | ✅ 安全 | `FROM orders o` |
