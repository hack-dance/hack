alter table notes add column created_at timestamptz not null default now();
