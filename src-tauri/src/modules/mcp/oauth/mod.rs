//! OAuth sign-in for remote MCP servers (the MCP authorization specification, revision
//! 2026-07-28), entirely in the backend: the page never sees a token.
//!
//! - A server that answers 401 (or whose protected resource metadata says it is protected)
//!   is "sign in required"; Settings shows it, and only Settings may sign in or out.
//! - Sign-in (`mcp_oauth_sign_in`): discovery (`flow.rs`, `discovery.rs`), a client (the one
//!   the user configured, else one registered dynamically and kept per authorization server),
//!   authorization code with PKCE S256, `state` and `resource`, through the system browser and
//!   a one-shot loopback listener (`callback.rs`); the issuer of the response is checked
//!   (RFC 9207).
//! - Tokens and the registration live in the keychain (`store.rs`), bound to the server URL
//!   they were obtained for. Requests of that server's sessions get `Authorization: Bearer`
//!   here (`bearer`), refreshed before expiry or once on a 401 (`after_unauthorized`); a refresh
//!   the server refuses deletes them and reports sign-in required.
//!
//! Client ID metadata documents are not offered: they need an https document Oarlock would host.

mod callback;
pub mod challenge;
mod discovery;
mod fetch;
mod flow;
#[cfg(test)]
mod live_tests;
mod pkce;
mod probe;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::Notify;

use super::names::{secret_account, OauthItem, SecretKind, OAUTH_CLIENT_SECRET, SECRET_SERVICE};
use super::{http, require_server_id, require_settings, McpState};
use challenge::Challenge;
pub use fetch::Policy;
use flow::{Client, TokenError};
use store::{ClientSource, Registration, TokenSet};

/// Sent to every window when a server's sign-in state changes: `{ serverId }`.
pub const AUTH_EVENT: &str = "oarlock://mcp-auth";
/// How long the browser has to come back.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before the access token expires.
const REFRESH_MARGIN_SECS: u64 = 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// The server answered 401.
    Unauthorized,
    /// It publishes protected resource metadata, so it is protected.
    Metadata,
    /// It asked for more scopes (403 insufficient_scope).
    Scope,
    /// Its tokens could not be refreshed.
    Expired,
}

#[derive(Clone, Debug)]
struct Required {
    url: String,
    reason: Reason,
    challenge: Option<Challenge>,
}

struct Pending {
    server_id: String,
    cancel: Arc<Notify>,
    saving: bool,
}

/// Sign-in state the backend keeps in memory; the records themselves are in the keychain.
#[derive(Default)]
pub struct OAuthState {
    /// Token records read so far (None: known to have none).
    tokens: Mutex<HashMap<String, Option<Arc<TokenSet>>>>,
    probes: probe::Probes,
    /// One refresh at a time per server.
    refreshing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    required: Mutex<HashMap<String, Required>>,
    pending: Mutex<Option<Pending>>,
}

fn state(app: &AppHandle) -> &OAuthState {
    &app.state::<McpState>().inner().oauth
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuthEvent<'a> {
    server_id: &'a str,
}

fn announce(app: &AppHandle, server_id: &str) {
    let _ = app.emit(AUTH_EVENT, AuthEvent { server_id });
}

/// The token record of a server, read from the keychain once.
async fn tokens(app: &AppHandle, server_id: &str) -> Option<Arc<TokenSet>> {
    let key = store::account(app, server_id, OauthItem::Tokens).ok()?;
    if let Some(cached) = lock(&state(app).tokens).get(&key) {
        return cached.clone();
    }
    let read = store::read_account::<TokenSet>(app, key.clone(), server_id).await;
    accept_token_read(
        &state(app).tokens,
        key,
        || store::account(app, server_id, OauthItem::Tokens).ok(),
        read,
    )
    .unwrap_or_else(|error| {
        log::warn!("mcp: could not read the sign-in of {server_id}: {error}");
        None
    })
}

fn accept_token_read(
    cache: &Mutex<HashMap<String, Option<Arc<TokenSet>>>>,
    key: String,
    current_key: impl FnOnce() -> Option<String>,
    read: Result<Option<TokenSet>, String>,
) -> Result<Option<Arc<TokenSet>>, String> {
    // Hold the cache lock through the version check and insertion: publication
    // either changes the version first or purges this entry after we release it.
    let mut cached = lock(cache);
    if current_key().as_ref() != Some(&key) {
        return Ok(None);
    }
    // A sign-in or sign-out completed while this read was pending.
    if let Some(current) = cached.get(&key) {
        return Ok(current.clone());
    }
    // A locked/unavailable keychain is not proof that the user has no sign-in.
    let read = read?.map(Arc::new);
    cached.insert(key, read.clone());
    Ok(read)
}

/// The tokens of `server_id` when they were obtained for `url`, the server as configured now.
async fn bound_tokens(app: &AppHandle, server_id: &str, url: &str) -> Option<Arc<TokenSet>> {
    tokens(app, server_id).await.filter(|t| t.server_url == url)
}

async fn save_tokens(
    app: &AppHandle,
    server_id: &str,
    tokens: TokenSet,
) -> Result<Arc<TokenSet>, String> {
    store::write(app, server_id, OauthItem::Tokens, &tokens).await?;
    let tokens = Arc::new(tokens);
    lock(&state(app).tokens).insert(
        store::account(app, server_id, OauthItem::Tokens)?,
        Some(tokens.clone()),
    );
    Ok(tokens)
}

async fn forget_cached_tokens(
    cache: &Mutex<HashMap<String, Option<Arc<TokenSet>>>>,
    key: String,
    delete: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    delete.await?;
    lock(cache).insert(key, None);
    Ok(())
}

async fn forget_tokens(app: &AppHandle, server_id: &str) -> Result<(), String> {
    let key = store::account(app, server_id, OauthItem::Tokens)?;
    forget_cached_tokens(
        &state(app).tokens,
        key,
        store::delete(app, server_id, OauthItem::Tokens),
    )
    .await
}

pub(super) fn refresh_lock(app: &AppHandle, server_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    credential_lock(state(app), server_id)
}

fn credential_lock(state: &OAuthState, server_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    lock(&state.refreshing)
        .entry(server_id.to_owned())
        .or_default()
        .clone()
}

