use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::rand_core::RngCore;
use base64::Engine;
use sha2::{Digest, Sha256};

fn derive_key(raw: &str) -> Key<Aes256Gcm> {
    let hash = Sha256::digest(raw.as_bytes());
    *Key::<Aes256Gcm>::from_slice(&hash)
}

pub fn encrypt(plaintext: &str, key_str: &str) -> anyhow::Result<String> {
    let key = derive_key(key_str);
    let cipher = Aes256Gcm::new(&key);

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("encrypt failed: {e}"))?;

    let mut combined = nonce_bytes.to_vec();
    combined.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(combined))
}

pub fn decrypt(encoded: &str, key_str: &str) -> anyhow::Result<String> {
    let combined = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| anyhow::anyhow!("base64 decode failed: {e}"))?;

    if combined.len() < 12 {
        return Err(anyhow::anyhow!("ciphertext too short"));
    }

    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let key = derive_key(key_str);
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow::anyhow!("decrypt failed: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("utf8 error: {e}"))
}
