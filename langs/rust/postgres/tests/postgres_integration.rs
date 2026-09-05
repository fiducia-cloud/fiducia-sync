use fiducia_sync_core::{ChangeEvent, ChangeOp};
use fiducia_sync_postgres::PostgresSyncStore;
use sea_orm::ConnectionTrait;
use serde_json::json;

#[tokio::test]
async fn postgres_journal_captures_orders_and_isolates_tenants() {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("TEST_DATABASE_URL is unset; PostgreSQL integration test skipped");
        return;
    };

    let store = PostgresSyncStore::connect(&database_url, 4)
        .await
        .expect("connect test database");
    store.migrate().await.expect("install sync schema");
    store.migrate().await.expect("migration is idempotent");
    let public_execute = store
        .database()
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            "select has_function_privilege(\
                'public',\
                'public.fiducia_sync_pull(text,bigint,integer)',\
                'execute'\
             ) as allowed",
        ))
        .await
        .expect("inspect pull grants")
        .expect("pull grant row")
        .try_get::<bool>("", "allowed")
        .expect("pull grant boolean");
    assert!(!public_execute, "catch-up RPC must not be PUBLIC");

    store
        .database()
        .execute_unprepared(
            "drop table if exists public.fiducia_sync_test_items;\
             delete from fiducia_sync.changes \
             where tenant_id in ('sync-test-a', 'sync-test-b');\
             create table public.fiducia_sync_test_items (\
                 id text primary key,\
                 tenant_id text not null,\
                 version bigint not null,\
                 payload jsonb not null\
             );\
             select fiducia_sync.install_table(\
                 'public.fiducia_sync_test_items'::regclass\
             );",
        )
        .await
        .expect("prepare captured table");

    store
        .database()
        .execute_unprepared(
            "insert into public.fiducia_sync_test_items \
                 (id, tenant_id, version, payload) \
             values ('a1', 'sync-test-a', 1, '{\"name\":\"first\"}');\
             update public.fiducia_sync_test_items \
             set version = 2, payload = '{\"name\":\"updated\"}' \
             where id = 'a1';\
             insert into public.fiducia_sync_test_items \
                 (id, tenant_id, version, payload) \
             values ('b1', 'sync-test-b', 1, '{\"name\":\"other\"}');\
             delete from public.fiducia_sync_test_items where id = 'a1';",
        )
        .await
        .expect("write captured changes");

    let first = store.pull("sync-test-a", 0, 2).await.expect("first page");
    assert_eq!(first.changes.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.changes[0].version, 1);
    assert_eq!(first.changes[1].version, 2);
    assert_eq!(first.changes[0].table, "fiducia_sync_test_items");
    assert!(first.changes.iter().all(|change| change.id == "a1"));

    let second = store
        .pull("sync-test-a", first.next_cursor, 2)
        .await
        .expect("second page");
    assert_eq!(second.changes.len(), 1);
    assert!(!second.has_more);
    assert_eq!(second.changes[0].op, ChangeOp::Delete);
    assert_eq!(second.changes[0].version, 3);
    assert!(second.next_cursor > first.next_cursor);

    let other = store
        .pull("sync-test-b", 0, 10)
        .await
        .expect("other tenant");
    assert_eq!(other.changes.len(), 1);
    assert_eq!(other.changes[0].id, "b1");

    let manual = ChangeEvent {
        table: "public.manual_items".into(),
        op: ChangeOp::Upsert,
        id: "m1".into(),
        version: 7,
        row: json!({"id": "m1", "version": 7}),
        at_ms: 0,
        write_key: Some("manual-write-1".into()),
    };
    let sequence = store
        .record("sync-test-a", &manual)
        .await
        .expect("record manual change");
    let replayed_sequence = store
        .record("sync-test-a", &manual)
        .await
        .expect("record is idempotent by write key");
    assert_eq!(sequence, replayed_sequence);

    timestamp_discipline_holds(&store).await;
}

/// `install_timestamps` must fill created_at/updated_at on insert, keep
/// created_at immutable, and keep updated_at strictly monotonic per row even
/// when the wall clock lags the stored value (the CockroachDB-style rule).
async fn timestamp_discipline_holds(store: &PostgresSyncStore) {
    store
        .database()
        .execute_unprepared(
            "drop table if exists public.fiducia_sync_test_stamped;\
             create table public.fiducia_sync_test_stamped (\
                 id text primary key,\
                 note text not null default '',\
                 created_at timestamptz,\
                 updated_at timestamptz\
             );\
             select fiducia_sync.install_timestamps(\
                 'public.fiducia_sync_test_stamped'::regclass\
             );\
             select fiducia_sync.install_timestamps(\
                 'public.fiducia_sync_test_stamped'::regclass\
             );",
        )
        .await
        .expect("install_timestamps is idempotent");

    // s1 is an import: it keeps its historical created_at and a (hostilely)
    // future updated_at. s2 relies on the trigger for both stamps.
    store
        .database()
        .execute_unprepared(
            "insert into public.fiducia_sync_test_stamped (id, created_at, updated_at) \
             values (\
                 's1',\
                 clock_timestamp() - interval '1 hour',\
                 clock_timestamp() + interval '1 hour'\
             );\
             insert into public.fiducia_sync_test_stamped (id) values ('s2');\
             update public.fiducia_sync_test_stamped \
             set note = 'edited', created_at = clock_timestamp() \
             where id = 's1';",
        )
        .await
        .expect("write stamped rows");

    let stamped = store
        .database()
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            "select \
                 (s1.created_at < clock_timestamp() - interval '55 minutes') \
                     as created_immutable,\
                 (s1.updated_at > clock_timestamp() + interval '55 minutes') \
                     as updated_monotonic,\
                 (s2.created_at is not null \
                     and s2.updated_at >= s2.created_at \
                     and s2.created_at > clock_timestamp() - interval '5 minutes') \
                     as defaults_filled \
             from public.fiducia_sync_test_stamped as s1, \
                  public.fiducia_sync_test_stamped as s2 \
             where s1.id = 's1' and s2.id = 's2'",
        ))
        .await
        .expect("inspect stamped rows")
        .expect("stamped assertion row");

    let created_immutable = stamped
        .try_get::<bool>("", "created_immutable")
        .expect("created_immutable");
    let updated_monotonic = stamped
        .try_get::<bool>("", "updated_monotonic")
        .expect("updated_monotonic");
    let defaults_filled = stamped
        .try_get::<bool>("", "defaults_filled")
        .expect("defaults_filled");
    assert!(created_immutable, "an UPDATE must not rewrite created_at");
    assert!(
        updated_monotonic,
        "updated_at must stay ahead of its old value when the clock lags"
    );
    assert!(defaults_filled, "insert must fill both stamps when absent");
}