/// Marks a server as needing sign-in; tells Settings when that is news.
pub fn note_required(
    app: &AppHandle,
    server_id: &str,
    url: &str,
    reason: Reason,
    challenge: Option<Challenge>,
) {
    let changed = {
        let mut required = lock(&state(app).required);
        let next = Required {
            url: url.to_owned(),
            reason,
            challenge,
        };
        let changed = required
            .get(server_id)
            .is_none_or(|old| old.reason != next.reason || old.url != next.url);
        required.insert(server_id.to_owned(), next);
        changed
    };
    if changed {
        announce(app, server_id);
    }
}

fn clear_required(app: &AppHandle, server_id: &str) {
    lock(&state(app).required).remove(server_id);
}

/// The client the tokens were obtained with, its secret read again.
async fn client_of(app: &AppHandle, server_id: &str, tokens: &TokenSet) -> Result<Client, String> {
    let secret = match (tokens.client_auth, tokens.client_source) {
        (store::ClientAuth::None, _) => None,
        (_, ClientSource::Registered) => {
            store::read::<Registration>(app, server_id, OauthItem::Client)
                .await?
                .and_then(|r| r.client_secret)
        }
        (_, ClientSource::Configured) => configured_secret(app, server_id).await?,
    };
    Ok(Client {
        id: tokens.client_id.clone(),
        secret,
        auth: tokens.client_auth,
        source: tokens.client_source,
    })
}

async fn configured_secret(app: &AppHandle, server_id: &str) -> Result<Option<String>, String> {
    let account = super::credentials::account(
        app,
        server_id,
        secret_account(server_id, SecretKind::Oauth, OAUTH_CLIENT_SECRET)?,
    )?;
    Ok(
        crate::modules::secrets::backend_get(app.clone(), SECRET_SERVICE, vec![account])
            .await?
            .pop()
            .flatten()
            .filter(|s| !s.is_empty()),
    )
}

fn renewed(old: &TokenSet, granted: flow::Granted, now: u64) -> TokenSet {
    TokenSet {
        access_token: granted.access_token,
        // A server that does not rotate keeps the old one valid.
        refresh_token: granted.refresh_token.or_else(|| old.refresh_token.clone()),
        expires_at: granted.expires_in.map(|s| now.saturating_add(s)),
        scope: granted.scope.or_else(|| old.scope.clone()),
        obtained_at: now,
        ..old.clone()
    }
}

/// Refreshes `current`. A refusal deletes the tokens; any failure reports sign-in required.
async fn refresh(
    app: &AppHandle,
    server_id: &str,
    policy: &Policy,
    current: &TokenSet,
) -> Option<Arc<TokenSet>> {
    let refresh_token = current.refresh_token.as_deref()?;
    let client = match client_of(app, server_id, current).await {
        Ok(client) => client,
        Err(error) => {
            log::warn!("mcp: cannot refresh {server_id}: {error}");
            return None;
        }
    };
    match flow::refresh(
        policy,
        &current.token_endpoint,
        &client,
        refresh_token,
        &current.resource,
    )
    .await
    {
        Ok(granted) => {
            match save_tokens(app, server_id, renewed(current, granted, now_secs())).await {
                Ok(tokens) => Some(tokens),
                Err(error) => {
                    log::warn!("mcp: could not keep the refreshed tokens of {server_id}: {error}");
                    None
                }
            }
        }
        Err(TokenError::Rejected(message)) => {
            log::info!("mcp: {server_id} sign-in expired: {message}");
            if let Err(error) = forget_tokens(app, server_id).await {
                log::warn!("mcp: could not remove expired tokens of {server_id}: {error}");
                // A token the server rejected must not be retried in this process,
                // even if the keychain is temporarily unavailable.
                if let Ok(key) = store::account(app, server_id, OauthItem::Tokens) {
                    lock(&state(app).tokens).insert(key, None);
                }
            }
            note_required(app, server_id, &current.server_url, Reason::Expired, None);
            None
        }
        Err(TokenError::Failed(message)) => {
            log::warn!("mcp: could not refresh {server_id}: {message}");
            None
        }
    }
}

/// The access token for a request of `server_id`'s session at `url`, refreshed first when it
/// is about to expire. None when the user has not signed in for this URL.
pub async fn bearer(
    app: &AppHandle,
    server_id: &str,
    url: &Url,
    policy: &Policy,
    revision: Option<u64>,
) -> Option<String> {
    let guard = refresh_lock(app, server_id);
    let _held = guard.lock().await;
    if revision.is_some_and(|revision| {
        super::credentials::check_revision(app, server_id, revision).is_err()
    }) {
        return None;
    }
    let current = bound_tokens(app, server_id, url.as_str()).await?;
    let due = current
        .expires_at
        .is_some_and(|at| at <= now_secs() + REFRESH_MARGIN_SECS);
    if !due || current.refresh_token.is_none() {
        return Some(current.access_token.clone());
    }
    match refresh(app, server_id, policy, &current).await {
        Some(fresh) => Some(fresh.access_token.clone()),
        None => bound_tokens(app, server_id, url.as_str())
            .await
            .map(|t| t.access_token.clone()),
    }
}

/// What a 401 means for a session.
#[derive(Debug, PartialEq, Eq)]
pub enum Unauthorized {
    /// Send the request again, once, with this token (a refreshed one).
    Retry(String),
    /// The user has to sign in; reported to Settings.
    SignIn,
    /// Not about sign-in: no token was sent and the server asked for none
    /// (a wrong API key, say).
    Other,
}

