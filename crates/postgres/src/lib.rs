//! PostgreSQL change-journal adapter for `fiducia-sync`.
//!
//! The root crate remains a zero-I/O reconciliation kernel. This companion
//! crate owns the server-side SeaORM boundary: installing the portable journal,
//! recording committed changes, and pulling tenant-scoped cursor pages.

use fiducia_sync_core::{ChangeEvent, ChangeOp};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DatabaseTransaction, DbBackend,
    DbErr, RuntimeErr, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{net::IpAddr, time::Duration};
use thiserror::Error;
use url::Url;

/// Idempotent PostgreSQL/Supabase-compatible schema installation.
pub const MIGRATION_SQL: &str = include_str!("../migrations/001_fiducia_sync.sql");

const MAX_PAGE_SIZE: u32 = 1_000;

#[derive(Debug, Error)]
pub enum SyncStoreError {
    #[error(transparent)]
    Database(#[from] DbErr),
    #[error("tenant id must not be empty")]
    EmptyTenant,
    #[error("cursor must be non-negative")]
    NegativeCursor,
    #[error("page size must be between 1 and {MAX_PAGE_SIZE}")]
    InvalidPageSize,
    #[error("database returned an unsupported change operation: {0}")]
    InvalidChangeOperation(String),
}

/// A globally ordered page. Row reconciliation still uses each event's
/// `version`; `next_cursor` is only the durable catch-up position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PullPage {
    pub changes: Vec<ChangeEvent>,
    pub next_cursor: i64,
    pub has_more: bool,
}

#[derive(Clone)]
pub struct PostgresSyncStore {
    database: DatabaseConnection,
}

impl PostgresSyncStore {
    pub async fn connect(url: &str, max_connections: u32) -> Result<Self, SyncStoreError> {
        let mut options = secure_pg_connect_options(url)?;
        options
            .max_connections(max_connections)
            .acquire_timeout(Duration::from_secs(5));
        Ok(Self {
            database: Database::connect(options).await?,
        })
    }

    pub fn from_database(database: DatabaseConnection) -> Self {
        Self { database }
    }

    pub fn database(&self) -> &DatabaseConnection {
        &self.database
    }

    pub async fn ready(&self) -> Result<(), SyncStoreError> {
        self.database
            .query_one_raw(Statement::from_string(DbBackend::Postgres, "select 1"))
            .await?;
        Ok(())
    }

    /// Install or upgrade the embedded sync schema.
    pub async fn migrate(&self) -> Result<(), SyncStoreError> {
        let transaction = self.database.begin().await?;
        transaction
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select pg_advisory_xact_lock($1)",
                [7_606_989_310_011_001_i64.into()],
            ))
            .await?;
        transaction.execute_unprepared(MIGRATION_SQL).await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Record an authoritative change when the domain service cannot use the
    /// supplied trigger. Trigger-based capture and this method share the same
    /// journal and wire envelope.
    pub async fn record(
        &self,
        tenant_id: &str,
        event: &ChangeEvent,
    ) -> Result<i64, SyncStoreError> {
        validate_tenant(tenant_id)?;
        let transaction = self.database.begin().await?;
        bind_tenant(&transaction, tenant_id).await?;
        if let Some(write_key) = event.write_key.as_deref() {
            transaction
                .execute_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "select set_config('fiducia.write_key', $1, true)",
                    [write_key.into()],
                ))
                .await?;
        }
        let operation = match event.op {
            ChangeOp::Upsert => "upsert",
            ChangeOp::Delete => "delete",
        };
        let row = transaction
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select fiducia_sync.record_change($1,$2,$3,$4,$5,$6,$7) as sync_sequence",
                [
                    tenant_id.into(),
                    event.table.clone().into(),
                    operation.into(),
                    event.id.clone().into(),
                    event.version.into(),
                    event.row.clone().into(),
                    event.write_key.clone().into(),
                ],
            ))
            .await?
            .ok_or_else(|| DbErr::RecordNotFound("sync sequence was not returned".into()))?;
        let sequence = row.try_get("", "sync_sequence")?;
        transaction.commit().await?;
        Ok(sequence)
    }

    /// Pull committed changes after `cursor`, scoped twice: by an explicit
    /// tenant predicate and by transaction-local RLS context.
    pub async fn pull(
        &self,
        tenant_id: &str,
        cursor: i64,
        page_size: u32,
    ) -> Result<PullPage, SyncStoreError> {
        validate_tenant(tenant_id)?;
        if cursor < 0 {
            return Err(SyncStoreError::NegativeCursor);
        }
        if page_size == 0 || page_size > MAX_PAGE_SIZE {
            return Err(SyncStoreError::InvalidPageSize);
        }

        let transaction = self.database.begin().await?;
        bind_tenant(&transaction, tenant_id).await?;
        let rows = transaction
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select sync_sequence, table_name, operation, row_id, version, row_data, \
                        (extract(epoch from changed_at) * 1000)::bigint as at_ms, write_key \
                 from fiducia_sync.changes \
                 where tenant_id = $1 and sync_sequence > $2 \
                 order by sync_sequence asc limit $3",
                [
                    tenant_id.into(),
                    cursor.into(),
                    i64::from(page_size + 1).into(),
                ],
            ))
            .await?;

        let has_more = rows.len() > page_size as usize;
        let mut sequenced = rows
            .into_iter()
            .take(page_size as usize)
            .map(|row| {
                let operation: String = row.try_get("", "operation")?;
                let op = match operation.as_str() {
                    "upsert" => ChangeOp::Upsert,
                    "delete" => ChangeOp::Delete,
                    other => {
                        return Err(SyncStoreError::InvalidChangeOperation(other.to_string()));
                    }
                };
                let sequence: i64 = row.try_get("", "sync_sequence")?;
                let row_data: Option<Value> = row.try_get("", "row_data")?;
                let event = ChangeEvent {
                    table: row.try_get("", "table_name")?,
                    op,
                    id: row.try_get("", "row_id")?,
                    version: row.try_get("", "version")?,
                    row: row_data.unwrap_or(Value::Null),
                    at_ms: row.try_get("", "at_ms")?,
                    write_key: row.try_get("", "write_key")?,
                };
                Ok((sequence, event))
            })
            .collect::<Result<Vec<_>, SyncStoreError>>()?;
        transaction.commit().await?;

        let next_cursor = sequenced.last().map_or(cursor, |(sequence, _)| *sequence);
        let changes = sequenced.drain(..).map(|(_, event)| event).collect();
        Ok(PullPage {
            changes,
            next_cursor,
            has_more,
        })
    }
}

