use super::{emit, OutputSink, SpawnResult};
use crate::managed::{self, Client, Request, Response, Size, Status};
use parking_lot::Mutex;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

static GENERATION: AtomicU64 = AtomicU64::new(1);

pub(super) struct Viewer {
    client: Arc<Mutex<Client>>,
    stop: Arc<AtomicBool>,
    refresh: Arc<AtomicBool>,
    pub generation: u64,
    local: bool,
}

impl Viewer {
    pub fn spawn(
        id: &str,
        cols: u16,
        rows: u16,
        sink: OutputSink,
    ) -> Result<(Self, SpawnResult), String> {
        let initial = crate::terminal_backend::snapshot(id)?;
        let mut client = managed::connect(id)?;
        let local = match &sink {
            #[cfg(feature = "desktop")]
            OutputSink::Tauri(_) => true,
            _ => false,
        };
        if local {
            client.request(Request::Attach {
                viewer: uuid::Uuid::new_v4().to_string(),
                size: Size::new(cols, rows),
                origin: false,
            })?;
        } else {
            client.request(Request::Watch)?;
        }
        let client = Arc::new(Mutex::new(client));
        let stop = Arc::new(AtomicBool::new(false));
        let refresh = Arc::new(AtomicBool::new(false));
        let viewer = Self {
            client: Arc::clone(&client),
            stop: Arc::clone(&stop),
            refresh: Arc::clone(&refresh),
            generation: GENERATION.fetch_add(1, Ordering::Relaxed),
            local,
        };
        let result = SpawnResult {
            native_cols: initial.size.cols,
            native_rows: initial.size.rows,
            attach_generation: viewer.generation,
        };
        let id = id.to_owned();
        std::thread::spawn(move || {
            let mut after = None;
            let mut control = None;
            let mut dimensions = None;
            while !stop.load(Ordering::Relaxed) {
                if refresh.swap(false, Ordering::Relaxed) {
                    after = None;
                }
                let response = client.lock().request(Request::Snapshot { after });
                match response {
                    Ok(Response::Snapshot { snapshot }) => {
                        if after.is_none()
                            || control.as_ref() != Some(&snapshot.control)
                            || dimensions != Some(snapshot.size)
                        {
                            emit::emit_control(&sink, &id, &snapshot);
                            control = Some(snapshot.control.clone());
                        }
                        let mut bytes = Vec::new();
                        if dimensions != Some(snapshot.size) {
                            bytes.extend_from_slice(b"\x1b[2J");
                            dimensions = Some(snapshot.size);
                        }
                        bytes.extend_from_slice(snapshot.ansi.as_bytes());
                        emit::emit_bytes(&sink, &id, bytes);
                        after = Some(snapshot.revision);
                        if snapshot.status != Status::Running {
                            break;
                        }
                    }
                    Ok(Response::Unchanged) => {}
                    _ => break,
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            if local {
                let _ = client.lock().request(Request::Detach);
            }
            if !stop.load(Ordering::Relaxed) {
                emit::emit_exit(&sink, &id);
            }
        });
        Ok((viewer, result))
    }
    pub fn write(&self, bytes: &[u8]) -> Result<(), String> {
        if !self.local {
            return Err("managed remote input requires a control epoch".into());
        }
        self.client
            .lock()
            .request(Request::LocalInput {
                data: bytes.to_vec(),
            })
            .map(|_| ())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if !self.local {
            return Err("managed remote resize requires a control epoch".into());
        }
        self.client
            .lock()
            .request(Request::LocalResize {
                size: Size::new(cols, rows),
            })
            .map(|_| ())
    }
    pub fn refresh(&self) {
        self.refresh.store(true, Ordering::Relaxed);
    }
}
impl Drop for Viewer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