/// A request sent with `sent` (or no token) was answered 401 with `challenge` (its `Bearer`
/// challenge, if any).
#[allow(clippy::too_many_arguments)]
pub async fn after_unauthorized(
    app: &AppHandle,
    server_id: &str,
    url: &Url,
    policy: &Policy,
    sent: Option<&str>,
    challenge: Option<Challenge>,
    revision: Option<u64>,
) -> Unauthorized {
    let guard = refresh_lock(app, server_id);
    let _held = guard.lock().await;
    if revision.is_some_and(|revision| {
        super::credentials::check_revision(app, server_id, revision).is_err()
    }) {
        return Unauthorized::Other;
    }
    let retry = match sent {
        None if challenge.is_none() => return Unauthorized::Other,
        None => None,
        Some(sent) => match bound_tokens(app, server_id, url.as_str()).await {
            Some(latest) if latest.access_token != sent => Some(latest.access_token.clone()),
            Some(latest) => refresh(app, server_id, policy, &latest)
                .await
                .map(|fresh| fresh.access_token.clone()),
            None => None,
        },
    };
    match retry {
        Some(token) => Unauthorized::Retry(token),
        None => {
            note_required(
                app,
                server_id,
                url.as_str(),
                Reason::Unauthorized,
                challenge,
            );
            Unauthorized::SignIn
        }
    }
}

/// The response header that tells the page's client the server needs sign-in (the backend has
/// tried refreshing by then), so it waits for the user instead of reconnecting.
pub const SIGN_IN_HEADER: &str = "x-oarlock-sign-in";

// ---- Status ----

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AuthState {
    SignedIn,
    Required,
    None,
}

/// A server's sign-in as Settings shows it. Never a token or a secret.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub server_id: String,
    pub state: AuthState,
    pub reason: Option<Reason>,
    /// The scopes the server asked for, when it asked.
    pub required_scope: Option<String>,
    pub scope: Option<String>,
    pub issuer: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub expires_at_ms: Option<u64>,
    pub can_refresh: bool,
    pub signing_in: bool,
    pub saving: bool,
}

fn status_of(
    server_id: &str,
    url: &str,
    tokens: Option<&TokenSet>,
    required: Option<&Required>,
    signing_in: bool,
) -> AuthStatus {
    let tokens = tokens.filter(|t| t.server_url == url);
    let required = required.filter(|r| r.url == url);
    let state = match (tokens, required) {
        (_, Some(_)) => AuthState::Required,
        (Some(_), None) => AuthState::SignedIn,
        (None, None) => AuthState::None,
    };
    AuthStatus {
        server_id: server_id.to_owned(),
        state,
        reason: required.map(|r| r.reason),
        required_scope: required.and_then(|r| r.challenge.as_ref()?.scope.clone()),
        scope: tokens.and_then(|t| t.scope.clone()),
        issuer: tokens.map(|t| t.issuer.clone()),
        expires_at_ms: tokens
            .and_then(|t| t.expires_at)
            .map(|s| s.saturating_mul(1000)),
        can_refresh: tokens.is_some_and(|t| t.refresh_token.is_some()),
        signing_in,
        saving: false,
    }
}

async fn status(app: &AppHandle, server_id: &str, url: &str) -> AuthStatus {
    // A cold keychain read would queue behind the write and hide the saving phase.
    if lock(&state(app).pending)
        .as_ref()
        .is_some_and(|p| p.server_id == server_id && p.saving)
    {
        let mut status = status_of(server_id, url, None, None, true);
        status.saving = true;
        return status;
    }
    let tokens = tokens(app, server_id).await;
    let required = lock(&state(app).required).get(server_id).cloned();
    let pending = lock(&state(app).pending);
    let pending = pending.as_ref().filter(|p| p.server_id == server_id);
    let mut status = status_of(
        server_id,
        url,
        tokens.as_deref(),
        required.as_ref(),
        pending.is_some(),
    );
    status.saving = pending.is_some_and(|p| p.saving);
    status
}

/// The server URL a sign-in command acts on: a project server's comes from its trusted
/// `.mcp.json` (expanded), never from the page.
async fn server_url(
    app: &AppHandle,
    server_id: &str,
    page_url: &str,
    shell: Option<String>,
) -> Result<Url, String> {
    if super::project::is_project_server(server_id) {
        let app = app.clone();
        let id = server_id.to_owned();
        return crate::modules::fs::blocking(move || super::project::server_url(&app, &id, shell))
            .await;
    }
    http::parse_server_url(page_url)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRef {
    server_id: String,
    url: String,
}

/// The sign-in state of each server, for Settings.
#[tauri::command]
pub async fn mcp_oauth_status(
    app: AppHandle,
    window: WebviewWindow,
    servers: Vec<ServerRef>,
    shell: Option<String>,
) -> Result<Vec<AuthStatus>, String> {
    require_settings(&window)?;
    let mut out = Vec::with_capacity(servers.len());
    for server in servers.into_iter().take(256) {
        require_server_id(&server.server_id)?;
        let url = match server_url(&app, &server.server_id, &server.url, shell.clone()).await {
            Ok(url) => url.to_string(),
            Err(_) => server.url,
        };
        out.push(status(&app, &server.server_id, &url).await);
    }
    Ok(out)
}

/// Automatic metadata discovery acknowledges admission before doing async work.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInput {
    server_id: String,
    url: String,
    shell: Option<String>,
    revision: Option<u64>,
}

#[tauri::command]
pub fn mcp_oauth_probe(
    app: AppHandle,
    window: WebviewWindow,
    page_generation: String,
    request_id: String,
    input: ProbeInput,
    on_event: tauri::ipc::Channel<Result<AuthStatus, String>>,
) -> Result<(), String> {
    require_settings(&window)?;
    require_server_id(&input.server_id)?;
    let pages = app.state::<crate::modules::net::page::NetworkPages>();
    let (lease, registration) = pages.with_page(window.label(), &page_generation, || {
        state(&app)
            .probes
            .admit(window.label(), &request_id, &input.server_id)
    })?;
    tauri::async_runtime::spawn(async move {
        let result = futures_util::future::Abortable::new(
            discover_metadata(app, input, &lease),
            registration,
        )
        .await
        .unwrap_or_else(|_| Err("Metadata discovery cancelled".into()));
        drop(lease);
        let _ = on_event.send(result);
    });
    Ok(())
}

#[tauri::command]
pub fn mcp_oauth_probe_cancel(
    app: AppHandle,
    window: WebviewWindow,
    page_generation: String,
    request_id: String,
) -> Result<(), String> {
    require_settings(&window)?;
    app.state::<crate::modules::net::page::NetworkPages>()
        .with_page(window.label(), &page_generation, || {
            state(&app).probes.cancel(window.label(), &request_id);
            Ok(())
        })
}

