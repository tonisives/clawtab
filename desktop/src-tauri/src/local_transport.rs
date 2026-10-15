//! Local IPC with filesystem ownership on Unix and current-user named pipes on Windows.
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

pub fn private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err("unsafe private directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("private directory belongs to another user".into());
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    windows::protect(path)?;
    Ok(())
}

pub fn private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    open_private(path, &mut options).map_err(|e| e.to_string())
}

pub fn open_private(path: &Path, options: &mut OpenOptions) -> std::io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
        windows::protect(path).map_err(std::io::Error::other)?;
    }
    Ok(file)
}

pub fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::rename(source, destination)?;
        if let Some(parent) = destination.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

pub fn pipe_name(path: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        path.to_owned()
    }
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(path.to_string_lossy().as_bytes());
        PathBuf::from(format!(r"\\.\pipe\clawtab-{:x}", hash))
    }
}

pub trait AsyncConnection: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> AsyncConnection for T {}
pub type AsyncStream = Box<dyn AsyncConnection>;
pub type AsyncReadHalf = tokio::io::ReadHalf<AsyncStream>;
pub type AsyncWriteHalf = tokio::io::WriteHalf<AsyncStream>;

#[cfg(unix)]
pub struct AsyncListener(tokio::net::UnixListener);
#[cfg(windows)]
pub struct AsyncListener {
    path: PathBuf,
    pending: tokio::sync::Mutex<tokio::net::windows::named_pipe::NamedPipeServer>,
}

pub async fn connect_async(path: &Path) -> std::io::Result<AsyncStream> {
    #[cfg(unix)]
    {
        Ok(Box::new(tokio::net::UnixStream::connect(path).await?))
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        for _ in 0..100 {
            match ClientOptions::new().open(pipe_name(path)) {
                Ok(stream) => return Ok(Box::new(stream)),
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "local pipe busy",
        ))
    }
}

impl AsyncListener {
    pub fn bind(path: &Path) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let listener = tokio::net::UnixListener::bind(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            Ok(Self(listener))
        }
        #[cfg(windows)]
        {
            Ok(Self {
                path: path.into(),
                pending: tokio::sync::Mutex::new(Self::pipe(path, true)?),
            })
        }
    }
    #[cfg(windows)]
    fn pipe(
        path: &Path,
        first: bool,
    ) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        let security = windows::Security::new()?;
        let mut attributes = security.attributes();
        unsafe {
            tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    pipe_name(path),
                    (&mut attributes as *mut windows_sys::Win32::Security::SECURITY_ATTRIBUTES)
                        .cast(),
                )
        }
    }
    pub async fn accept(&self) -> std::io::Result<(AsyncStream, ())> {
        #[cfg(unix)]
        {
            let (stream, _) = self.0.accept().await?;
            if !stream.peer_cred()?.uid().eq(&unsafe { libc::geteuid() }) {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            Ok((Box::new(stream), ()))
        }
        #[cfg(windows)]
        {
            let mut pending = self.pending.lock().await;
            pending.connect().await?;
            let next = Self::pipe(&self.path, false)?;
            Ok((Box::new(std::mem::replace(&mut *pending, next)), ()))
        }
    }
}

#[cfg(unix)]
pub type Stream = std::os::unix::net::UnixStream;
#[cfg(unix)]
pub type Listener = std::os::unix::net::UnixListener;

#[cfg(unix)]
pub fn connect(path: &Path) -> std::io::Result<Stream> {
    let stream = Stream::connect(path)?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
    Ok(stream)
}

