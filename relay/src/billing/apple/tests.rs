#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::map_unwrap_or,
    clippy::needless_pass_by_value
)]
use super::*;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use openssl::{
    asn1::{Asn1Integer, Asn1Time},
    bn::BigNum,
    ec::{EcGroup, EcKey},
    ecdsa::EcdsaSig,
    hash::MessageDigest,
    nid::Nid,
    pkey::{PKey, Private},
    x509::{
        extension::{AuthorityKeyIdentifier, BasicConstraints, KeyUsage, SubjectKeyIdentifier},
        X509Extension, X509NameBuilder, X509,
    },
};
use serde_json::{json, Value};

const BUNDLE: &str = "cc.clawtab";
const ACCOUNT: &str = "46c3dc16-4e0b-4cc5-b3b1-88d2ee95aef5";

struct Signer {
    key: EcKey<Private>,
    chain: Vec<Vec<u8>>,
    root: Vec<u8>,
}

fn certificate(
    name: &str,
    key: &PKey<Private>,
    issuer: Option<(&X509, &PKey<Private>)>,
    ca: bool,
    oid: Option<&str>,
    serial: u32,
) -> X509 {
    let mut subject = X509NameBuilder::new().unwrap();
    subject.append_entry_by_text("CN", name).unwrap();
    let subject = subject.build();
    let mut cert = X509::builder().unwrap();
    cert.set_version(2).unwrap();
    let serial = Asn1Integer::from_bn(&BigNum::from_u32(serial).unwrap()).unwrap();
    cert.set_serial_number(&serial).unwrap();
    cert.set_subject_name(&subject).unwrap();
    cert.set_issuer_name(
        issuer
            .map(|(cert, _)| cert.subject_name())
            .unwrap_or(&subject),
    )
    .unwrap();
    cert.set_pubkey(key).unwrap();
    cert.set_not_before(&Asn1Time::from_unix(Utc::now().timestamp() - 3600).unwrap())
        .unwrap();
    cert.set_not_after(&Asn1Time::days_from_now(365).unwrap())
        .unwrap();
    let constraints = if ca {
        BasicConstraints::new().critical().ca().build()
    } else {
        BasicConstraints::new().critical().build()
    };
    cert.append_extension(constraints.unwrap()).unwrap();
    let usage = if ca {
        KeyUsage::new()
            .critical()
            .key_cert_sign()
            .crl_sign()
            .build()
    } else {
        KeyUsage::new().critical().digital_signature().build()
    };
    cert.append_extension(usage.unwrap()).unwrap();
    let ski = SubjectKeyIdentifier::new()
        .build(&cert.x509v3_context(issuer.map(|(cert, _)| cert.as_ref()), None))
        .unwrap();
    cert.append_extension(ski).unwrap();
    if issuer.is_some() {
        let aki = AuthorityKeyIdentifier::new()
            .keyid(true)
            .build(&cert.x509v3_context(issuer.map(|(cert, _)| cert.as_ref()), None))
            .unwrap();
        cert.append_extension(aki).unwrap();
    }
    if let Some(oid) = oid {
        // Test-only certificate extensions matching Apple's public verification policy.
        #[allow(deprecated)]
        let extension = X509Extension::new(None, None, oid, "DER:05:00").unwrap();
        cert.append_extension(extension).unwrap();
    }
    cert.sign(
        issuer.map(|(_, key)| key.as_ref()).unwrap_or(key),
        MessageDigest::sha256(),
    )
    .unwrap();
    cert.build()
}

impl Signer {
    fn new() -> Self {
        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        let root_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
        let root = certificate("Unit test root", &root_key, None, true, None, 1);
        let intermediate_key = PKey::from_ec_key(EcKey::generate(&group).unwrap()).unwrap();
        let intermediate = certificate(
            "Unit test intermediate",
            &intermediate_key,
            Some((&root, &root_key)),
            true,
            Some("1.2.840.113635.100.6.2.1"),
            2,
        );
        let key = EcKey::generate(&group).unwrap();
        let leaf_key = PKey::from_ec_key(key.clone()).unwrap();
        let leaf = certificate(
            "Unit test receipt signer",
            &leaf_key,
            Some((&intermediate, &intermediate_key)),
            false,
            Some("1.2.840.113635.100.6.11.1"),
            3,
        );
        Self {
            key,
            chain: vec![
                leaf.to_der().unwrap(),
                intermediate.to_der().unwrap(),
                root.to_der().unwrap(),
            ],
            root: root.to_der().unwrap(),
        }
    }

    fn sign(&self, body: Value) -> String {
        let header = json!({"alg":"ES256", "x5c":self.chain.iter().map(|cert| STANDARD.encode(cert)).collect::<Vec<_>>()});
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(body.to_string())
        );
        let signature = EcdsaSig::sign(&openssl::sha::sha256(input.as_bytes()), &self.key).unwrap();
        let mut raw = signature.r().to_vec_padded(32).unwrap();
        raw.extend(signature.s().to_vec_padded(32).unwrap());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(raw))
    }

    fn verify(&self, body: Value) -> Result<VerifiedTransaction, VerificationError> {
        verify_transaction_with_roots(&self.sign(body), BUNDLE, std::slice::from_ref(&self.root))
    }
}

