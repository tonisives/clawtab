use super::{
    screen::Screen, store, Control, Launch, Request, Response, SessionInfo, Size, Snapshot, Status,
    LEASE_SECONDS, PROTOCOL_VERSION,
};
use crate::local_transport;
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

struct LocalViewer {
    size: Size,
    origin: bool,
}
struct Input {
    data: Vec<u8>,
    authority: Option<(Option<String>, u64)>,
}
struct State {
    info: SessionInfo,
    screen: Screen,
    revision: u64,
    output_revision: u64,
    control: Control,
    renewed: Instant,
    local: HashMap<String, LocalViewer>,
    desktop_size: Size,
    origin_seen: bool,
    launched: Instant,
    watchers: usize,
    master: Box<dyn MasterPty + Send>,
    writer: std::sync::mpsc::SyncSender<Input>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

impl State {
    fn session_info(&self) -> SessionInfo {
        let mut info = self.info.clone();
        if let Some(title) = &self.screen.title {
            info.launch.metadata.insert("title".into(), title.clone());
        }
        info
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            size: self.screen.size,
            ansi: self.screen.frame(),
            text: self
                .screen
                .capture(false, false, u32::from(self.screen.size.rows)),
            cursor_row: self.screen.cursor_row(),
            input_modes: self.screen.input_modes(),
            output_revision: self.output_revision,
            control: self.control.clone(),
            status: self.info.status.clone(),
            local_attached: !self.local.is_empty(),
        }
    }
    fn resize(&mut self, size: Size) -> Result<(), String> {
        let size = Size::new(size.cols, size.rows);
        if self.screen.size != size {
            self.master
                .resize(pty_size(size))
                .map_err(|e| e.to_string())?;
            self.screen.resize(size);
            self.revision += 1;
        }
        Ok(())
    }
    fn reclaim(&mut self) -> Result<(), String> {
        self.control.holder = None;
        self.control.epoch += 1;
        self.revision += 1;
        self.resize(self.desktop_size)
    }
    fn check_control(&self, holder: &str, epoch: u64) -> Result<(), String> {
        if self.control.holder.as_deref() != Some(holder)
            || self.control.epoch != epoch
            || self.renewed.elapsed() >= Duration::from_secs(LEASE_SECONDS)
        {
            return Err("terminal control changed; take control again".into());
        }
        Ok(())
    }
    fn input(
        &mut self,
        data: &[u8],
        authority: Option<(Option<String>, u64)>,
    ) -> Result<(), String> {
        if self.info.status != Status::Running {
            return Err("execution has ended".into());
        }
        if data.len() > 1024 * 1024 {
            return Err("input is too large".into());
        }
        self.writer
            .try_send(Input {
                data: data.to_vec(),
                authority,
            })
            .map_err(|_| "agent input is busy; retry after it consumes pending input".into())
    }
    fn stop(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        if let Some(pid) = self.master.process_group_leader().filter(|pid| *pid > 1) {
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
        }
        let result = self.killer.kill();
        #[cfg(unix)]
        return result.map_err(|e| e.to_string());
        // portable-pty 0.8 reports an error on a successful TerminateProcess.
        #[cfg(windows)]
        {
            let _ = result;
            Ok(())
        }
    }
    fn detach(&mut self, viewer: &str, explicit: bool) {
        if let Some(local) = self.local.remove(viewer) {
            if local.origin && self.info.launch.close_with_terminal && !explicit {
                let _ = self.stop();
            }
            self.revision += 1;
        }
    }
    fn handle(
        &mut self,
        request: Request,
        viewer: &mut Option<String>,
    ) -> Result<Response, String> {
        if self.control.holder.is_some()
            && self.renewed.elapsed() >= Duration::from_secs(LEASE_SECONDS)
        {
            self.reclaim()?;
        }
        match request {
            Request::Hello { version } => {
                if version != PROTOCOL_VERSION {
                    return Err(
                        "launcher protocol is incompatible; update after this session ends".into(),
                    );
                }
                Ok(Response::Info {
                    session: self.session_info(),
                })
            }
            Request::Info => Ok(Response::Info {
                session: self.session_info(),
            }),
            Request::Watch => Err("watch must be established on its own connection".into()),
            Request::Snapshot { after } => {
                if after == Some(self.revision) {
                    Ok(Response::Unchanged)
                } else {
                    let mut snapshot = self.snapshot();
                    if let Some(local) = viewer.as_ref().and_then(|id| self.local.get(id)) {
                        snapshot.ansi = self.screen.frame_viewport(local.size);
                    }
                    Ok(Response::Snapshot { snapshot })
                }
            }
            Request::Capture {
                history,
                ansi,
                lines,
            } => Ok(Response::Capture {
                content: self.screen.capture(history, ansi, lines),
            }),
            request @ (Request::Attach { .. }
            | Request::Detach
            | Request::LocalInput { .. }
            | Request::LocalResize { .. }) => self.local_request(request, viewer),
            request @ (Request::TakeControl { .. }
            | Request::RenewControl { .. }
            | Request::ReleaseControl { .. }
            | Request::RemoteInput { .. }
            | Request::RemoteResize { .. }) => self.remote_request(request),
            Request::AutomationInput { data } => {
                self.input(&data, None)?;
                Ok(Response::Ok)
            }
            Request::Metadata {
                values,
                conversation_id,
            } => {
                if values.len() > 100
                    || values.iter().any(|(k, v)| k.len() > 256 || v.len() > 65536)
                {
                    return Err("session metadata is too large".into());
                }
                if values
                    .iter()
                    .all(|(key, value)| self.info.launch.metadata.get(key) == Some(value))
                    && (conversation_id.is_none()
                        || self.info.launch.conversation_id == conversation_id)
                {
                    return Ok(Response::Ok);
                }
                self.info.launch.metadata.extend(values);
                if conversation_id.is_some() {
                    self.info.launch.conversation_id = conversation_id;
                }
                store::save_info(&self.info)?;
                Ok(Response::Ok)
            }
            Request::Stop => {
                self.stop()?;
                Ok(Response::Ok)
            }
        }
    }
    fn local_request(
        &mut self,
        request: Request,
        viewer: &mut Option<String>,
    ) -> Result<Response, String> {
        match request {
            Request::Attach {
                viewer: id,
                size,
                origin,
            } => {
                if viewer.is_some() {
                    return Err("viewer already attached".into());
                }
                self.origin_seen |= origin;
                self.local.insert(id.clone(), LocalViewer { size, origin });
                *viewer = Some(id);
                self.desktop_size = size;
                if self.control.holder.is_none() {
                    self.resize(size)?;
                }
                self.revision += 1;
                Ok(Response::Ok)
            }
            Request::Detach => {
                if let Some(id) = viewer.take() {
                    self.detach(&id, true);
                }
                Ok(Response::Ok)
            }
            Request::LocalInput { data } => {
                let id = viewer.as_deref().ok_or("local viewer is not attached")?;
                self.desktop_size = self.local.get(id).ok_or("viewer is gone")?.size;
                if self.control.holder.is_some() {
                    self.reclaim()?;
                    return Ok(Response::Reclaimed);
                }
                self.input(&data, Some((None, self.control.epoch)))?;
                Ok(Response::Ok)
            }
            Request::LocalResize { size } => {
                let id = viewer.as_deref().ok_or("local viewer is not attached")?;
                self.local.get_mut(id).ok_or("viewer is gone")?.size = size;
                self.desktop_size = size;
                if self.control.holder.is_none() {
                    self.resize(size)?;
                }
                Ok(Response::Ok)
            }
            _ => Err("expected a local viewer request".into()),
        }
    }
    fn remote_request(&mut self, request: Request) -> Result<Response, String> {
        match request {
            Request::TakeControl { holder, size } => {
                self.resize(size)?;
                self.control.epoch += 1;
                self.control.holder = Some(holder);
                self.renewed = Instant::now();
                self.revision += 1;
                Ok(Response::Control {
                    control: self.control.clone(),
                })
            }
            Request::RenewControl { holder, epoch } => {
                self.check_control(&holder, epoch)?;
                self.renewed = Instant::now();
                Ok(Response::Ok)
            }
            Request::ReleaseControl { holder, epoch } => {
                self.check_control(&holder, epoch)?;
                self.reclaim()?;
                Ok(Response::Control {
                    control: self.control.clone(),
                })
            }
            Request::RemoteInput {
                holder,
                epoch,
                data,
            } => {
                self.check_control(&holder, epoch)?;
                self.input(&data, Some((Some(holder), epoch)))?;
                Ok(Response::Ok)
            }
            Request::RemoteResize {
                holder,
                epoch,
                size,
            } => {
                self.check_control(&holder, epoch)?;
                self.resize(size)?;
                Ok(Response::Ok)
            }
            _ => Err("expected a remote control request".into()),
        }
    }
}