pub(crate) fn cancel_probe_window(app: &AppHandle, window: &str) {
    if let Some(mcp) = app.try_state::<McpState>() {
        mcp.oauth.probes.cancel_window(window);
    }
}
pub(super) fn cancel_probe_server(app: &AppHandle, server: &str) {
    state(app).probes.cancel_server(server);
}

fn validate_discovery(
    app: &AppHandle,
    id: &str,
    url: &Url,
    revision: Option<u64>,
) -> Result<String, String> {
    if super::project::is_project_server(id) {
        let hash = super::project::settings_entry_hash(app, id)
            .ok_or("Project metadata discovery is no longer authorized")?;
        let records = super::settings::store(app)?
            .get("projectServers")
            .unwrap_or_default();
        let record = &records[id];
        if record["entryHash"] == hash && record["enabled"] == false {
            return Err("MCP server is disabled".into());
        }
        Ok(hash)
    } else {
        let saved = super::credentials::server(app, id)?;
        validate_global_discovery(&saved, url, revision)
    }
}

fn validate_global_discovery(
    saved: &serde_json::Value,
    url: &Url,
    revision: Option<u64>,
) -> Result<String, String> {
    if saved["enabled"] != true {
        return Err("MCP server is disabled".into());
    }
    if revision != Some(saved["secretsRevision"].as_u64().unwrap_or(0)) {
        return Err("MCP server credentials changed; reopen settings".into());
    }
    if saved["transport"]["url"]
        .as_str()
        .and_then(|s| Url::parse(s).ok())
        .as_ref()
        != Some(url)
    {
        return Err("MCP server URL changed; reopen settings".into());
    }
    Ok(serde_json::json!([
        saved["transport"],
        saved["secretsRevision"],
        saved["credentialVersion"]
    ])
    .to_string())
}

async fn discover_metadata(
    app: AppHandle,
    input: ProbeInput,
    lease: &probe::Lease,
) -> Result<AuthStatus, String> {
    let ProbeInput {
        server_id,
        url,
        shell,
        revision,
    } = input;
    let url = server_url(&app, &server_id, &url, shell).await?;
    let binding = validate_discovery(&app, &server_id, &url, revision)?;
    let key = store::account(&app, &server_id, OauthItem::Tokens)?;
    let known = bound_tokens(&app, &server_id, url.as_str()).await.is_some()
        || lock(&state(&app).required)
            .get(&server_id)
            .is_some_and(|r| r.url == url.as_str());
    if !known {
        if lock(&state(&app).pending)
            .as_ref()
            .is_some_and(|pending| pending.server_id == server_id)
        {
            return Err("Sign-in is already in progress; retry discovery after it finishes".into());
        }
        let host = url.host_str().ok_or("mcp: the URL has no host")?;
        let policy = Policy::for_server(&url, crate::modules::net::host_is_private(host).await?);
        if flow::resource_metadata(&policy, &url, None)
            .await?
            .is_some()
        {
            let mcp = app.state::<McpState>();
            if validate_discovery(&app, &server_id, &url, revision)? != binding {
                return Err("MCP server changed during discovery".into());
            }
            let _settings = mcp.settings.lock().await;
            let guard = refresh_lock(&app, &server_id);
            let _held = guard.lock().await;
            // Discovery may have overlapped sign-in or a configuration edit. Never
            // turn successful authentication back into a request to sign in.
            if metadata_probe_is_current(
                state(&app),
                &server_id,
                url.as_str(),
                &key,
                store::account(&app, &server_id, OauthItem::Tokens)
                    .ok()
                    .as_deref(),
            ) {
                lease.publish(|| {
                    note_required(&app, &server_id, url.as_str(), Reason::Metadata, None)
                })?;
            }
        }
    }
    Ok(status(&app, &server_id, url.as_str()).await)
}

/// Called under the credential lock, immediately before publishing discovery.
fn metadata_probe_is_current(
    state: &OAuthState,
    server_id: &str,
    url: &str,
    key: &str,
    current_key: Option<&str>,
) -> bool {
    current_key == Some(key)
        // No cache entry means the keychain read failed, not that it has no token.
        && lock(&state.tokens).get(key).is_some_and(|tokens| {
            tokens.as_ref().is_none_or(|tokens| tokens.server_url != url)
        })
        && !lock(&state.pending).as_ref().is_some_and(|p| p.server_id == server_id)
}

/// A client the user configured for a server.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientInput {
    client_id: Option<String>,
    /// Its secret is in the keychain (`<server>/oauth/client-secret`).
    #[serde(default)]
    has_secret: bool,
    scopes: Option<String>,
    callback_port: Option<u16>,
}

fn port_of(redirect_uri: &str) -> Option<u16> {
    Url::parse(redirect_uri).ok()?.port()
}

/// Everything up to the browser: discovery, the client, the listener and the URL to open.
struct Prepared {
    discovered: flow::Discovered,
    client: Client,
    listener: callback::Listener,
    scope: Option<String>,
    verifier: String,
    state: String,
    authorization_url: Url,
}

