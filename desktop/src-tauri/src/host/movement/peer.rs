//! Bounded host-to-host RPC. Only ciphertext is routed through the relay.
use super::super::security::{self, Identity, NOISE};
use crate::job_context::JobContext;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::LazyLock,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

const LIMIT: usize = 60 * 1024;
struct Waiting {
    peer: String,
    tx: mpsc::Sender<Value>,
    since: Instant,
}
struct Receiving {
    peer: String,
    transport: snow::TransportState,
    since: Instant,
}
static WAITING: LazyLock<parking_lot::Mutex<HashMap<String, Waiting>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));
static RECEIVING: LazyLock<parking_lot::Mutex<HashMap<String, Receiving>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

fn send(ctx: &JobContext, peer: &str, id: &str, phase: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 65535 {
        return Err("Secure frame exceeds limit".into());
    }
    let message =
        json!({"type":"secure_peer","to":peer,"id":id,"phase":phase,"data":B64.encode(bytes)});
    ctx.relay
        .lock()
        .as_ref()
        .ok_or("Relay connection is unavailable")?
        .send_raw(message.to_string())
}
fn prologue(source: &str, target: &str, id: &str) -> String {
    format!("clawtab-move-peer-v1\n{source}\n{target}\n{id}")
}
pub async fn roster(ctx: &JobContext) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel(1);
    WAITING.lock().insert(
        id.clone(),
        Waiting {
            peer: "roster".into(),
            tx,
            since: Instant::now(),
        },
    );
    let _guard = PendingGuard(id.clone());
    ctx.relay
        .lock()
        .as_ref()
        .ok_or("Connect this machine to the relay first")?
        .send_raw(json!({"type":"secure_roster","id":id}).to_string())?;
    tokio::time::timeout(Duration::from_secs(15), rx.recv())
        .await
        .map_err(|_| "Machine list timed out; update the relay for Secure Move")?
        .ok_or("Machine list unavailable".into())
}
struct PendingGuard(String);
impl Drop for PendingGuard {
    fn drop(&mut self) {
        WAITING.lock().remove(&self.0);
    }
}
struct Channel {
    id: String,
    _guard: PendingGuard,
    rx: mpsc::Receiver<Value>,
    transport: snow::TransportState,
    public: security::MachineKey,
    source: String,
    used: Instant,
}
static OUTBOUND: LazyLock<
    parking_lot::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<Option<Channel>>>>>,
> = LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));
async fn connect(ctx: &JobContext, target: &str) -> Result<Channel, String> {
    let identity = Identity::load()?;
    let source = security::machine_id()?;
    let public = security::trusted_machine(target)?;
    let id = uuid::Uuid::new_v4().to_string();
    let binding = prologue(&source, target, &id);
    let secret = identity.noise_private()?;
    let remote = security::decode32(&public.noise_key)?;
    let mut handshake = snow::Builder::new(NOISE.parse().map_err(|_| "Invalid secure protocol")?)
        .local_private_key(&secret)
        .map_err(|_| "Invalid machine identity")?
        .remote_public_key(&remote)
        .map_err(|_| "Invalid trusted machine")?
        .prologue(binding.as_bytes())
        .map_err(|_| "Invalid secure binding")?
        .build_initiator()
        .map_err(|_| "Could not establish secure channel")?;
    let (tx, mut rx) = mpsc::channel(2);
    {
        let mut waiting = WAITING.lock();
        waiting.retain(|_, entry| entry.since.elapsed() < Duration::from_secs(180));
        if waiting.len() >= 32 {
            return Err("Too many secure peer requests".into());
        }
        waiting.insert(
            id.clone(),
            Waiting {
                peer: target.into(),
                tx,
                since: Instant::now(),
            },
        );
    }
    let guard = PendingGuard(id.clone());
    let mut buffer = vec![0; 65535];
    let size = handshake
        .write_message(&[], &mut buffer)
        .map_err(|_| "Secure handshake failed")?;
    send(ctx, target, &id, "hello", &buffer[..size])?;
    let response = tokio::time::timeout(Duration::from_secs(30), rx.recv())
        .await
        .map_err(|_| "Target secure handshake timed out")?
        .ok_or("Target disconnected")?;
    if response["phase"] != "welcome" {
        return Err("Unexpected secure handshake response".into());
    }
    let bytes = decode(&response)?;
    handshake
        .read_message(&bytes, &mut buffer)
        .map_err(|_| "Target machine authentication failed")?;
    if handshake.get_remote_static() != Some(remote.as_slice()) {
        return Err("Target machine key changed".into());
    }
    let transport = handshake
        .into_transport_mode()
        .map_err(|_| "Secure handshake incomplete")?;
    Ok(Channel {
        id,
        _guard: guard,
        rx,
        transport,
        public,
        source,
        used: Instant::now(),
    })
}
pub async fn request(ctx: &JobContext, target: &str, request: Value) -> Result<Value, String> {
    let slot = {
        let mut pool = OUTBOUND.lock();
        pool.retain(|_, slot| {
            std::sync::Arc::strong_count(slot) > 1
                || slot
                    .try_lock()
                    .map(|channel| {
                        channel.as_ref().is_some_and(|channel| {
                            channel.used.elapsed() < Duration::from_secs(180)
                        })
                    })
                    .unwrap_or(true)
        });
        if !pool.contains_key(target) && pool.len() >= 32 {
            return Err("Too many secure peer channels".into());
        }
        pool.entry(target.into())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(None)))
            .clone()
    };
    let mut channel = slot.lock().await;
    let key = security::trusted_machine(target)?;
    let source = security::machine_id()?;
    if channel.as_ref().is_some_and(|channel| {
        channel.public != key
            || channel.source != source
            || channel.used.elapsed() >= Duration::from_secs(180)
    }) {
        *channel = None;
    }
    if channel.is_none() {
        *channel = Some(connect(ctx, target).await?);
    }
    let result = exchange(
        ctx,
        target,
        channel.as_mut().ok_or("Secure channel unavailable")?,
        request,
    )
    .await;
    if result.is_err() {
        *channel = None;
    }
    result
}
async fn exchange(
    ctx: &JobContext,
    target: &str,
    channel: &mut Channel,
    request: Value,
) -> Result<Value, String> {
    let mut buffer = vec![0; 65535];
    let request =
        json!({"expires":chrono::Utc::now().timestamp_millis() + 60_000,"request":request});
    let bytes = serde_json::to_vec(&request).map_err(|_| "Invalid peer request")?;
    if bytes.len() > LIMIT {
        return Err("Peer request exceeds limit".into());
    }
    let size = channel
        .transport
        .write_message(&bytes, &mut buffer)
        .map_err(|_| "Could not encrypt peer request")?;
    if let Some(waiting) = WAITING.lock().get_mut(&channel.id) {
        waiting.since = Instant::now();
    }
    send(ctx, target, &channel.id, "request", &buffer[..size])?;
    let response = tokio::time::timeout(Duration::from_secs(180), channel.rx.recv())
        .await
        .map_err(|_| "Target request timed out; inspect move status before recovery")?
        .ok_or("Target disconnected")?;
    if response["phase"] != "response" {
        return Err("Unexpected secure peer response".into());
    }
    let bytes = decode(&response)?;
    let size = channel
        .transport
        .read_message(&bytes, &mut buffer)
        .map_err(|_| "Peer response authentication failed")?;
    let value: Value =
        serde_json::from_slice(&buffer[..size]).map_err(|_| "Invalid secure peer response")?;
    channel.used = Instant::now();
    if let Some(error) = value["error"].as_str() {
        return Err(error.into());
    }
    Ok(value["result"].clone())
}
fn decode(value: &Value) -> Result<Vec<u8>, String> {
    let text = value["data"].as_str().ok_or("Invalid secure frame")?;
    if text.len() > 88 * 1024 {
        return Err("Secure frame exceeds limit".into());
    }
    B64.decode(text).map_err(|_| "Invalid secure frame".into())
}
pub async fn receive(value: &Value, ctx: &JobContext) -> Result<(), String> {
    if value["type"] == "secure_roster_result" {
        if let Some(id) = value["id"].as_str() {
            if let Some(entry) = WAITING
                .lock()
                .get(id)
                .filter(|entry| entry.peer == "roster")
            {
                let _ = entry.tx.try_send(value.clone());
            }
        }
        return Ok(());
    }
    if !security::enabled() {
        return Err("Secure Move is not enabled on this machine".into());
    }
    let source = value["from"].as_str().ok_or("Peer identity missing")?;
    let id = value["id"].as_str().ok_or("Peer request ID missing")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid peer request ID")?;
    let public = security::trusted_machine(source)?;
    let phase = value["phase"].as_str().ok_or("Peer phase missing")?;
    if matches!(phase, "welcome" | "response") {
        let waiting = WAITING.lock();
        if let Some(entry) = waiting.get(id).filter(|entry| entry.peer == source) {
            entry
                .tx
                .try_send(value.clone())
                .map_err(|_| "Secure peer reply queue full")?;
        }
        return Ok(());
    }
    let bytes = decode(value)?;
    if phase == "hello" {
        let identity = Identity::load()?;
        let target = security::machine_id()?;
        let binding = prologue(source, &target, id);
        let secret = identity.noise_private()?;
        let remote = security::decode32(&public.noise_key)?;
        let mut handshake =
            snow::Builder::new(NOISE.parse().map_err(|_| "Invalid secure protocol")?)
                .local_private_key(&secret)
                .map_err(|_| "Invalid machine identity")?
                .prologue(binding.as_bytes())
                .map_err(|_| "Invalid secure binding")?
                .build_responder()
                .map_err(|_| "Could not establish secure channel")?;
        let mut buffer = vec![0; 65535];
        handshake
            .read_message(&bytes, &mut buffer)
            .map_err(|_| "Peer handshake authentication failed")?;
        if handshake.get_remote_static() != Some(remote.as_slice()) {
            return Err("Source machine key changed".into());
        }
        let size = handshake
            .write_message(&[], &mut buffer)
            .map_err(|_| "Peer handshake failed")?;
        let transport = handshake
            .into_transport_mode()
            .map_err(|_| "Peer handshake incomplete")?;
        {
            let mut receiving = RECEIVING.lock();
            receiving.retain(|_, entry| entry.since.elapsed() < Duration::from_secs(180));
            if receiving.len() >= 32 || receiving.contains_key(id) {
                return Err("Secure peer request limit reached".into());
            }
            receiving.insert(
                id.into(),
                Receiving {
                    peer: source.into(),
                    transport,
                    since: Instant::now(),
                },
            );
        }
        return send(ctx, source, id, "welcome", &buffer[..size]);
    }
    if phase != "request" {
        return Err("Unsupported secure peer phase".into());
    }
    let mut channel = RECEIVING
        .lock()
        .remove(id)
        .filter(|entry| entry.peer == source)
        .ok_or("Secure peer channel expired")?;
    let mut buffer = vec![0; 65535];
    let size = channel
        .transport
        .read_message(&bytes, &mut buffer)
        .map_err(|_| "Peer request authentication failed")?;
    let request: Value =
        serde_json::from_slice(&buffer[..size]).map_err(|_| "Invalid peer request")?;
    let now = chrono::Utc::now().timestamp_millis();
    let expiry = request["expires"]
        .as_i64()
        .ok_or("Peer command expiration missing")?;
    if expiry < now || expiry > now + 60_000 {
        return Err("Peer command expired".into());
    }
    let result = super::peer_execute(source, request["request"].clone(), ctx).await;
    let value = match result {
        Ok(result) => json!({"result":result}),
        Err(error) => json!({"error":error}),
    };
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "Invalid peer response")?;
    if bytes.len() > LIMIT {
        bytes = br#"{"error":"Peer response exceeds limit"}"#.to_vec();
    }
    let size = channel
        .transport
        .write_message(&bytes, &mut buffer)
        .map_err(|_| "Could not encrypt peer response")?;
    channel.since = Instant::now();
    RECEIVING.lock().insert(id.into(), channel);
    send(ctx, source, id, "response", &buffer[..size])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn handshake(
        binding: &[u8],
        wrong_target: bool,
    ) -> (snow::HandshakeState, snow::HandshakeState) {
        let builder = snow::Builder::new(NOISE.parse().unwrap());
        let source = builder.generate_keypair().unwrap();
        let target = builder.generate_keypair().unwrap();
        let other = builder.generate_keypair().unwrap();
        let initiator = snow::Builder::new(NOISE.parse().unwrap())
            .local_private_key(&source.private)
            .unwrap()
            .remote_public_key(if wrong_target {
                &other.public
            } else {
                &target.public
            })
            .unwrap()
            .prologue(binding)
            .unwrap()
            .build_initiator()
            .unwrap();
        let responder = snow::Builder::new(NOISE.parse().unwrap())
            .local_private_key(&target.private)
            .unwrap()
            .prologue(binding)
            .unwrap()
            .build_responder()
            .unwrap();
        (initiator, responder)
    }
    #[test]
    fn wrong_target_key_cannot_read_handshake() {
        let (mut source, mut target) = handshake(b"fixture", true);
        let mut frame = [0; 65535];
        let mut plaintext = [0; 65535];
        let length = source.write_message(&[], &mut frame).unwrap();
        assert!(target
            .read_message(&frame[..length], &mut plaintext)
            .is_err());
    }
    #[test]
    fn reusable_channel_authenticates_every_chunk_and_rejects_replay() {
        let binding = prologue("source", "target", "operation");
        let (mut source, mut target) = handshake(binding.as_bytes(), false);
        let mut frame = [0; 65535];
        let mut plaintext = [0; 65535];
        let length = source.write_message(&[], &mut frame).unwrap();
        target
            .read_message(&frame[..length], &mut plaintext)
            .unwrap();
        let length = target.write_message(&[], &mut frame).unwrap();
        source
            .read_message(&frame[..length], &mut plaintext)
            .unwrap();
        let mut source = source.into_transport_mode().unwrap();
        let mut target = target.into_transport_mode().unwrap();
        for number in 0..100u32 {
            let length = source
                .write_message(&number.to_le_bytes(), &mut frame)
                .unwrap();
            let count = target
                .read_message(&frame[..length], &mut plaintext)
                .unwrap();
            assert_eq!(&plaintext[..count], &number.to_le_bytes());
            assert!(target
                .read_message(&frame[..length], &mut plaintext)
                .is_err());
            let length = target.write_message(b"ack", &mut frame).unwrap();
            frame[0] ^= 1;
            assert!(source
                .read_message(&frame[..length], &mut plaintext)
                .is_err());
            frame[0] ^= 1;
            assert_eq!(
                source
                    .read_message(&frame[..length], &mut plaintext)
                    .unwrap(),
                3
            );
        }
    }
    #[test]
    fn machine_and_operation_binding_is_unambiguous() {
        assert_ne!(prologue("a", "bc", "d"), prologue("ab", "c", "d"));
        assert_ne!(prologue("a", "b", "first"), prologue("a", "b", "second"));
    }
}
