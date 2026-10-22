use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::core::drivers::Driver;
use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct PoolRegistry {
    drivers: RwLock<HashMap<String, Arc<dyn Driver>>>,
}

impl PoolRegistry {
    pub async fn insert(&self, conn_id: String, driver: Arc<dyn Driver>) {
        self.drivers.write().await.insert(conn_id, driver);
    }

    pub async fn get(&self, conn_id: &str) -> AppResult<Arc<dyn Driver>> {
        self.get_opt(conn_id).await.ok_or(AppError::NoConnection)
    }

    pub async fn get_opt(&self, conn_id: &str) -> Option<Arc<dyn Driver>> {
        self.drivers.read().await.get(conn_id).cloned()
    }

    pub async fn remove(&self, conn_id: &str) {
        self.drivers.write().await.remove(conn_id);
    }
}