#[cfg(unix)]
pub fn listen(path: &Path) -> std::io::Result<Listener> {
    use std::os::unix::fs::PermissionsExt;
    let listener = Listener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

#[cfg(unix)]
pub fn accept(listener: &Listener) -> std::io::Result<Stream> {
    let (stream, _) = listener.accept()?;
    Ok(stream)
}

#[cfg(windows)]
pub use windows::{accept, connect, listen, Listener, Stream};

#[cfg(windows)]
pub mod windows {
    use super::*;
    use std::io;
    use std::os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    };
    use windows_sys::Win32::{
        Foundation::{LocalFree, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
                SE_FILE_OBJECT,
            },
            GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX},
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, SetNamedPipeHandleState, PIPE_NOWAIT,
            PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        },
    };

    pub struct Stream {
        file: File,
        nonblocking: bool,
    }
    impl io::Read for Stream {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match io::Read::read(&mut self.file, buffer) {
                    Err(error) if self.nonblocking && error.raw_os_error() == Some(232) => {
                        if std::time::Instant::now() >= deadline {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "session owner did not respond",
                            ));
                        }
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                    result => return result,
                }
            }
        }
    }
    impl io::Write for Stream {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            io::Write::write(&mut self.file, buffer)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    pub struct Listener {
        path: PathBuf,
        next: parking_lot::Mutex<File>,
    }

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    pub struct Security {
        descriptor: *mut core::ffi::c_void,
    }
    impl Security {
        pub fn new() -> io::Result<Self> {
            // OWNER RIGHTS binds access to the creating user, not every authenticated user.
            let sddl = wide(std::ffi::OsStr::new("D:P(A;;GA;;;OW)(A;;GA;;;SY)"));
            let mut descriptor = std::ptr::null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { descriptor })
        }
        pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
            SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.descriptor,
                bInheritHandle: 0,
            }
        }
    }
    impl Drop for Security {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.descriptor);
            }
        }
    }

    pub fn protect(path: &Path) -> Result<(), String> {
        let security = Security::new().map_err(|e| e.to_string())?;
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = std::ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(security.descriptor, &mut present, &mut acl, &mut defaulted)
        } == 0
        {
            return Err(io::Error::last_os_error().to_string());
        }
        let name = wide(path.as_os_str());
        let status = unsafe {
            SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32).to_string());
        }
        Ok(())
    }

    fn new_pipe(path: &Path, first: bool) -> io::Result<File> {
        let name = wide(pipe_name(path).as_os_str());
        let security = Security::new()?;
        let attributes = security.attributes();
        let flags = PIPE_ACCESS_DUPLEX
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                flags,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                65536,
                65536,
                5000,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    pub fn listen(path: &Path) -> io::Result<Listener> {
        Ok(Listener {
            path: path.into(),
            next: parking_lot::Mutex::new(new_pipe(path, true)?),
        })
    }
    pub fn accept(listener: &Listener) -> io::Result<Stream> {
        let mut pending = listener.next.lock();
        let result = unsafe { ConnectNamedPipe(pending.as_raw_handle(), std::ptr::null_mut()) };
        if result == 0
            && io::Error::last_os_error().raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32)
        {
            return Err(io::Error::last_os_error());
        }
        let next = new_pipe(&listener.path, false)?;
        Ok(Stream {
            file: std::mem::replace(&mut *pending, next),
            nonblocking: false,
        })
    }
    pub fn connect(path: &Path) -> io::Result<Stream> {
        let name = pipe_name(path);
        for _ in 0..100 {
            match OpenOptions::new().read(true).write(true).open(&name) {
                Ok(file) => {
                    // Bound RPC reads even if the owner is paused or a PTY
                    // resize stalls. Async daemon pipes use Tokio instead.
                    let mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
                    if unsafe {
                        SetNamedPipeHandleState(
                            file.as_raw_handle(),
                            &mode,
                            std::ptr::null(),
                            std::ptr::null(),
                        )
                    } == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    return Ok(Stream {
                        file,
                        nonblocking: true,
                    });
                }
                Err(error) if error.raw_os_error() == Some(231) => {
                    std::thread::sleep(std::time::Duration::from_millis(20))
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(io::ErrorKind::TimedOut, "local pipe busy"))
    }
}