fn pty_size(size: Size) -> PtySize {
    PtySize {
        cols: size.cols,
        rows: size.rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub(super) fn serve(id: &str, launch: Launch) -> Result<(), String> {
    #[cfg(windows)]
    let _job = windows_job::OwnerJob::enter()?;
    let directory = store::directory(id)?;
    local_transport::private_directory(&directory)?;
    let _lock = lock_directory(&directory)?;
    let endpoint = store::endpoint(id)?;
    #[cfg(unix)]
    if endpoint.exists() {
        std::fs::remove_file(&endpoint).map_err(|e| e.to_string())?;
    }
    let listener = local_transport::listen(&endpoint).map_err(|e| e.to_string())?;
    let size = Size::new(launch.size.cols, launch.size.rows);
    store::save(&directory.join("startup.json"), &"opening terminal")?;
    let pair = portable_pty::native_pty_system()
        .openpty(pty_size(size))
        .map_err(|e| e.to_string())?;
    let command = command(id, &launch)?;
    store::save(&directory.join("startup.json"), &"starting command")?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (input_tx, input_rx) = std::sync::mpsc::sync_channel::<Input>(64);
    let info = SessionInfo {
        id: id.into(),
        execution_id: uuid::Uuid::new_v4().to_string(),
        protocol_version: PROTOCOL_VERSION,
        launcher_version: env!("CARGO_PKG_VERSION").into(),
        owner_pid: std::process::id(),
        child_pid: child.process_id().unwrap_or_default(),
        started_at: super::now(),
        launch,
        status: Status::Running,
        exit_code: None,
    };
    let state = Arc::new(Mutex::new(State {
        desktop_size: size,
        origin_seen: false,
        launched: Instant::now(),
        watchers: 0,
        info,
        screen: Screen::new(size),
        revision: 1,
        output_revision: 0,
        control: Control {
            epoch: 0,
            holder: None,
        },
        renewed: Instant::now(),
        local: HashMap::new(),
        master: pair.master,
        writer: input_tx,
        killer: child.clone_killer(),
    }));
    let drained = spawn_io(&state, reader, writer, input_rx);
    let accept_state = Arc::clone(&state);
    std::thread::spawn(move || {
        while let Ok(stream) = local_transport::accept(&listener) {
            let state = Arc::clone(&accept_state);
            std::thread::spawn(move || connection(stream, state));
        }
    });
    store::save_info(&state.lock().info)?;
    let _ = std::fs::remove_file(directory.join("startup.json"));
    await_exit(&state, child, &drained, &directory)?;
    #[cfg(unix)]
    let _ = std::fs::remove_file(endpoint);
    Ok(())
}

fn lock_directory(directory: &std::path::Path) -> Result<std::fs::File, String> {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("owner.lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| "session already has an owner")?;
    Ok(lock)
}

fn await_exit(
    state: &Arc<Mutex<State>>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    drained: &AtomicBool,
    directory: &std::path::Path,
) -> Result<(), String> {
    let exit = loop {
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            break exit;
        }
        {
            let mut state = state.lock();
            if state.info.launch.close_with_terminal
                && !state.origin_seen
                && state.launched.elapsed() >= Duration::from_secs(10)
            {
                let _ = state.stop();
            }
            if state.control.holder.is_some()
                && state.renewed.elapsed() >= Duration::from_secs(LEASE_SECONDS)
            {
                let _ = state.reclaim();
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    while !drained.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    {
        let mut state = state.lock();
        state.info.status = Status::Exited;
        state.info.exit_code = Some(exit.exit_code());
        state.revision += 1;
        store::save(&directory.join("screen.json"), &state.snapshot())?;
        store::save(
            &directory.join("history.json"),
            &state.screen.capture(true, false, 10300),
        )?;
        store::save_info(&state.info)?;
    }
    // Give attached viewers time to observe the final screen and exit status.
    std::thread::sleep(Duration::from_millis(150));
    Ok(())
}

fn spawn_io(
    state: &Arc<Mutex<State>>,
    mut reader: Box<dyn Read + Send>,
    mut writer: Box<dyn Write + Send>,
    input_rx: std::sync::mpsc::Receiver<Input>,
) -> Arc<AtomicBool> {
    let write_state = Arc::downgrade(state);
    std::thread::spawn(move || {
        while let Ok(input) = input_rx.recv() {
            if let Some((holder, epoch)) = input.authority {
                if write_state.upgrade().is_none_or(|state| {
                    let state = state.lock();
                    state.control.holder != holder
                        || state.control.epoch != epoch
                        || (holder.is_some()
                            && state.renewed.elapsed() >= Duration::from_secs(LEASE_SECONDS))
                }) {
                    continue;
                }
            }
            if writer
                .write_all(&input.data)
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let read_state = Arc::clone(state);
    let drained = Arc::new(AtomicBool::new(false));
    let reader_drained = Arc::clone(&drained);
    std::thread::spawn(move || {
        let mut buffer = [0; 32768];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let mut state = read_state.lock();
            let replies = state.screen.process(&buffer[..count]);
            if !replies.is_empty() {
                let _ = state.writer.try_send(Input {
                    data: replies,
                    authority: None,
                });
            }
            state.revision += 1;
            state.output_revision += 1;
        }
        reader_drained.store(true, Ordering::Release);
    });
    drained
}

fn command(id: &str, launch: &Launch) -> Result<CommandBuilder, String> {
    let mut command = program_command(id, launch)?;
    #[cfg(windows)]
    for (key, value) in std::env::vars_os() {
        // portable-pty refreshes registry values, but the launcher's PATH and
        // explicit job environment must take precedence over those defaults.
        command.env(key, value);
    }
    command.cwd(&launch.cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("CLAWTAB_SESSION_ID", id);
    command.env_remove("TMUX");
    command.env_remove("TMUX_PANE");
    Ok(command)
}

fn program_command(_id: &str, launch: &Launch) -> Result<CommandBuilder, String> {
    #[cfg(windows)]
    {
        let program = which::which_in(&launch.program, std::env::var_os("PATH"), &launch.cwd)
            .map_err(|e| e.to_string())?;
        if program
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        {
            store::save(&store::directory(_id)?.join("command.json"), launch)?;
            let mut command =
                CommandBuilder::new(std::env::current_exe().map_err(|e| e.to_string())?);
            command.args(["session", "_exec", _id]);
            return Ok(command);
        }
    }
    let mut command = CommandBuilder::new(&launch.program);
    command.args(&launch.args);
    Ok(command)
}

fn connection(mut stream: local_transport::Stream, state: Arc<Mutex<State>>) {
    let mut viewer = None;
    let mut watching = false;
    while let Ok(request) = super::client::read_message::<Request>(&mut stream) {
        if matches!(request, Request::Watch) {
            if !watching {
                state.lock().watchers += 1;
                watching = true;
            }
            if super::client::write_message(&mut stream, &Response::Ok).is_err() {
                break;
            }
            continue;
        }
        let response = state
            .lock()
            .handle(request, &mut viewer)
            .unwrap_or_else(|message| Response::Error { message });
        if super::client::write_message(&mut stream, &response).is_err() {
            break;
        }
    }
    if let Some(viewer) = viewer {
        state.lock().detach(&viewer, false);
    }
    if watching {
        let mut state = state.lock();
        state.watchers = state.watchers.saturating_sub(1);
        if state.watchers == 0 && state.control.holder.is_some() {
            let _ = state.reclaim();
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::GetCurrentProcess,
        },
    };
    pub struct OwnerJob(HANDLE);
    impl OwnerJob {
        pub fn enter() -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(handle, GetCurrentProcess()) } == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            // Enter before spawning: every descendant inherits this job. The
            // daemon is outside it, so a daemon restart leaves the owner alive.
            Ok(job)
        }
    }
    impl Drop for OwnerJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