async fn bind_tenant(transaction: &DatabaseTransaction, tenant_id: &str) -> Result<(), DbErr> {
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select set_config('fiducia.tenant_id', $1, true)",
            [tenant_id.into()],
        ))
        .await?;
    Ok(())
}

fn validate_tenant(tenant_id: &str) -> Result<(), SyncStoreError> {
    if tenant_id.trim().is_empty() {
        Err(SyncStoreError::EmptyTenant)
    } else {
        Ok(())
    }
}

/// Require certificate and hostname verification for remote PostgreSQL.
pub fn secure_pg_connect_options(url: &str) -> Result<ConnectOptions, SyncStoreError> {
    let parsed = Url::parse(url).map_err(configuration_error)?;
    let host = parsed.host_str().unwrap_or_default();
    let has_unix_socket = parsed
        .query_pairs()
        .any(|(key, value)| key == "host" && value.starts_with('/'));
    let is_local = has_unix_socket || is_loopback_postgres_host(host);
    let ssl_mode = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "sslmode").then(|| value.into_owned()));
    if !is_local && ssl_mode.as_deref() != Some("verify-full") {
        return Err(configuration_error(format!(
            "PostgreSQL host {host:?} is not loopback; sslmode=verify-full is required"
        )));
    }
    Ok(ConnectOptions::new(url.to_string()))
}

fn is_loopback_postgres_host(host: &str) -> bool {
    let host = host.trim();
    host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("localhost.")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn configuration_error(error: impl std::fmt::Display) -> SyncStoreError {
    SyncStoreError::Database(DbErr::Conn(RuntimeErr::Internal(error.to_string())))
}

#[cfg(test)]
mod tests {
    use super::{PullPage, SyncStoreError, secure_pg_connect_options, validate_tenant};

    #[test]
    fn tenant_and_page_guards_are_explicit() {
        assert!(matches!(
            validate_tenant(" "),
            Err(SyncStoreError::EmptyTenant)
        ));
        assert!(validate_tenant("tenant-a").is_ok());
    }

    #[test]
    fn remote_postgres_requires_hostname_verification() {
        assert!(secure_pg_connect_options("postgres://db.example.com/sync").is_err());
        assert!(
            secure_pg_connect_options("postgres://db.example.com/sync?sslmode=verify-full").is_ok()
        );
    }

    #[test]
    fn local_postgres_can_use_local_transport_security() {
        for url in [
            "postgres://localhost/sync?sslmode=disable",
            "postgres://127.0.0.1/sync?sslmode=disable",
            "postgres://[::1]/sync?sslmode=disable",
            "postgres:///?host=/var/run/postgresql/&sslmode=disable",
        ] {
            assert!(secure_pg_connect_options(url).is_ok(), "rejected {url}");
        }
    }

    #[test]
    fn empty_pull_page_has_a_stable_wire_shape() {
        let page = PullPage {
            changes: vec![],
            next_cursor: 42,
            has_more: false,
        };
        assert_eq!(
            serde_json::to_value(page).unwrap(),
            serde_json::json!({
                "changes": [],
                "next_cursor": 42,
                "has_more": false
            })
        );
    }
}