fn transaction() -> Value {
    let now = Utc::now().timestamp_millis();
    json!({"bundleId":BUNDLE,"environment":"Sandbox","transactionId":"test-transaction", "originalTransactionId":"test-original", "productId":"cc.clawtab.pro.monthly", "type":"Auto-Renewable Subscription", "purchaseDate":now-60_000,"expiresDate":now+300_000,"signedDate":now,"appAccountToken":ACCOUNT})
}

#[test]
fn signed_subscription_activates_without_a_legacy_receipt_in_both_store_environments() {
    let signer = Signer::new();
    for environment in ["Sandbox", "Production"] {
        let mut body = transaction();
        body["environment"] = json!(environment);
        let verified = signer.verify(body).unwrap();
        assert_eq!(verified.environment, environment);
        assert!(verified.active_at(Utc::now()));
        assert!(verified.belongs_to(Uuid::parse_str(ACCOUNT).unwrap()));
        assert!(!verified.belongs_to(Uuid::nil()));
    }
}

#[test]
fn production_trust_rejects_a_self_signed_chain_even_when_the_signature_is_valid() {
    let signer = Signer::new();
    assert!(verify_transaction(&signer.sign(transaction()), BUNDLE).is_err());
}

#[test]
fn forged_payload_and_missing_certificate_chain_are_rejected() {
    let signer = Signer::new();
    let signed = signer.sign(transaction());
    let mut parts = signed.split('.').map(str::to_owned).collect::<Vec<_>>();
    let mut forged = transaction();
    forged["productId"] = json!("another-product");
    parts[1] = URL_SAFE_NO_PAD.encode(forged.to_string());
    assert!(verify_transaction_with_roots(
        &parts.join("."),
        BUNDLE,
        std::slice::from_ref(&signer.root)
    )
    .is_err());
    parts[0] = URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#);
    assert!(verify_transaction_with_roots(&parts.join("."), BUNDLE, &[signer.root]).is_err());
}

#[test]
fn wrong_app_local_testing_incomplete_and_future_transactions_are_rejected() {
    let signer = Signer::new();
    for (field, value) in [
        ("bundleId", json!("another.app")),
        ("environment", json!("Xcode")),
        ("environment", json!("LocalTesting")),
        ("type", json!("Consumable")),
        ("transactionId", json!("")),
        ("originalTransactionId", Value::Null),
        ("expiresDate", Value::Null),
        ("signedDate", json!(Utc::now().timestamp_millis() + 600_000)),
    ] {
        let mut body = transaction();
        body[field] = value;
        assert!(signer.verify(body).is_err(), "accepted invalid {field}");
    }
}

#[test]
fn expired_refunded_and_superseded_transactions_never_grant_access() {
    let signer = Signer::new();
    for (field, value) in [
        ("expiresDate", json!(Utc::now().timestamp_millis() - 1000)),
        ("revocationDate", json!(Utc::now().timestamp_millis())),
        ("isUpgraded", json!(true)),
    ] {
        let mut body = transaction();
        body[field] = value;
        assert!(!signer.verify(body).unwrap().active_at(Utc::now()));
    }
}

#[test]
fn production_notifications_require_the_matching_app_apple_id() {
    let signer = Signer::new();
    let mut transaction = transaction();
    transaction["environment"] = json!("Production");
    let mut notification = json!({"notificationType":"DID_RENEW","notificationUUID":"test-notification","signedDate":Utc::now().timestamp_millis(),"data":{"bundleId":BUNDLE,"appAppleId":APP_APPLE_ID,"environment":"Production","signedTransactionInfo":signer.sign(transaction)}});
    let verified = verify_notification_with_roots(
        &signer.sign(notification.clone()),
        BUNDLE,
        std::slice::from_ref(&signer.root),
    )
    .unwrap();
    assert_eq!(verified.environment, "Production");
    notification["data"]["appAppleId"] = json!(123);
    assert!(verify_notification_with_roots(
        &signer.sign(notification),
        BUNDLE,
        std::slice::from_ref(&signer.root),
    )
    .is_err());
}

#[test]
fn notifications_verify_outer_and_nested_signatures_and_bind_renewal_to_transaction() {
    let signer = Signer::new();
    let signed_transaction = signer.sign(transaction());
    let mut renewal = json!({"environment":"Sandbox","originalTransactionId":"test-original","autoRenewStatus":0,"signedDate":Utc::now().timestamp_millis()});
    let mut notification = json!({"notificationType":"DID_CHANGE_RENEWAL_STATUS","notificationUUID":"test-notification","signedDate":Utc::now().timestamp_millis(),"data":{"bundleId":BUNDLE,"appAppleId":APP_APPLE_ID,"environment":"Sandbox","signedTransactionInfo":signed_transaction,"signedRenewalInfo":signer.sign(renewal.clone())}});
    let verified = verify_notification_with_roots(
        &signer.sign(notification.clone()),
        BUNDLE,
        std::slice::from_ref(&signer.root),
    )
    .unwrap();
    assert_eq!(verified.auto_renew, Some(false));
    assert!(verified.transaction.unwrap().active_at(Utc::now()));
    renewal["originalTransactionId"] = json!("different-original");
    notification["data"]["signedRenewalInfo"] = json!(signer.sign(renewal));
    assert!(verify_notification_with_roots(
        &signer.sign(notification.clone()),
        BUNDLE,
        std::slice::from_ref(&signer.root)
    )
    .is_err());
    notification["data"]["signedTransactionInfo"] = json!("forged.payload.signature");
    assert!(
        verify_notification_with_roots(&signer.sign(notification), BUNDLE, &[signer.root]).is_err()
    );
}
