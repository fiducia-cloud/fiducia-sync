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
}