async fn prepare(
    app: &AppHandle,
    server_id: &str,
    server: &Url,
    policy: &Policy,
    input: &ClientInput,
    cancel: &Notify,
) -> Result<Prepared, String> {
    let required = lock(&state(app).required).get(server_id).cloned();
    let challenge = required
        .filter(|r| r.url == server.as_str())
        .and_then(|r| r.challenge);
    let previous = bound_tokens(app, server_id, server.as_str()).await;
    let discovered = flow::discover(policy, server, challenge.as_ref()).await?;
    let auth = &discovered.auth;
    let scope = discovery::select_scope(
        input.scopes.as_deref(),
        challenge.as_ref().and_then(|c| c.scope.as_deref()),
        previous.as_ref().and_then(|t| t.scope.as_deref()),
        discovered
            .resource_metadata
            .as_ref()
            .map_or(&[][..], |prm| &prm.scopes_supported),
        &auth.scopes_supported,
    );
    let bind = |port: u16| async move {
        callback::Listener::bind(port).await.map_err(|e| {
            format!("could not listen for the sign-in response on 127.0.0.1:{port}: {e}")
        })
    };
    let configured = input
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let (listener, client) = match configured {
        Some(id) => {
            let listener = bind(input.callback_port.unwrap_or(0)).await?;
            let secret = if input.has_secret {
                configured_secret(app, server_id).await?
            } else {
                None
            };
            let client = Client {
                id: id.to_owned(),
                auth: flow::configured_auth(secret.is_some(), &auth.token_endpoint_auth_methods),
                secret,
                source: ClientSource::Configured,
            };
            (listener, client)
        }
        None => {
            let stored = store::read::<Registration>(app, server_id, OauthItem::Client)
                .await?
                .filter(|r| r.issuer == auth.issuer);
            // The port it was registered with, so its redirect URI still matches.
            let mut listener = None;
            if let Some(port) = stored.as_ref().and_then(|r| port_of(&r.redirect_uri)) {
                listener = callback::Listener::bind(port).await.ok();
            }
            let listener = match listener {
                Some(listener) => listener,
                None => bind(input.callback_port.unwrap_or(0)).await?,
            };
            let redirect_uri = listener.redirect_uri();
            let registration = match stored
                .filter(|r| r.usable(&auth.issuer, &redirect_uri, now_secs()))
            {
                Some(registration) => registration,
                None => {
                    let registration =
                        flow::register(policy, auth, &redirect_uri, scope.as_deref(), now_secs())
                            .await?;
                    if !lock(&state(app).pending)
                        .as_ref()
                        .is_some_and(|p| std::ptr::eq(p.cancel.as_ref(), cancel))
                    {
                        return Err("sign-in was cancelled".into());
                    }
                    store::write(app, server_id, OauthItem::Client, &registration).await?;
                    registration
                }
            };
            (listener, Client::from(registration))
        }
    };
    let (verifier, code_challenge) = pkce::new_pair()?;
    let state = pkce::random_token(32)?;
    let authorization_url = flow::authorization_url(
        auth,
        &client.id,
        &listener.redirect_uri(),
        &code_challenge,
        &state,
        scope.as_deref(),
        &discovered.resource,
    )?;
    Ok(Prepared {
        discovered,
        client,
        listener,
        scope,
        verifier,
        state,
        authorization_url,
    })
}

/// What the browser came back with: the tokens, or why not.
async fn finish(
    server: &Url,
    policy: &Policy,
    prepared: &Prepared,
    params: &HashMap<String, String>,
) -> Result<TokenSet, String> {
    let auth = &prepared.discovered.auth;
    discovery::check_response_issuer(
        &auth.issuer,
        params.get("iss").map(String::as_str),
        auth.iss_parameter_supported,
    )?;
    if let Some(error) = params.get("error") {
        let description = params
            .get("error_description")
            .map(|d| format!(" ({})", flow::clean(d)))
            .unwrap_or_default();
        return Err(format!(
            "the authorization server did not sign you in: {}{description}",
            flow::clean(error)
        ));
    }
    let code = params
        .get("code")
        .filter(|c| !c.is_empty())
        .ok_or("the sign-in response has no authorization code")?;
    let granted = flow::exchange_code(
        policy,
        &auth.token_endpoint,
        &prepared.client,
        code,
        &prepared.verifier,
        &prepared.listener.redirect_uri(),
        &prepared.discovered.resource,
    )
    .await
    .map_err(|e| e.message().to_owned())?;
    let now = now_secs();
    Ok(TokenSet {
        access_token: granted.access_token,
        refresh_token: granted.refresh_token,
        expires_at: granted.expires_in.map(|s| now.saturating_add(s)),
        scope: granted.scope.or_else(|| prepared.scope.clone()),
        server_url: server.to_string(),
        resource: prepared.discovered.resource.clone(),
        issuer: auth.issuer.clone(),
        token_endpoint: auth.token_endpoint.clone(),
        client_id: prepared.client.id.clone(),
        client_auth: prepared.client.auth,
        client_source: prepared.client.source,
        obtained_at: now,
    })
}

async fn open_browser(app: &AppHandle, url: &Url) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let app = app.clone();
    let url = url.to_string();
    crate::modules::fs::blocking(move || {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("could not open your browser: {e}"))
    })
    .await
}

#[allow(clippy::too_many_arguments)]
async fn sign_in(
    app: &AppHandle,
    server_id: &str,
    server: &Url,
    input: &ClientInput,
    cancel: &Notify,
    revision: Option<u64>,
) -> Result<(TokenSet, tokio::net::TcpStream), String> {
    let host = server.host_str().ok_or("mcp: the URL has no host")?;
    let policy = Policy::for_server(server, crate::modules::net::host_is_private(host).await?);
    let prepared = {
        let guard = refresh_lock(app, server_id);
        let _held = guard.lock().await;
        let configured;
        let input = if !super::project::is_project_server(server_id) {
            let saved = super::credentials::launch(
                app,
                server_id,
                revision.ok_or("mcp: missing configuration revision")?,
            )?;
            if saved["transport"]["url"]
                .as_str()
                .and_then(|url| Url::parse(url).ok())
                .as_ref()
                != Some(server)
            {
                return Err("mcp: server URL changed; reopen settings".into());
            }
            let oauth = &saved["transport"]["oauth"];
            configured = ClientInput {
                client_id: oauth["clientId"].as_str().map(str::to_owned),
                has_secret: oauth["clientSecret"] == true,
                scopes: oauth["scopes"].as_str().map(str::to_owned),
                callback_port: oauth["callbackPort"].as_u64().map(|p| p as u16),
            };
            &configured
        } else {
            input
        };
        prepare(app, server_id, server, &policy, input, cancel).await?
    };
    if !lock(&state(app).pending)
        .as_ref()
        .is_some_and(|p| std::ptr::eq(p.cancel.as_ref(), cancel))
    {
        return Err("sign-in was cancelled".into());
    }
    open_browser(app, &prepared.authorization_url).await?;
    let waited = tokio::select! {
        got = prepared.listener.wait(&prepared.state) => Ok(got),
        () = cancel.notified() => Err("sign-in was cancelled"),
        () = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err("sign-in timed out; start it again"),
    };
    let (params, mut stream) = waited.map_err(str::to_owned)?;
    match finish(server, &policy, &prepared, &params).await {
        Ok(tokens) => Ok((tokens, stream)),
        Err(error) => {
            report_sign_in(&mut stream, &Err(error.clone())).await;
            Err(error)
        }
    }
}

