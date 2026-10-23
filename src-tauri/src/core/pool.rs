use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::core::drivers::{ConnectedDriver, Driver};
use crate::core::ssh::SshTunnel;
use crate::error::{AppError, AppResult};

struct PoolEntry {
    driver: Arc<dyn Driver>,
    /// The tunnel must outlive every driver clone; dropping the entry closes it.
    _tunnel: Option<SshTunnel>,
}

#[derive(Default)]
pub struct PoolRegistry {
    drivers: RwLock<HashMap<String, PoolEntry>>,
}

impl PoolRegistry {
    pub async fn insert(&self, conn_id: String, connection: ConnectedDriver) {
        let entry = PoolEntry {
            driver: connection.driver,
            _tunnel: connection.tunnel,
        };
        self.drivers.write().await.insert(conn_id, entry);
    }

    pub async fn get(&self, conn_id: &str) -> AppResult<Arc<dyn Driver>> {
        self.get_opt(conn_id).await.ok_or(AppError::NoConnection)
    }

    pub async fn get_opt(&self, conn_id: &str) -> Option<Arc<dyn Driver>> {
        self.drivers
            .read()
            .await
            .get(conn_id)
            .map(|entry| entry.driver.clone())
    }

    pub async fn remove(&self, conn_id: &str) {
        self.drivers.write().await.remove(conn_id);
    }
}
