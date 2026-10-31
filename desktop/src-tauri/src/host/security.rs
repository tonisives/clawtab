//! Local trust enrollment and authenticated commands. Relay metadata is never trust.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
};

pub const NOISE: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
const MAX_COMMAND: usize = 512 * 1024;
static STORE_LOCK: LazyLock<parking_lot::Mutex<()>> = LazyLock::new(|| parking_lot::Mutex::new(()));
struct StoreGuard {
    _thread: parking_lot::MutexGuard<'static, ()>,
    _file: std::fs::File,
}
fn file_lock(name: &str) -> Result<std::fs::File, String> {
    let file = crate::local_transport::open_private(
        &directory()?.join(name),
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false),
    )
    .map_err(|_| "Secure storage lock unavailable")?;
    fs2::FileExt::lock_exclusive(&file).map_err(|_| "Secure storage lock unavailable")?;
    Ok(file)
}
fn store_lock() -> Result<StoreGuard, String> {
    let thread = STORE_LOCK.lock();
    Ok(StoreGuard {
        _thread: thread,
        _file: file_lock("trust.lock")?,
    })
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Identity {
    noise_private: String,
    box_private: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MachineKey {
    pub machine_id: String,
    pub noise_key: String,
    pub box_key: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ClientKey {
    pub signing_key: String,
    pub box_key: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Trust {
    enabled: bool,
    clients: BTreeMap<String, ClientKey>,
    machines: BTreeMap<String, MachineKey>,
    replay: BTreeMap<String, i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authorization {
    client: String,
    machine: String,
    expires: i64,
    message: String,
    signature: String,
}
pub struct Authenticated {
    pub client: String,
    pub request_id: String,
    pub message: Value,
}

pub fn decode32(value: &str) -> Result<[u8; 32], String> {
    B64.decode(value)
        .map_err(|_| "Invalid public key")?
        .try_into()
        .map_err(|_| "Invalid public key length".into())
}
pub fn fingerprint(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Invalid identity")?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub fn directory() -> Result<PathBuf, String> {
    let path = crate::config::config_dir()
        .ok_or("Configuration directory unavailable")?
        .join("secure-move");
    crate::local_transport::private_directory(&path)?;
    Ok(path)
}
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let mut file = crate::local_transport::open_private(path, OpenOptions::new().read(true))
        .map_err(|_| "Secure record unavailable")?;
    if file
        .metadata()
        .map_err(|_| "Secure record unavailable")?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("Unsafe secure record".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| "Secure record unavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid secure record".into())
}
pub fn save_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid secure record path")?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut file = crate::local_transport::private_file(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(value).map_err(|_| "Invalid secure record")?)
            .map_err(|_| "Could not save secure record")?;
        file.sync_all()
            .map_err(|_| "Could not persist secure record")?;
        drop(file);
        crate::local_transport::atomic_replace(&temporary, path)
            .map_err(|_| "Could not commit secure record")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    Ok(result?)
}
fn load_trust() -> Result<Trust, String> {
    let path = directory()?.join("trust.json");
    if !path.try_exists().map_err(|_| "Trust storage unavailable")? {
        return Ok(Trust::default());
    }
    read_json(&path)
}
pub fn enabled() -> bool {
    load_trust().map(|t| t.enabled).unwrap_or(true)
}
pub fn machine_id() -> Result<String, String> {
    crate::config::settings::AppSettings::load()
        .relay
        .map(|r| r.device_id)
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("Pair this machine before enabling Secure Move".into())
}

impl Identity {
    fn generate() -> Result<Self, String> {
        let pair = snow::Builder::new(NOISE.parse().map_err(|_| "Invalid secure protocol")?)
            .generate_keypair()
            .map_err(|_| "Secure random generator unavailable")?;
        Ok(Self {
            noise_private: B64.encode(pair.private),
            box_private: B64.encode(SecretKey::generate(&mut OsRng).to_bytes()),
        })
    }
    pub fn load() -> Result<Self, String> {
        load_identity("machine", false)
    }
    pub fn public(&self) -> Result<MachineKey, String> {
        let private = decode32(&self.noise_private)?;
        // Snow derives its public key during builder setup; crypto_box uses the same X25519 primitive.
        let noise = SecretKey::from(private).public_key();
        Ok(MachineKey {
            machine_id: machine_id()?,
            noise_key: B64.encode(noise.as_bytes()),
            box_key: B64.encode(self.box_secret()?.public_key().as_bytes()),
        })
    }
    pub fn noise_private(&self) -> Result<[u8; 32], String> {
        decode32(&self.noise_private)
    }
    fn box_secret(&self) -> Result<SecretKey, String> {
        Ok(SecretKey::from(decode32(&self.box_private)?))
    }
    pub fn open(&self, envelope: &Value, client: &ClientKey) -> Result<Value, String> {
        let nonce: [u8; 24] = B64
            .decode(
                envelope["nonce"]
                    .as_str()
                    .ok_or("Encrypted command required")?,
            )
            .map_err(|_| "Invalid encrypted command")?
            .try_into()
            .map_err(|_| "Invalid encrypted nonce")?;
        let encrypted = B64
            .decode(
                envelope["ciphertext"]
                    .as_str()
                    .ok_or("Encrypted command required")?,
            )
            .map_err(|_| "Invalid encrypted command")?;
        if encrypted.len() > MAX_COMMAND {
            return Err("Encrypted command exceeds limit".into());
        }
        let cipher = SalsaBox::new(
            &PublicKey::from(decode32(&client.box_key)?),
            &self.box_secret()?,
        );
        let bytes = cipher
            .decrypt((&nonce).into(), encrypted.as_slice())
            .map_err(|_| "Encrypted command authentication failed")?;
        serde_json::from_slice(&bytes).map_err(|_| "Invalid encrypted command".into())
    }
    pub fn seal(&self, value: &Value, client: &ClientKey) -> Result<Value, String> {
        let cipher = SalsaBox::new(
            &PublicKey::from(decode32(&client.box_key)?),
            &self.box_secret()?,
        );
        let nonce = SalsaBox::generate_nonce(&mut OsRng);
        let bytes = serde_json::to_vec(value).map_err(|_| "Invalid secure response")?;
        if bytes.len() > MAX_COMMAND {
            return Err("Secure response exceeds limit".into());
        }
        let encrypted = cipher
            .encrypt(&nonce, bytes.as_slice())
            .map_err(|_| "Could not encrypt response")?;
        Ok(json!({"nonce":B64.encode(nonce),"ciphertext":B64.encode(encrypted)}))
    }
}

#[cfg(target_os = "macos")]
fn load_identity_inner(account: &str, create: bool) -> Result<Identity, String> {
    use security_framework::passwords::{generic_password, set_generic_password, PasswordOptions};
    let service = "cc.clawtab.secure-move";
    match generic_password(PasswordOptions::new_generic_password(service, account)) {
        Ok(bytes) => {
            return serde_json::from_slice(&bytes).map_err(|_| "Invalid machine identity".into())
        }
        Err(error) if create && error.code() == -25300 => {}
        Err(_) => return Err("Machine identity unavailable; run cwt move identity locally".into()),
    }
    let identity = Identity::generate()?;
    let encoded = serde_json::to_vec(&identity).map_err(|_| "Invalid identity")?;
    set_generic_password(service, account, &encoded)
        .map_err(|_| "Could not save machine identity")?;
    Ok(identity)
}
#[cfg(not(target_os = "macos"))]
fn load_identity_inner(account: &str, create: bool) -> Result<Identity, String> {
    let path = directory()?.join(format!("identity-{account}.json"));
    if path
        .try_exists()
        .map_err(|_| "Identity storage unavailable")?
    {
        return read_json(&path);
    }
    if !create {
        return Err("Run cwt move identity locally".into());
    }
    let identity = Identity::generate()?;
    save_json(&path, &identity)?;
    Ok(identity)
}
fn load_identity(account: &str, create: bool) -> Result<Identity, String> {
    let _lock = file_lock("identity.lock")?;
    load_identity_inner(account, create)
}

/// Must only be called through local same-UID IPC, never through the relay.
pub fn enroll(action: &str, value: Value) -> Result<Value, String> {
    let _lock = store_lock()?;
    let mut trust = load_trust()?;
    match action {
        "identity" => {
            let public = load_identity("machine", true)?.public()?;
            return Ok(
                json!({"identity":public,"fingerprint":fingerprint(&public)?,"enabled":trust.enabled}),
            );
        }
        "trust_client" => {
            let key: ClientKey =
                serde_json::from_value(value).map_err(|_| "Invalid client identity")?;
            decode32(&key.signing_key)?;
            decode32(&key.box_key)?;
            trust.clients.insert(fingerprint(&key)?, key);
        }
        "trust_machine" => {
            let key: MachineKey =
                serde_json::from_value(value).map_err(|_| "Invalid machine identity")?;
            uuid::Uuid::parse_str(&key.machine_id).map_err(|_| "Invalid machine ID")?;
            decode32(&key.noise_key)?;
            decode32(&key.box_key)?;
            if trust
                .machines
                .get(&key.machine_id)
                .is_some_and(|old| old != &key)
            {
                return Err(
                    "Machine key changed; revoke its old identity before verifying the replacement"
                        .into(),
                );
            }
            trust.machines.insert(key.machine_id.clone(), key);
        }
        "revoke_client" => {
            trust
                .clients
                .remove(value.as_str().ok_or("Client fingerprint required")?);
        }
        "revoke_machine" => {
            trust
                .machines
                .remove(value.as_str().ok_or("Machine ID required")?);
        }
        "enable" => {
            Identity::load()?;
            if trust.clients.is_empty() {
                return Err("Verify at least one client before enabling secure commands".into());
            }
            trust.enabled = true;
        }
        _ => return Err("Unknown local trust action".into()),
    }
    save_json(&directory()?.join("trust.json"), &trust)?;
    Ok(json!({"ok":true,"enabled":trust.enabled}))
}
pub fn trusted_machine(id: &str) -> Result<MachineKey, String> {
    load_trust()?
        .machines
        .remove(id)
        .ok_or("Verify this machine through its local console before moving".into())
}
pub fn trusted_client(id: &str) -> Result<ClientKey, String> {
    load_trust()?
        .clients
        .remove(id)
        .ok_or("Verify this client through the machine's local console".into())
}

/// Desktop client keys stay inside Keychain; the webview receives only public keys or ciphertext.
pub fn client_operation(action: &str, value: Value) -> Result<Value, String> {
    let _lock = store_lock()?;
    let identity = load_identity("desktop-client", true)?;
    let signing = SigningKey::from_bytes(&identity.noise_private()?);
    let public = ClientKey {
        signing_key: B64.encode(signing.verifying_key().as_bytes()),
        box_key: B64.encode(identity.box_secret()?.public_key().as_bytes()),
    };
    let client = fingerprint(&public)?;
    match action {
        "public" => Ok(json!({"identity":public,"fingerprint":client})),
        "sign" => {
            let machine = value["machine"].as_str().ok_or("Machine ID required")?;
            let message =
                serde_json::to_string(&value["message"]).map_err(|_| "Invalid command")?;
            let expires = chrono::Utc::now().timestamp_millis() + 60_000;
            let bytes = format!("clawtab-command-v1\n{client}\n{machine}\n{expires}\n{message}");
            Ok(
                json!({"client":client,"machine":machine,"expires":expires,"message":message,"signature":B64.encode(signing.sign(bytes.as_bytes()).to_bytes())}),
            )
        }
        "machines" => Ok(json!(load_trust()?.machines)),
        "seal" | "open" => {
            let machine = value["machine"].as_str().ok_or("Machine ID required")?;
            let key = load_trust()?
                .machines
                .remove(machine)
                .ok_or("Paste the verified machine identity from its local console first")?;
            let client_key = ClientKey {
                signing_key: String::new(),
                box_key: key.box_key,
            };
            if action == "seal" {
                identity.seal(&value["value"], &client_key)
            } else {
                identity.open(&value["value"], &client_key)
            }
        }
        "pin" => {
            let key: MachineKey =
                serde_json::from_value(value).map_err(|_| "Invalid machine identity")?;
            uuid::Uuid::parse_str(&key.machine_id).map_err(|_| "Invalid machine ID")?;
            decode32(&key.noise_key)?;
            decode32(&key.box_key)?;
            let mut trust = load_trust()?;
            if trust
                .machines
                .get(&key.machine_id)
                .is_some_and(|old| old != &key)
            {
                return Err(
                    "Pinned machine key changed; revoke and verify it again locally".into(),
                );
            }
            trust.machines.insert(key.machine_id.clone(), key);
            save_json(&directory()?.join("trust.json"), &trust)?;
            Ok(json!({"ok":true}))
        }
        _ => Err("Unknown client security operation".into()),
    }
}
fn verify_authorization(
    auth: &Authorization,
    client: &ClientKey,
    target: &str,
    now: i64,
) -> Result<Authenticated, String> {
    if auth.machine != target
        || auth.expires < now
        || auth.expires > now + 60_000
        || auth.message.len() > MAX_COMMAND
    {
        return Err("Command expired or addressed to another machine".into());
    }
    if fingerprint(client)? != auth.client {
        return Err("Client identity does not match its fingerprint".into());
    }
    let bytes = format!(
        "clawtab-command-v1\n{}\n{}\n{}\n{}",
        auth.client, auth.machine, auth.expires, auth.message
    );
    let signature = Signature::from_slice(
        &B64.decode(&auth.signature)
            .map_err(|_| "Invalid command signature")?,
    )
    .map_err(|_| "Invalid command signature")?;
    VerifyingKey::from_bytes(&decode32(&client.signing_key)?)
        .map_err(|_| "Invalid client key")?
        .verify_strict(bytes.as_bytes(), &signature)
        .map_err(|_| "Command authentication failed")?;
    let message: Value =
        serde_json::from_str(&auth.message).map_err(|_| "Invalid signed command")?;
    let nonce = message["id"].as_str().ok_or("Command ID required")?;
    uuid::Uuid::parse_str(nonce).map_err(|_| "Invalid command ID")?;
    Ok(Authenticated {
        client: auth.client.clone(),
        request_id: nonce.into(),
        message,
    })
}
fn consume_nonce(
    trust: &mut Trust,
    auth: &Authorization,
    nonce: &str,
    now: i64,
) -> Result<(), String> {
    let replay_id = format!("{}:{nonce}", auth.client);
    if trust.replay.contains_key(&replay_id) {
        return Err("Command already received; inspect operation status".into());
    }
    trust.replay.retain(|_, expiry| *expiry >= now);
    if trust.replay.len() >= 10000 {
        return Err("Secure command rate limit reached".into());
    }
    trust.replay.insert(replay_id, auth.expires);
    Ok(())
}
pub fn verify(value: &Value, target: &str, now: i64) -> Result<Authenticated, String> {
    let auth: Authorization =
        serde_json::from_value(value.clone()).map_err(|_| "Signed command required")?;
    let _lock = store_lock()?;
    let mut trust = load_trust()?;
    let client = trust
        .clients
        .get(&auth.client)
        .ok_or("Client is not trusted on this machine")?;
    let verified = verify_authorization(&auth, client, target, now)?;
    consume_nonce(&mut trust, &auth, &verified.request_id, now)?;
    save_json(&directory()?.join("trust.json"), &trust)?;
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn signed() -> (Authorization, ClientKey) {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let client = ClientKey {
            signing_key: B64.encode(signing.verifying_key().as_bytes()),
            box_key: B64.encode(SecretKey::from([9; 32]).public_key().as_bytes()),
        };
        let mut auth = Authorization {
            client: fingerprint(&client).unwrap(),
            machine: uuid::Uuid::new_v4().to_string(),
            expires: 50_000,
            message: json!({"id":uuid::Uuid::new_v4(),"type":"stop_job","name":"fixture"})
                .to_string(),
            signature: String::new(),
        };
        auth.signature = B64.encode(
            signing
                .sign(
                    format!(
                        "clawtab-command-v1\n{}\n{}\n{}\n{}",
                        auth.client, auth.machine, auth.expires, auth.message
                    )
                    .as_bytes(),
                )
                .to_bytes(),
        );
        (auth, client)
    }
    #[test]
    fn tweetnacl_mobile_ciphertext_and_fingerprint_match_rust() {
        // Public fixture generated by tweetnacl 1.0.3 with fixed, nonproduction keys.
        let fixture: Value =
            serde_json::from_str(include_str!("movement/crypto-fixture.json")).unwrap();
        let client: ClientKey = serde_json::from_value(fixture["identity"].clone()).unwrap();
        assert_eq!(
            fingerprint(&client).unwrap(),
            fixture["fingerprint"].as_str().unwrap()
        );
        let machine = Identity {
            noise_private: B64.encode([0; 32]),
            box_private: B64.encode([2; 32]),
        };
        assert_eq!(
            machine.open(&fixture, &client).unwrap(),
            fixture["plaintext"]
        );
    }
    #[test]
    fn command_is_bound_to_client_machine_payload_and_expiry() {
        let (mut auth, client) = signed();
        assert!(verify_authorization(&auth, &client, &auth.machine, 10_000).is_ok());
        assert!(verify_authorization(&auth, &client, "other", 10_000).is_err());
        assert!(verify_authorization(&auth, &client, &auth.machine, 50_001).is_err());
        assert!(verify_authorization(&auth, &client, &auth.machine, -10_001).is_err());
        auth.message = auth.message.replace("fixture", "forged");
        assert!(verify_authorization(&auth, &client, &auth.machine, 10_000).is_err());
    }
    #[test]
    fn replay_survives_serialization_and_is_client_scoped() {
        let (auth, _) = signed();
        let mut trust = Trust::default();
        consume_nonce(&mut trust, &auth, "nonce", 10_000).unwrap();
        let mut restored: Trust =
            serde_json::from_slice(&serde_json::to_vec(&trust).unwrap()).unwrap();
        assert!(consume_nonce(&mut restored, &auth, "nonce", 10_000).is_err());
        assert!(consume_nonce(&mut restored, &auth, "different", 10_000).is_ok());
    }
    #[test]
    fn encrypted_commands_reject_tampering_and_wrong_recipient() {
        let machine = Identity::generate().unwrap();
        let app = Identity::generate().unwrap();
        let client = ClientKey {
            signing_key: String::new(),
            box_key: B64.encode(app.box_secret().unwrap().public_key().as_bytes()),
        };
        let host = ClientKey {
            signing_key: String::new(),
            box_key: B64.encode(machine.box_secret().unwrap().public_key().as_bytes()),
        };
        let content = json!({"request_id":"fixture","request":{"action":"move_status"}});
        let mut envelope = app.seal(&content, &host).unwrap();
        assert_eq!(machine.open(&envelope, &client).unwrap(), content);
        assert!(Identity::generate()
            .unwrap()
            .open(&envelope, &client)
            .is_err());
        let mut ciphertext = B64
            .decode(envelope["ciphertext"].as_str().unwrap())
            .unwrap();
        ciphertext[0] ^= 1;
        envelope["ciphertext"] = json!(B64.encode(ciphertext));
        assert!(machine.open(&envelope, &client).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn secure_records_reject_symlinks_and_world_readable_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("record.json");
        save_json(&path, &json!({"fixture":true})).unwrap();
        assert_eq!(read_json::<Value>(&path).unwrap(), json!({"fixture":true}));
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::MetadataExt::mode(&std::fs::metadata(&path).unwrap()) & 0o777,
            0o600
        );
        std::fs::set_permissions(
            &path,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o644),
        )
        .unwrap();
        assert!(read_json::<Value>(&path).is_err());
        let link = directory.path().join("link.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(read_json::<Value>(&link).is_err());
    }
}
