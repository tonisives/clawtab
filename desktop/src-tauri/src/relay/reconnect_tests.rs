use super::{reject_busy_request, RelayHandle};
use clawtab_protocol::DesktopMessage;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn connection() -> (RelayHandle, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel(1);
    let shutdown = CancellationToken::new();
    let cancel = shutdown.child_token();
    (
        RelayHandle {
            tx,
            cancel,
            shutdown,
        },
        rx,
    )
}

fn send_frame(handle: &RelayHandle) {
    handle.send_message(&DesktopMessage::PtyOutput {
        pane_id: "%58".to_string(),
        data: "ZnJhbWU=".to_string(),
    });
}

#[test]
fn stalled_output_retires_the_socket_without_stopping_reconnects() {
    let (handle, _rx) = connection();
    send_frame(&handle);
    assert!(!handle.cancel.is_cancelled());
    send_frame(&handle);
    assert!(handle.cancel.is_cancelled());
    assert!(!handle.shutdown.is_cancelled());
}

#[test]
fn closed_output_queue_also_allows_reconnection() {
    let (handle, rx) = connection();
    drop(rx);
    send_frame(&handle);
    assert!(handle.cancel.is_cancelled());
    assert!(!handle.shutdown.is_cancelled());
}

#[test]
fn backpressure_from_busy_response_does_not_sign_out_the_host() {
    let (handle, _rx) = connection();
    send_frame(&handle);
    reject_busy_request(r#"{"id":"retry"}"#, &handle.tx, &handle.cancel);
    assert!(handle.cancel.is_cancelled());
    assert!(!handle.shutdown.is_cancelled());
}

#[test]
fn explicit_disconnect_stops_both_the_socket_and_reconnect_loop() {
    let (handle, _rx) = connection();
    handle.disconnect();
    assert!(handle.cancel.is_cancelled());
    assert!(handle.shutdown.is_cancelled());
}
