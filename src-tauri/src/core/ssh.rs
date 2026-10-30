use std::sync::{Arc, Mutex};

use russh::client;
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::Disconnect;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::error::{AppError, AppResult};

const DEFAULT_SSH_PORT: u16 = 22;

fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    Password,
    Key,
}

/// SSH endpoint configuration. `host_key` is the SHA256 fingerprint learned on
/// the first successful connection (trust on first use); it is persisted in
/// connections.json, while the password/passphrase lives in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
}

/// Normalize the two fingerprint spellings we may encounter so a stored value
/// and a freshly computed value can be compared byte-for-byte.
pub(crate) fn normalize_fingerprint(value: &str) -> String {
    let value = value.trim();
    let body = value
        .strip_prefix("SHA256:")
        .or_else(|| value.strip_prefix("sha256:"))
        .unwrap_or(value);
    format!("SHA256:{body}")
}

pub(crate) fn fingerprints_match(expected: &str, offered: &str) -> bool {
    normalize_fingerprint(expected) == normalize_fingerprint(offered)
}

#[derive(Default)]
struct HostKeyState {
    fingerprint: Option<String>,
    mismatch: bool,
}

struct ClientHandler {
    expected: Option<String>,
    state: Arc<Mutex<HostKeyState>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Displays as "SHA256:<base64>", the same spelling older releases stored.
        let offered = server_public_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let accepted = match &self.expected {
            Some(expected) => fingerprints_match(expected, &offered),
            None => true,
        };

        if let Ok(mut state) = self.state.lock() {
            state.fingerprint = Some(offered);
            state.mismatch = !accepted;
        }

        Ok(accepted)
    }
}

/// A running local port-forward. Dropping it asks the accept loop to stop,
/// which closes the TCP listener and disconnects the SSH session.
pub struct SshTunnel {
    local_port: u16,
    host_key: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl SshTunnel {
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn host_key(&self) -> &str {
        &self.host_key
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        // Do not abort the task: it needs to observe the signal so it can drop
        // the listener and disconnect the session. Dropping the JoinHandle
        // merely detaches it.
        drop(self.task.take());
    }
}

fn expand_key_path(path: &str) -> std::path::PathBuf {
    let path = path.trim();
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    std::path::PathBuf::from(path)
}

async fn authenticate(
    session: &mut client::Handle<ClientHandler>,
    cfg: &SshConfig,
    secret: Option<&str>,
) -> AppResult<()> {
    let authenticated = match cfg.auth {
        SshAuth::Password => session
            .authenticate_password(cfg.username.as_str(), secret.unwrap_or(""))
            .await
            .map(|result| result.success())
            .map_err(|error| AppError::Config(format!("SSH authentication failed: {error}")))?,
        SshAuth::Key => {
            let key_path = cfg
                .key_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| AppError::Config("SSH key file path is required".to_string()))?;
            let path = expand_key_path(key_path);
            let passphrase = secret
                .filter(|secret| !secret.is_empty())
                .map(str::to_string);

            let key = tokio::task::spawn_blocking(move || {
                load_secret_key(path, passphrase.as_deref())
            })
            .await
            .map_err(|error| AppError::Config(format!("SSH key: {error}")))?
            .map_err(|error| AppError::Config(format!("SSH key could not be loaded: {error}")))?;

            // RSA keys must sign with a SHA-2 hash the server accepts; ignored for other key types.
            let hash_alg = session
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            session
                .authenticate_publickey(
                    cfg.username.as_str(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map(|result| result.success())
                .map_err(|error| AppError::Config(format!("SSH authentication failed: {error}")))?
        }
    };

    if authenticated {
        Ok(())
    } else {
        Err(AppError::Config(
            "SSH authentication failed: the server rejected the credentials".to_string(),
        ))
    }
}

/// Bind a local ephemeral port and forward every accepted connection to
/// `target_host:target_port` through a `direct-tcpip` SSH channel.
///
/// The SSH host key is trusted on first use: if `cfg.host_key` is absent the
/// accepted fingerprint is returned on [`SshTunnel::host_key`] so the caller can
/// persist it. If it is present and differs, the connection is aborted with a
/// clear "SSH server key changed" error.
pub async fn open_tunnel(
    cfg: &SshConfig,
    target_host: &str,
    target_port: u16,
    secret: Option<&str>,
) -> AppResult<SshTunnel> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| AppError::Config(format!("SSH tunnel: cannot bind a local port: {error}")))?;
    let local_port = listener
        .local_addr()
        .map_err(|error| AppError::Config(format!("SSH tunnel: local port: {error}")))?
        .port();

    let state = Arc::new(Mutex::new(HostKeyState::default()));
    let handler = ClientHandler {
        expected: cfg.host_key.clone(),
        state: state.clone(),
    };

