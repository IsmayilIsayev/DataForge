use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::ai::AiSettings;
use crate::core::drivers::{self, ConnectionMeta, Driver};
use crate::core::pool::PoolRegistry;
use crate::core::secrets;
use crate::error::{AppError, AppResult};

pub struct ConnectionStore {
    path: PathBuf,
    items: Vec<ConnectionMeta>,
}

impl ConnectionStore {
    fn load(path: PathBuf) -> Self {
        let items = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(items) => items,
                Err(error) => {
                    // Don't silently lose saved connections on a parse error —
                    // back the file up so the user can recover it.
                    eprintln!("connections.json parse error ({error}); backing up");
                    let backup = path.with_extension("corrupt.json");
                    let _ = std::fs::rename(&path, &backup);
                    Vec::new()
                }
            },
            Err(_) => Vec::new(),
        };

        Self { path, items }
    }

    pub fn list(&self) -> Vec<ConnectionMeta> {
        self.items.clone()
    }

    pub fn find(&self, id: &str) -> Option<ConnectionMeta> {
        self.items.iter().find(|item| item.id == id).cloned()
    }

    pub fn upsert(&mut self, meta: ConnectionMeta) -> AppResult<()> {
        match self.items.iter_mut().find(|item| item.id == meta.id) {
            Some(existing) => *existing = meta,
            None => self.items.push(meta),
        }
        self.persist()
    }

    pub fn remove(&mut self, id: &str) -> AppResult<()> {
        self.items.retain(|item| item.id != id);
        self.persist()
    }

    fn persist(&self) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| AppError::Config(format!("konfiqurasiya qovluğu: {error}")))?;
        }

        let data = serde_json::to_string_pretty(&self.items)
            .map_err(|error| AppError::Config(format!("konfiqurasiya: {error}")))?;

        // Atomic write: temp file + rename, so a crash mid-write cannot corrupt
        // connections.json (which would otherwise lose every saved connection).
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, data)
            .map_err(|error| AppError::Config(format!("konfiqurasiya faylı: {error}")))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|error| AppError::Config(format!("konfiqurasiya faylı: {error}")))
    }
}

pub struct AppState {
    pub ai: RwLock<AiSettings>,
    ai_path: PathBuf,
    pub pool: PoolRegistry,
    pub connections: RwLock<ConnectionStore>,
}

impl AppState {
    pub fn new(config_dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&config_dir)
            .map_err(|error| AppError::Config(format!("konfiqurasiya qovluğu: {error}")))?;

        let ai_path = config_dir.join("ai-settings.json");
        let ai = std::fs::read_to_string(&ai_path)
            .ok()
            .and_then(|text| serde_json::from_str::<AiSettings>(&text).ok())
            .unwrap_or_default();

        Ok(Self {
            ai: RwLock::new(ai),
            ai_path,
            pool: PoolRegistry::default(),
            connections: RwLock::new(ConnectionStore::load(config_dir.join("connections.json"))),
        })
    }

    pub async fn ai_settings(&self) -> AiSettings {
        self.ai.read().await.clone()
    }

    pub async fn set_ai_settings(&self, settings: AiSettings) -> AppResult<()> {
        let data = serde_json::to_string_pretty(&settings)
            .map_err(|error| AppError::Config(format!("AI konfiqurasiyası: {error}")))?;

        // Atomic write (temp + rename) so a crash cannot corrupt ai-settings.json.
        let tmp = self.ai_path.with_extension("json.tmp");
        std::fs::write(&tmp, data)
            .map_err(|error| AppError::Config(format!("AI konfiqurasiyası: {error}")))?;
        std::fs::rename(&tmp, &self.ai_path)
            .map_err(|error| AppError::Config(format!("AI konfiqurasiyası: {error}")))?;

        *self.ai.write().await = settings;
        Ok(())
    }

    pub async fn ensure_driver(&self, conn_id: &str) -> AppResult<Arc<dyn Driver>> {
        if let Some(driver) = self.pool.get_opt(conn_id).await {
            return Ok(driver);
        }

        let (input, password) = {
            let store = self.connections.read().await;
            let meta = store.find(conn_id).ok_or(AppError::NoConnection)?;
            (meta.to_input(), secrets::get_connection_password(conn_id)?)
        };

        let driver = drivers::connect(&input, password.as_deref()).await?;
        self.pool.insert(conn_id.to_string(), driver.clone()).await;
        Ok(driver)
    }
}