/// Signs in to a server: opens the system browser and waits (up to five minutes) for the
/// authorization server to send it back. The settings window only.
#[tauri::command]
pub async fn mcp_oauth_sign_in(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
    url: String,
    client: Option<ClientInput>,
    revision: Option<u64>,
    shell: Option<String>,
) -> Result<AuthStatus, String> {
    require_settings(&window)?;
    require_server_id(&server_id)?;
    cancel_probe_server(&app, &server_id);
    let server = server_url(&app, &server_id, &url, shell).await?;
    let input = client.unwrap_or_default();
    let cancel = Arc::new(Notify::new());
    if let Some(previous) = start_pending(state(&app), &server_id, cancel.clone())? {
        announce(&app, &previous);
    }
    announce(&app, &server_id);
    let result = sign_in(&app, &server_id, &server, &input, &cancel, revision).await;
    let mut response = None;
    let outcome = match result {
        Ok((tokens, stream)) => {
            response = Some(stream);
            let guard = refresh_lock(&app, &server_id);
            let _held = guard.lock().await;
            commit_sign_in(state(&app), &cancel, || announce(&app, &server_id), async {
                save_tokens(&app, &server_id, tokens).await.map(|_| {
                    clear_required(&app, &server_id);
                })
            })
            .await
        }
        Err(error) => Err(error),
    };
    finish_pending(state(&app), &cancel);
    announce(&app, &server_id);
    if let Some(mut stream) = response {
        report_sign_in(&mut stream, &outcome).await;
    }
    outcome.map_err(|e| format!("mcp: {e}"))?;
    Ok(status(&app, &server_id, server.as_str()).await)
}

#[tauri::command]
pub fn mcp_oauth_cancel(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
) -> Result<(), String> {
    require_settings(&window)?;
    cancel_pending(state(&app), &server_id)?;
    announce(&app, &server_id);
    Ok(())
}

/// Deletes the server's tokens and its registration. The settings window only.
#[tauri::command]
pub async fn mcp_oauth_sign_out(
    app: AppHandle,
    window: WebviewWindow,
    server_id: String,
) -> Result<(), String> {
    require_settings(&window)?;
    require_server_id(&server_id)?;
    forget(&app, &server_id).await
}

/// The pending mutex is the commit boundary: cancellation and saving cannot both win.
fn start_pending(
    state: &OAuthState,
    server_id: &str,
    cancel: Arc<Notify>,
) -> Result<Option<String>, String> {
    let mut pending = lock(&state.pending);
    if pending.as_ref().is_some_and(|p| p.saving) {
        return Err("mcp: saving sign-in; wait for it to finish".into());
    }
    Ok(pending
        .replace(Pending {
            server_id: server_id.into(),
            cancel,
            saving: false,
        })
        .map(|previous| {
            previous.cancel.notify_one();
            previous.server_id
        }))
}

fn begin_saving(state: &OAuthState, cancel: &Arc<Notify>) -> Result<(), String> {
    let mut pending = lock(&state.pending);
    let current = pending
        .as_mut()
        .filter(|p| Arc::ptr_eq(&p.cancel, cancel))
        .ok_or("sign-in was cancelled")?;
    current.saving = true;
    Ok(())
}

fn finish_pending(state: &OAuthState, cancel: &Arc<Notify>) {
    let mut pending = lock(&state.pending);
    if pending
        .as_ref()
        .is_some_and(|p| Arc::ptr_eq(&p.cancel, cancel))
    {
        *pending = None;
    }
}

async fn commit_sign_in(
    state: &OAuthState,
    cancel: &Arc<Notify>,
    announce_saving: impl FnOnce(),
    save: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    begin_saving(state, cancel)?;
    announce_saving();
    let result = save.await;
    finish_pending(state, cancel);
    result
}

fn cancel_pending(state: &OAuthState, server_id: &str) -> Result<(), String> {
    let mut pending = lock(&state.pending);
    if pending.as_ref().is_some_and(|p| p.server_id == server_id) {
        if pending.as_ref().is_some_and(|p| p.saving) {
            return Err("mcp: saving sign-in; wait for it to finish".into());
        }
        if let Some(pending) = pending.take() {
            pending.cancel.notify_one();
        }
    }
    Ok(())
}

async fn report_sign_in(stream: &mut tokio::net::TcpStream, result: &Result<(), String>) {
    let page = match result {
        Ok(()) => callback::page(
            "Signed in",
            "Oarlock is signed in to the server. You can close this tab.",
        ),
        Err(error) => callback::page(
            "Sign-in failed",
            &format!("{error}. You can close this tab and try again from Oarlock's Settings."),
        ),
    };
    // A browser that stopped reading must not hold the IPC action open indefinitely.
    let _ = tokio::time::timeout(
        Duration::from_secs(10),
        callback::respond(stream, 200, &page),
    )
    .await;
}

/// Called with the credential lock held, only after the new configuration is saved.
/// Old disk records are unreachable through the new version even if cleanup fails.
pub(super) fn configuration_changed(app: &AppHandle, server_id: &str) {
    cancel_probe_server(app, server_id);
    let _ = cancel_pending(state(app), server_id);
    let prefix = format!("{server_id}/");
    lock(&state(app).tokens).retain(|key, _| !key.starts_with(&prefix));
    clear_required(app, server_id);
    announce(app, server_id);
}

