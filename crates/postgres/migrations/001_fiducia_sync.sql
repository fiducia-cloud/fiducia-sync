create schema if not exists fiducia_sync;

create table if not exists fiducia_sync.changes (
    sync_sequence bigint generated always as identity primary key,
    tenant_id text not null check (tenant_id <> ''),
    table_name text not null check (table_name <> ''),
    operation text not null check (operation in ('upsert', 'delete')),
    row_id text not null check (row_id <> ''),
    version bigint not null check (version >= 0),
    row_data jsonb,
    write_key text,
    changed_at timestamptz not null default clock_timestamp(),
    check (
        (operation = 'upsert' and row_data is not null)
        or (operation = 'delete' and row_data is null)
    )
);

create index if not exists fiducia_sync_changes_tenant_cursor
    on fiducia_sync.changes (tenant_id, sync_sequence);

create index if not exists fiducia_sync_changes_row_version
    on fiducia_sync.changes (tenant_id, table_name, row_id, version desc);

create unique index if not exists fiducia_sync_changes_write_key
    on fiducia_sync.changes (tenant_id, write_key)
    where write_key is not null;

alter table fiducia_sync.changes enable row level security;

create or replace function fiducia_sync.current_tenant()
returns text
language sql
stable
parallel safe
set search_path = pg_catalog
as $function$
    select coalesce(
        nullif(current_setting('fiducia.tenant_id', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id',
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'tenant_id'
    )
$function$;

do $block$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'fiducia_sync'
          and tablename = 'changes'
          and policyname = 'fiducia_sync_tenant_isolation'
    ) then
        create policy fiducia_sync_tenant_isolation
            on fiducia_sync.changes
            using (tenant_id = fiducia_sync.current_tenant())
            with check (tenant_id = fiducia_sync.current_tenant());
    end if;
end
$block$;

create or replace function fiducia_sync.record_change(
    p_tenant_id text,
    p_table_name text,
    p_operation text,
    p_row_id text,
    p_version bigint,
    p_row_data jsonb default null,
    p_write_key text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, fiducia_sync
as $function$
declare
    v_sequence bigint;
    v_existing fiducia_sync.changes%rowtype;
begin
    if p_tenant_id is null or p_tenant_id = '' then
        raise exception 'tenant id must not be empty';
    end if;
    if p_table_name is null or p_table_name = '' then
        raise exception 'table name must not be empty';
    end if;
    if p_operation not in ('upsert', 'delete') then
        raise exception 'operation must be upsert or delete';
    end if;
    if p_row_id is null or p_row_id = '' then
        raise exception 'row id must not be empty';
    end if;
    if p_version is null or p_version < 0 then
        raise exception 'version must be non-negative';
    end if;

    insert into fiducia_sync.changes (
        tenant_id,
        table_name,
        operation,
        row_id,
        version,
        row_data,
        write_key
    )
    values (
        p_tenant_id,
        p_table_name,
        p_operation,
        p_row_id,
        p_version,
        case when p_operation = 'delete' then null else p_row_data end,
        nullif(p_write_key, '')
    )
    on conflict (tenant_id, write_key) where write_key is not null
    do nothing
    returning sync_sequence into v_sequence;

    if v_sequence is not null then
        return v_sequence;
    end if;

    select *
    into strict v_existing
    from fiducia_sync.changes
    where tenant_id = p_tenant_id
      and write_key = p_write_key;

    if v_existing.table_name <> p_table_name
       or v_existing.operation <> p_operation
       or v_existing.row_id <> p_row_id
       or v_existing.version <> p_version
       or v_existing.row_data is distinct from
          (case when p_operation = 'delete' then null else p_row_data end)
    then
        raise exception 'write key was reused for a different sync change';
    end if;

    return v_existing.sync_sequence;
end
$function$;

create or replace function fiducia_sync.capture_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, fiducia_sync
as $function$
declare
    v_tenant_column text := tg_argv[0];
    v_id_column text := tg_argv[1];
    v_version_column text := tg_argv[2];
    v_source jsonb;
    v_operation text;
    v_version bigint;
begin
    v_source := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
    v_operation := case when tg_op = 'DELETE' then 'delete' else 'upsert' end;
    v_version := (v_source ->> v_version_column)::bigint;
    if tg_op = 'DELETE' then
        v_version := v_version + 1;
    end if;

    perform fiducia_sync.record_change(
        v_source ->> v_tenant_column,
        tg_table_name,
        v_operation,
        v_source ->> v_id_column,
        v_version,
        case when tg_op = 'DELETE' then null else v_source end,
        nullif(current_setting('fiducia.write_key', true), '')
    );
    return case when tg_op = 'DELETE' then old else new end;
end
$function$;

create or replace function fiducia_sync.install_table(
    p_table regclass,
    p_tenant_column name default 'tenant_id',
    p_id_column name default 'id',
    p_version_column name default 'version'
)
returns void
language plpgsql
volatile
set search_path = pg_catalog, fiducia_sync
as $function$
declare
    v_column name;
begin
    foreach v_column in array array[p_tenant_column, p_id_column, p_version_column]
    loop
        if not exists (
            select 1
            from pg_attribute
            where attrelid = p_table
              and attname = v_column
              and attnum > 0
              and not attisdropped
        ) then
            raise exception 'required sync column % is missing from %', v_column, p_table;
        end if;
    end loop;

    execute format('alter table %s replica identity full', p_table);
    execute format('drop trigger if exists fiducia_sync_capture on %s', p_table);
    execute format(
        'create trigger fiducia_sync_capture after insert or update or delete on %s '
        'for each row execute function fiducia_sync.capture_change(%L, %L, %L)',
        p_table,
        p_tenant_column,
        p_id_column,
        p_version_column
    );
end
$function$;

-- Timestamp discipline for synced rows, borrowed from distributed databases:
-- CockroachDB's hybrid logical clocks never let a transaction timestamp move
-- backwards even when the wall clock does, and CouchDB-style replicas treat
-- write time as advisory next to the revision counter. Here the per-row
-- `version` stays the sole reconciliation key, and this trigger makes the
-- human-facing columns trustworthy:
--
--   * `created_at` is immutable after birth — an UPDATE cannot rewrite it.
--   * `updated_at` is strictly monotonic per row — `greatest(clock_timestamp(),
--     old.updated_at + 1 microsecond)`, so a stepped-back system clock (NTP,
--     VM resume) can never produce an `updated_at` that regresses or repeats.
--   * INSERT honors caller-supplied values (imports/backfills keep their
--     history) and fills both columns when absent.
--
-- `synced_at` deliberately does NOT exist server-side: "when did a replica
-- last reconcile this row" is a per-device fact, so each client store records
-- it locally (see the SDK/Flutter stores), while the journal's `changed_at`
-- remains the server-side commit clock carried to clients as `at_ms`.
create or replace function fiducia_sync.maintain_row_timestamps()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, fiducia_sync
as $function$
declare
    v_created_column text := coalesce(tg_argv[0], 'created_at');
    v_updated_column text := coalesce(tg_argv[1], 'updated_at');
    v_new jsonb := to_jsonb(new);
    v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
    v_now timestamptz := clock_timestamp();
    v_old_updated timestamptz;
    v_created timestamptz;
    v_updated timestamptz;
begin
    if tg_op = 'INSERT' then
        v_created := coalesce((v_new ->> v_created_column)::timestamptz, v_now);
        v_updated := greatest(
            coalesce((v_new ->> v_updated_column)::timestamptz, v_created),
            v_created
        );
    else
        v_created := coalesce(
            (v_old ->> v_created_column)::timestamptz,
            (v_new ->> v_created_column)::timestamptz,
            v_now
        );
        v_old_updated := (v_old ->> v_updated_column)::timestamptz;
        v_updated := greatest(
            v_now,
            coalesce(v_old_updated, v_now) + interval '1 microsecond'
        );
    end if;

    new := jsonb_populate_record(
        new,
        jsonb_build_object(v_created_column, v_created, v_updated_column, v_updated)
    );
    return new;
end
$function$;

create or replace function fiducia_sync.install_timestamps(
    p_table regclass,
    p_created_column name default 'created_at',
    p_updated_column name default 'updated_at'
)
returns void
language plpgsql
volatile
set search_path = pg_catalog, fiducia_sync
as $function$
declare
    v_column name;
begin
    foreach v_column in array array[p_created_column, p_updated_column]
    loop
        if not exists (
            select 1
            from pg_attribute
            where attrelid = p_table
              and attname = v_column
              and attnum > 0
              and not attisdropped
        ) then
            raise exception 'required timestamp column % is missing from %', v_column, p_table;
        end if;
    end loop;

    execute format('drop trigger if exists zzz_fiducia_sync_timestamps on %s', p_table);
    -- PostgreSQL fires same-event row triggers in name order; the zzz prefix
    -- makes this discipline run LAST, so an earlier trigger that stamps a raw
    -- now() (e.g. a bump_row_version-style trigger) is corrected, not trusted.
    execute format(
        'create trigger zzz_fiducia_sync_timestamps before insert or update on %s '
        'for each row execute function fiducia_sync.maintain_row_timestamps(%L, %L)',
        p_table,
        p_created_column,
        p_updated_column
    );
end
$function$;

create or replace function public.fiducia_sync_pull(
    p_tenant_id text,
    p_after bigint default 0,
    p_limit integer default 500
)
returns table (
    sync_sequence bigint,
    "table" text,
    op text,
    id text,
    version bigint,
    "row" jsonb,
    at_ms bigint,
    write_key text
)
language sql
stable
security invoker
set search_path = pg_catalog, fiducia_sync
as $function$
    select
        c.sync_sequence,
        c.table_name,
        c.operation,
        c.row_id,
        c.version,
        c.row_data,
        (extract(epoch from c.changed_at) * 1000)::bigint,
        c.write_key
    from fiducia_sync.changes as c
    where c.tenant_id = p_tenant_id
      and c.sync_sequence > greatest(p_after, 0)
    order by c.sync_sequence asc
    limit least(greatest(p_limit, 1), 1000)
$function$;

comment on function public.fiducia_sync_pull(text, bigint, integer) is
    'Tenant-scoped cursor catch-up for Supabase/PostgREST; row-level security remains authoritative.';

revoke all on function fiducia_sync.record_change(
    text, text, text, text, bigint, jsonb, text
) from public;
revoke all on function fiducia_sync.capture_change() from public;
revoke all on function fiducia_sync.maintain_row_timestamps() from public;
revoke all on function fiducia_sync.install_table(
    regclass, name, name, name
) from public;
revoke all on function fiducia_sync.install_timestamps(
    regclass, name, name
) from public;
revoke all on function public.fiducia_sync_pull(
    text, bigint, integer
) from public;

-- Supabase creates `authenticated`; ordinary PostgreSQL installations do not.
-- Grant only the RLS-protected read surface when that role exists. Domain writes
-- remain application-owned RPCs, and migration owners retain implicit function
-- execution without a blanket PUBLIC grant.
do $block$
begin
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        grant usage on schema fiducia_sync to authenticated;
        grant select on fiducia_sync.changes to authenticated;
        grant execute on function public.fiducia_sync_pull(
            text, bigint, integer
        ) to authenticated;
    end if;
end
$block$;