    let config = Arc::new(client::Config::default());
    let mut session = match client::connect(config, (cfg.host.as_str(), cfg.port), handler).await {
        Ok(session) => session,
        Err(error) => {
            let mismatch = state
                .lock()
                .map(|state| state.mismatch)
                .unwrap_or(false);
            if mismatch {
                return Err(AppError::Config(
                    "SSH server key changed — the host may be impersonated. Remove the saved host key only if you trust the new key."
                        .to_string(),
                ));
            }
            return Err(AppError::Config(format!(
                "SSH connection to {}:{} failed: {error}",
                cfg.host, cfg.port
            )));
        }
    };

    if let Err(error) = authenticate(&mut session, cfg, secret).await {
        let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
        return Err(error);
    }

    let host_key = match state
        .lock()
        .ok()
        .and_then(|state| state.fingerprint.clone())
    {
        Some(host_key) => host_key,
        None => {
            let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
            return Err(AppError::Config(
                "SSH: the server key was not verified".to_string(),
            ));
        }
    };

    let session = Arc::new(session);
    let target_host = target_host.to_string();
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let task_session = session.clone();

    let task = tokio::spawn(async move {
        let mut connections = JoinSet::new();

        loop {
            while connections.try_join_next().is_some() {}

            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((mut local, _)) => {
                            let session = task_session.clone();
                            let target_host = target_host.clone();
                            connections.spawn(async move {
                                match session
                                    .channel_open_direct_tcpip(
                                        target_host,
                                        target_port as u32,
                                        "127.0.0.1",
                                        0,
                                    )
                                    .await
                                {
                                    Ok(channel) => {
                                        let mut stream = channel.into_stream();
                                        let _ = tokio::io::copy_bidirectional(
                                            &mut local,
                                            &mut stream,
                                        )
                                        .await;
                                    }
                                    Err(error) => {
                                        eprintln!("SSH tunnel: channel open failed: {error}");
                                    }
                                }
                            });
                        }
                        Err(error) => {
                            eprintln!("SSH tunnel: accept failed: {error}");
                            break;
                        }
                    }
                }
            }
        }

        // Dropping the JoinSet aborts all in-flight forwarded connections.
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        let _ = task_session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    });

    Ok(SshTunnel {
        local_port,
        host_key,
        shutdown: Some(shutdown_tx),
        task: Some(task),
    })
}

#[cfg(test)]
mod tests {
    use super::{fingerprints_match, normalize_fingerprint, SshAuth, SshConfig, DEFAULT_SSH_PORT};

    #[test]
    fn ssh_config_defaults_the_port_and_host_key() {
        let cfg: SshConfig = serde_json::from_str(
            r#"{
                "host": "bastion.example.com",
                "username": "deploy",
                "auth": "password"
            }"#,
        )
        .expect("valid ssh config");

        assert_eq!(cfg.port, DEFAULT_SSH_PORT);
        assert_eq!(cfg.auth, SshAuth::Password);
        assert!(cfg.key_path.is_none());
        assert!(cfg.host_key.is_none());
    }

    #[test]
    fn ssh_config_parses_key_auth_and_host_key() {
        let cfg: SshConfig = serde_json::from_str(
            r#"{
                "host": "bastion.example.com",
                "port": 2222,
                "username": "deploy",
                "auth": "key",
                "key_path": "~/.ssh/id_ed25519",
                "host_key": "SHA256:abc123"
            }"#,
        )
        .expect("valid ssh config");

        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.auth, SshAuth::Key);
        assert_eq!(cfg.key_path.as_deref(), Some("~/.ssh/id_ed25519"));
        assert_eq!(cfg.host_key.as_deref(), Some("SHA256:abc123"));
    }

    #[test]
    fn fingerprints_accept_an_optional_algorithm_prefix() {
        assert!(fingerprints_match("SHA256:abc123", "abc123"));
        assert!(fingerprints_match("abc123", "SHA256:abc123"));
        assert!(fingerprints_match(" sha256:abc123 ", "SHA256:abc123"));
        assert!(!fingerprints_match("SHA256:abc123", "SHA256:def456"));
    }

    #[test]
    fn host_key_fingerprint_matches_openssh_spelling() {
        // Saved host keys must keep matching after russh upgrades; this is `ssh-keygen -lf` output.
        let key = russh::keys::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMV9icZUwNLXs5+ymonI6d2rtkcQNmCkG2WfZmvKz1Y8",
        )
        .expect("valid public key");
        assert_eq!(
            key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
            "SHA256:Azotq5ZlaNkxuQXufDglUoGRHCpbcUyDsE9F3F3bavU"
        );
    }

    #[test]
    fn fingerprint_normalization_uses_one_spelling() {
        assert_eq!(normalize_fingerprint("abc123"), "SHA256:abc123");
        assert_eq!(normalize_fingerprint("sha256:abc123"), "SHA256:abc123");
        assert_eq!(normalize_fingerprint("SHA256:abc123"), "SHA256:abc123");
    }
}