/// Forgets everything sign-in kept for a server (sign out, or the server was removed).
pub async fn forget(app: &AppHandle, server_id: &str) -> Result<(), String> {
    cancel_probe_server(app, server_id);
    let _ = cancel_pending(state(app), server_id);
    let guard = refresh_lock(app, server_id);
    let _held = guard.lock().await;
    forget_tokens(app, server_id).await?;
    let cleanup = store::delete(app, server_id, OauthItem::Client).await;
    // The tokens are already gone even if registration cleanup failed. Publish
    // that committed state instead of leaving Settings labelled "Signed in".
    clear_required(app, server_id);
    announce(app, server_id);
    cleanup
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_rejects_disabled_or_stale_saved_server_context() {
        let url = Url::parse("https://example.com/mcp").unwrap();
        let mut saved = serde_json::json!({"enabled":true,"secretsRevision":2,"transport":{"type":"http","url":url.as_str()}});
        assert!(validate_global_discovery(&saved, &url, Some(2)).is_ok());
        assert!(validate_global_discovery(&saved, &url, Some(1)).is_err());
        assert!(validate_global_discovery(&saved, &url, None).is_err());
        assert!(validate_global_discovery(
            &saved,
            &Url::parse("https://other.example/mcp").unwrap(),
            Some(2)
        )
        .is_err());
        saved["enabled"] = serde_json::json!(false);
        assert!(validate_global_discovery(&saved, &url, Some(2)).is_err());
    }

    #[test]
    fn late_metadata_cannot_undo_sign_in_or_relabel_another_configuration() {
        let state = OAuthState::default();
        let url = "https://example.com/mcp";
        let key = "server/oauth/tokens@version";
        // An unavailable keychain is not evidence that sign-in is required.
        assert!(!metadata_probe_is_current(
            &state,
            "server",
            url,
            key,
            Some(key)
        ));
        lock(&state.tokens).insert(key.into(), None);
        assert!(metadata_probe_is_current(
            &state,
            "server",
            url,
            key,
            Some(key)
        ));
        assert!(!metadata_probe_is_current(
            &state,
            "server",
            url,
            key,
            Some("new-version")
        ));
        assert!(!metadata_probe_is_current(&state, "server", url, key, None));
        let cancel = Arc::new(Notify::new());
        start_pending(&state, "server", cancel.clone()).unwrap();
        assert!(!metadata_probe_is_current(
            &state,
            "server",
            url,
            key,
            Some(key)
        ));
        begin_saving(&state, &cancel).unwrap();
        assert!(!metadata_probe_is_current(
            &state,
            "server",
            url,
            key,
            Some(key)
        ));
        lock(&state.tokens).insert(key.into(), Some(Arc::new(tokens(url))));
        finish_pending(&state, &cancel);
        assert!(!metadata_probe_is_current(
            &state,
            "server",
            url,
            key,
            Some(key)
        ));
    }

    #[tokio::test]
    async fn saving_is_a_commit_boundary_and_failed_writes_leave_it_retryable() {
        for result in [Ok(()), Err("keychain locked".to_owned())] {
            let state = Arc::new(OAuthState::default());
            let cancel = Arc::new(Notify::new());
            start_pending(&state, "server", cancel.clone()).unwrap();
            let (saving, started) = tokio::sync::oneshot::channel();
            let (finish, wait) = tokio::sync::oneshot::channel();
            let task_state = state.clone();
            let task = tokio::spawn(async move {
                commit_sign_in(
                    &task_state,
                    &cancel,
                    || {
                        let _ = saving.send(());
                    },
                    async { wait.await.unwrap() },
                )
                .await
            });
            started.await.unwrap();
            assert!(lock(&state.pending).as_ref().unwrap().saving);
            assert!(cancel_pending(&state, "server").is_err());
            assert!(start_pending(&state, "other", Arc::new(Notify::new())).is_err());
            assert!(!task.is_finished(), "success must wait for persistence");
            finish.send(result.clone()).unwrap();
            assert_eq!(task.await.unwrap(), result);
            assert!(lock(&state.pending).is_none());
            assert!(start_pending(&state, "server", Arc::new(Notify::new())).is_ok());
        }
    }

    #[tokio::test]
    async fn cancellation_before_commit_never_polls_the_keychain_write() {
        let state = OAuthState::default();
        let cancel = Arc::new(Notify::new());
        start_pending(&state, "server", cancel.clone()).unwrap();
        cancel_pending(&state, "server").unwrap();
        let result = commit_sign_in(
            &state,
            &cancel,
            || panic!("must not announce saving"),
            async { panic!("must not write cancelled tokens") },
        )
        .await;
        assert!(result.unwrap_err().contains("cancelled"));
    }

    #[test]
    fn an_obsolete_completion_does_not_clear_the_replacement_sign_in() {
        let state = OAuthState::default();
        let old = Arc::new(Notify::new());
        let new = Arc::new(Notify::new());
        start_pending(&state, "server", old.clone()).unwrap();
        start_pending(&state, "server", new.clone()).unwrap();
        assert!(begin_saving(&state, &old).is_err());
        finish_pending(&state, &old);
        assert!(begin_saving(&state, &new).is_ok());
    }

    #[tokio::test]
    async fn sign_out_serializes_after_an_in_flight_refresh() {
        let state = OAuthState::default();
        let refresh = credential_lock(&state, "server");
        let sign_out = credential_lock(&state, "server");
        let tokens = Arc::new(Mutex::new(Some("old")));
        let held = refresh.lock_owned().await;
        let saved = tokens.clone();
        let task = tokio::spawn(async move {
            let _held = sign_out.lock().await;
            *lock(&saved) = None;
        });
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        *lock(&tokens) = Some("refreshed");
        drop(held);
        task.await.unwrap();
        assert!(lock(&tokens).is_none());
    }

    #[test]
    fn sign_out_invalidates_a_pending_sign_in_identity() {
        let state = OAuthState::default();
        let cancel = Arc::new(Notify::new());
        *lock(&state.pending) = Some(Pending {
            server_id: "server".into(),
            cancel: cancel.clone(),
            saving: false,
        });
        cancel_pending(&state, "other").unwrap();
        assert!(lock(&state.pending).is_some());
        cancel_pending(&state, "server").unwrap();
        assert!(lock(&state.pending).is_none());
        let replacement = Arc::new(Notify::new());
        *lock(&state.pending) = Some(Pending {
            server_id: "server".into(),
            cancel: replacement,
            saving: false,
        });
        assert!(!lock(&state.pending)
            .as_ref()
            .is_some_and(|p| Arc::ptr_eq(&p.cancel, &cancel)));
    }

    fn tokens(url: &str) -> TokenSet {
        TokenSet {
            access_token: "AT-very-secret".into(),
            refresh_token: Some("RT-very-secret".into()),
            expires_at: Some(1_000),
            scope: Some("read".into()),
            server_url: url.into(),
            resource: url.into(),
            issuer: "https://auth.example.com".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            client_id: "client".into(),
            client_auth: store::ClientAuth::None,
            client_source: ClientSource::Registered,
            obtained_at: 1,
        }
    }

    const URL: &str = "https://mcp.example.com/mcp";

    #[test]
    fn failed_token_reads_remain_retryable_and_retired_versions_stay_uncached() {
        let cache = Mutex::new(HashMap::new());
        let key = "server/oauth/tokens@version".to_owned();
        assert!(accept_token_read(
            &cache,
            key.clone(),
            || Some(key.clone()),
            Err("keychain locked".into())
        )
        .is_err());
        assert!(lock(&cache).is_empty());
        assert!(accept_token_read(
            &cache,
            key.clone(),
            || Some("new version".into()),
            Ok(Some(tokens(URL)))
        )
        .unwrap()
        .is_none());
        assert!(lock(&cache).is_empty());
        assert!(accept_token_read(
            &cache,
            key.clone(),
            || Some(key.clone()),
            Ok(Some(tokens(URL)))
        )
        .unwrap()
        .is_some());
        assert!(lock(&cache).get(&key).unwrap().is_some());
        // A delayed failed read cannot conceal a newer successful sign-in.
        assert!(accept_token_read(
            &cache,
            key.clone(),
            || Some(key.clone()),
            Err("old read failed".into())
        )
        .unwrap()
        .is_some());
        // Nor can a delayed successful read resurrect a confirmed sign-out.
        lock(&cache).insert(key.clone(), None);
        assert!(accept_token_read(
            &cache,
            key.clone(),
            || Some(key.clone()),
            Ok(Some(tokens(URL)))
        )
        .unwrap()
        .is_none());
    }

    #[tokio::test]
    async fn failed_sign_out_preserves_the_cached_sign_in_and_reports_the_failure() {
        let original = Arc::new(tokens(URL));
        let key = "server/oauth/tokens@version".to_owned();
        let cache = Mutex::new(HashMap::from([(key.clone(), Some(original.clone()))]));
        let error =
            forget_cached_tokens(&cache, key.clone(), async { Err("keychain locked".into()) })
                .await;
        assert_eq!(error.unwrap_err(), "keychain locked");
        assert!(Arc::ptr_eq(
            lock(&cache).get(&key).unwrap().as_ref().unwrap(),
            &original
        ));
        assert_eq!(
            status_of(
                "server",
                URL,
                lock(&cache).get(&key).unwrap().as_deref(),
                None,
                false
            )
            .state,
            AuthState::SignedIn
        );
        forget_cached_tokens(&cache, key.clone(), async { Ok(()) })
            .await
            .unwrap();
        assert!(lock(&cache).get(&key).unwrap().is_none());
    }

    #[test]
    fn the_status_the_page_gets_never_carries_a_token() {
        let t = tokens(URL);
        let status = status_of("s1", URL, Some(&t), None, false);
        assert_eq!(status.state, AuthState::SignedIn);
        assert_eq!(status.expires_at_ms, Some(1_000_000));
        assert!(status.can_refresh);
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("AT-very-secret"), "{json}");
        assert!(!json.contains("RT-very-secret"), "{json}");
        assert!(!json.contains("client"), "not even the client id: {json}");
    }

    #[test]
    fn tokens_count_only_for_the_url_they_were_obtained_for() {
        let t = tokens(URL);
        let moved = status_of("s1", "https://other.example.com/mcp", Some(&t), None, false);
        assert_eq!(moved.state, AuthState::None);
        assert_eq!(moved.issuer, None);
    }

    #[test]
    fn a_refusal_or_a_challenge_means_sign_in_required() {
        let t = tokens(URL);
        let required = Required {
            url: URL.into(),
            reason: Reason::Scope,
            challenge: Some(Challenge {
                scope: Some("files:write".into()),
                ..Challenge::default()
            }),
        };
        let status = status_of("s1", URL, Some(&t), Some(&required), true);
        assert_eq!(status.state, AuthState::Required);
        assert_eq!(status.reason, Some(Reason::Scope));
        assert_eq!(status.required_scope.as_deref(), Some("files:write"));
        assert!(status.signing_in);
        // A challenge from the server's previous URL does not count.
        let stale = Required {
            url: "https://old.example.com".into(),
            ..required
        };
        assert_eq!(
            status_of("s1", URL, None, Some(&stale), false).state,
            AuthState::None
        );
    }

    #[test]
    fn a_refresh_keeps_what_the_server_did_not_replace() {
        let old = tokens(URL);
        let fresh = renewed(
            &old,
            flow::Granted {
                access_token: "new".into(),
                refresh_token: None,
                expires_in: Some(100),
                scope: None,
            },
            50,
        );
        assert_eq!(fresh.access_token, "new");
        assert_eq!(fresh.refresh_token, old.refresh_token);
        assert_eq!(fresh.expires_at, Some(150));
        assert_eq!(fresh.scope, old.scope);
        assert_eq!(fresh.server_url, URL);
        let rotated = renewed(
            &old,
            flow::Granted {
                access_token: "new".into(),
                refresh_token: Some("rotated".into()),
                expires_in: None,
                scope: Some("read write".into()),
            },
            50,
        );
        assert_eq!(rotated.refresh_token.as_deref(), Some("rotated"));
        assert_eq!(rotated.expires_at, None);
        assert_eq!(rotated.scope.as_deref(), Some("read write"));
    }

    #[test]
    fn the_page_names_the_same_event_and_marker() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/modules/mcp/lib/auth.ts"),
        )
        .unwrap();
        assert!(source.contains(&format!("MCP_AUTH_EVENT = \"{AUTH_EVENT}\"")));
        assert!(source.contains(&format!("SIGN_IN_HEADER = \"{SIGN_IN_HEADER}\"")));
    }

    #[test]
    fn redirect_ports_are_read_back() {
        assert_eq!(port_of("http://127.0.0.1:5000/callback"), Some(5000));
        assert_eq!(port_of("http://127.0.0.1/callback"), None);
        assert_eq!(port_of("nonsense"), None);
    }
}
