//! Native macOS notifications via UserNotifications.framework.
//!
//! Works only when the calling process is a code-signed .app bundle with a
//! registered CFBundleIdentifier - that's why the daemon is shipped inside
//! "Clawtab Engine.app". A bare CLI cannot deliver these notifications;
//! UNUserNotificationCenter silently no-ops.

use std::sync::Once;

use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
    UNNotificationSound, UNUserNotificationCenter,
};

static AUTH_REQUEST: Once = Once::new();

/// Send a notification through UNUserNotificationCenter. Returns Err if the
/// framework wasn't available (e.g. running outside an .app bundle).
pub fn send(title: &str, body: &str) -> Result<(), String> {
    AUTH_REQUEST.call_once(request_authorization);

    let center = unsafe { UNUserNotificationCenter::currentNotificationCenter() };

    let ns_title = NSString::from_str(title);
    let ns_body = NSString::from_str(body);

    let content = unsafe { UNMutableNotificationContent::new() };
    unsafe {
        content.setTitle(&ns_title);
        content.setBody(&ns_body);
        let sound = UNNotificationSound::defaultSound();
        content.setSound(Some(&sound));
    }

    // Unique identifier so consecutive notifications don't replace each other.
    let identifier = NSString::from_str(&format!("cc.clawtab.engine.{}", uuid::Uuid::new_v4()));

    let request = unsafe {
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None)
    };

    let handler = block2::RcBlock::new(move |error: *mut NSError| {
        if !error.is_null() {
            if let Some(err) = unsafe { Retained::retain(error) } {
                log::warn!(
                    "[native-notifications] delivery failed: {}",
                    err.localizedDescription()
                );
            }
        }
    });

    unsafe {
        center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    }

    Ok(())
}

fn request_authorization() {
    let center = unsafe { UNUserNotificationCenter::currentNotificationCenter() };
    let options = UNAuthorizationOptions::UNAuthorizationOptionAlert
        | UNAuthorizationOptions::UNAuthorizationOptionSound;

    let handler = block2::RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if !error.is_null() {
            if let Some(err) = unsafe { Retained::retain(error) } {
                log::warn!(
                    "[native-notifications] authorization error: {}",
                    err.localizedDescription()
                );
            }
            return;
        }
        if granted.as_bool() {
            log::info!("[native-notifications] notification authorization granted");
        } else {
            log::info!(
                "[native-notifications] notification authorization not granted; \
                 notifications will be silently dropped by macOS"
            );
        }
    });

    unsafe {
        center.requestAuthorizationWithOptions_completionHandler(options, &handler);
    }
}
