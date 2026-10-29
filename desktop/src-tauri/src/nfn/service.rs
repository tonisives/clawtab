use super::{native, settings, store::Store, templates, types::*};
mod delivery;
use crate::{
    ipc::{self, EventSubscribers, IpcEvent},
    job_context::JobContext,
};
use clawtab_protocol::ClaudeQuestion;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

pub fn service() -> Option<&'static Arc<Service>> {
    SERVICE.get()
}

pub struct Service {
    store: Store,
    ctx: JobContext,
    questions: Arc<Mutex<Vec<ClaudeQuestion>>>,
    subscribers: EventSubscribers,
    platform: Mutex<PlatformState>,
    viewed: Mutex<HashMap<String, (Option<String>, i64)>>,
    mutation: tokio::sync::Mutex<()>,
    template_changes: Arc<tokio::sync::Notify>,
    seen_questions: Mutex<HashSet<String>>,
    seen_alerts: Mutex<HashMap<String, String>>,
    questions_ready: AtomicBool,
}

pub fn initialize(
    ctx: JobContext,
    questions: Arc<Mutex<Vec<ClaudeQuestion>>>,
    subscribers: EventSubscribers,
) -> Result<Arc<Service>, String> {
    let path = crate::config::config_dir()
        .ok_or("Could not determine ClawTab config directory")?
        .join("notifications.sqlite");
    let service = Arc::new(Service {
        store: Store::open(&path)?,
        ctx,
        questions,
        subscribers,
        platform: Default::default(),
        viewed: Default::default(),
        mutation: Default::default(),
        template_changes: Arc::new(tokio::sync::Notify::new()),
        seen_questions: Default::default(),
        seen_alerts: Default::default(),
        questions_ready: AtomicBool::new(false),
    });
    service.recover_job_sessions();
    SERVICE
        .set(service.clone())
        .map_err(|_| "Notifications already initialized")?;
    Ok(service)
}

pub fn viewed_pane(pane_id: &str) -> bool {
    service().is_some_and(|s| s.is_viewed(pane_id))
}

impl Service {
    fn recover_job_sessions(&self) {
        let mut offset = 0;
        loop {
            let Ok(records) = self.store.list(offset) else {
                break;
            };
            if records.is_empty() {
                break;
            }
            offset += records.len();
            for mut record in records {
                if !job_notice(&record) || record.request.source.session_id.is_some() {
                    continue;
                }
                let Some(run_id) = record.request.source.run_id.as_deref() else {
                    continue;
                };
                let source = {
                    let history = self.ctx.history.lock();
                    let Ok(Some(run)) = history.get_by_id_bounded(run_id, 1) else {
                        continue;
                    };
                    job_source_from_history(&history, &run)
                };
                if attach_job_session(&mut record, source) {
                    if let Err(error) = self.store.save(&mut record) {
                        log::warn!("[nfn] Could not recover job session: {error}");
                    }
                }
            }
        }
    }

    pub async fn run(self: Arc<Self>) {
        use notify::Watcher;
        {
            let mut settings = self.ctx.settings.lock();
            match super::settings::ensure(&settings.enhanced_notifications) {
                Ok(value) => settings.enhanced_notifications = value,
                Err(error) => log::warn!("[nfn] Could not initialize notifications.yaml: {error}"),
            }
        }
        let _ = std::fs::create_dir_all(templates::directory());
        let changes = self.template_changes.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if event.is_ok() {
                    changes.notify_one();
                }
            })
            .ok();
        if let Some(watcher) = watcher.as_mut() {
            let _ = watcher.watch(&templates::directory(), notify::RecursiveMode::NonRecursive);
        }
        let mut ticks = 0_u32;
        let mut auto_yes_panes = self.ctx.auto_yes_panes.lock().clone();
        let mut settings_error = None;
        let mut last_todos = Value::Null;
        loop {
            tokio::select! {
                () = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                () = self.template_changes.notified() => { self.push(None, false); },
            }
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(3) {
                let todos = super::todos::snapshot();
                if todos != last_todos {
                    last_todos = todos.clone();
                    native::push(json!({"type":"todos", "todos":todos}));
                }
            }
            let current_settings = self.ctx.settings.lock().enhanced_notifications.clone();
            match super::settings::load(&current_settings) {
                Ok(value) => {
                    settings_error = None;
                    if value != current_settings {
                        self.ctx.settings.lock().enhanced_notifications = value;
                        self.changed();
                    }
                }
                Err(error) => {
                    if settings_error.as_ref() != Some(&error) {
                        log::warn!("[nfn] Could not reload notifications.yaml: {error}");
                    }
                    settings_error = Some(error);
                }
            }
            // Session discovery must not hold the action lock while checking
            // every pending card. Re-read records after taking the lock below.
            let invalid_sources = if ticks.is_multiple_of(10) {
                let records = self.store.pending().unwrap_or_default();
                tokio::task::spawn_blocking(move || invalid_pending_sources(&records))
                    .await
                    .unwrap_or_default()
            } else {
                HashSet::new()
            };
            let _guard = self.mutation.lock().await;
            let current_auto_yes = self.ctx.auto_yes_panes.lock().clone();
            let mut changed = current_auto_yes != auto_yes_panes;
            auto_yes_panes = current_auto_yes;
            let current: HashSet<String> = self.questions.lock().iter().map(question_key).collect();
            let current_questions = self
                .questions_ready
                .load(Ordering::Relaxed)
                .then_some(&current);
            if let Ok(records) = self.store.pending() {
                for mut record in records {
                    let invalid_source = invalid_sources.contains(&record.id);
                    if !refresh_pending_record(
                        &mut record,
                        current_questions,
                        &auto_yes_panes,
                        now(),
                        |_| !invalid_source,
                    ) {
                        continue;
                    }
                    if let Err(error) = self.store.save(&mut record) {
                        log::warn!("[nfn] {error}");
                        continue;
                    }
                    changed = true;
                }
            }
            if changed {
                self.changed();
            }
            drop(_guard);
            self.dispatch_pending();
        }
    }

    pub fn sync_questions(&self, questions: &[ClaudeQuestion]) {
        self.questions_ready.store(true, Ordering::Relaxed);
        let Ok(_guard) = self.mutation.try_lock() else {
            return;
        };
        let current: HashSet<String> = questions.iter().map(question_key).collect();
        let auto_yes_panes = self.ctx.auto_yes_panes.lock().clone();
        let mut changed = self.refresh_questions(Some(&current), &auto_yes_panes);
        let mut seen = self.seen_questions.lock();
        seen.retain(|id| current.contains(id));
        for question in questions {
            if auto_yes_panes.contains(&question.pane_id) {
                continue;
            }
            let key = question_key(question);
            if !seen.insert(key.clone()) {
                continue;
            }
            let request = request_for_question(question, key.clone());
            match self.store.send(request, Some(key.clone())) {
                Ok(_) => changed = true,
                Err(error) => {
                    seen.remove(&key);
                    log::warn!("[nfn] question registration failed: {error}");
                }
            }
        }
        drop(seen);
        if changed {
            self.changed();
        }
    }

    pub fn sync_auto_yes(&self) {
        let Ok(_guard) = self.mutation.try_lock() else {
            return;
        };
        let auto_yes_panes = self.ctx.auto_yes_panes.lock().clone();
        if self.refresh_questions(None, &auto_yes_panes) {
            self.changed();
        }
    }

    fn refresh_questions(
        &self,
        questions: Option<&HashSet<String>>,
        auto_yes_panes: &HashSet<String>,
    ) -> bool {
        let mut changed = false;
        for mut record in self.store.pending().unwrap_or_default() {
            if record.question_id.is_none()
                || !refresh_pending_record(&mut record, questions, auto_yes_panes, now(), |_| true)
            {
                continue;
            }
            match self.store.save(&mut record) {
                Ok(()) => changed = true,
                Err(error) => log::warn!("[nfn] {error}"),
            }
        }
        changed
    }

    pub fn announce_question(&self, question: &ClaudeQuestion) {
        if let Ok(records) = self.store.pending() {
            if let Some(record) = records
                .iter()
                .find(|r| r.question_id.as_ref() == Some(&question_key(question)))
            {
                self.announce(record);
            }
        }
    }

    pub fn sync_alerts(&self, activity: &[crate::ipc::AgentActivity]) {
        // The next activity poll retries without consuming seen alerts while busy.
        let Ok(_guard) = self.mutation.try_lock() else {
            return;
        };
        let result = super::alerts::sync(
            &self.store,
            activity,
            &mut self.seen_alerts.lock(),
            |pane| {
                resolve_source(pane, None).unwrap_or_else(|_| NfnSource {
                    pane_id: Some(pane.into()),
                    ..Default::default()
                })
            },
        );
        match result {
            Ok(changes) => {
                for record in &changes.created {
                    self.announce(record);
                }
                if changes.changed {
                    self.changed();
                }
            }
            Err(error) => log::warn!("[nfn] alert synchronization failed: {error}"),
        }
    }

    pub fn job_notification(&self, slug: &str, event: &str, run_id: Option<&str>) {
        self.job_message(slug, event, run_id, vec!["desktop".into()], None);
    }

    pub fn job_message(
        &self,
        slug: &str,
        event: &str,
        run_id: Option<&str>,
        channels: Vec<String>,
        chat: Option<i64>,
    ) {
        let request = {
            let history = self.ctx.history.lock();
            job_request_from_history(&history, slug, event, run_id)
        };
        self.queue_job_message(request, channels, chat);
    }

    pub(crate) fn job_message_from_history(
        &self,
        history: &crate::history::HistoryStore,
        slug: &str,
        event: &str,
        run_id: &str,
        channels: Vec<String>,
        chat: Option<i64>,
    ) {
        let request = job_request_from_history(history, slug, event, Some(run_id));
        self.queue_job_message(request, channels, chat);
    }

    fn queue_job_message(&self, mut request: NfnRequest, channels: Vec<String>, chat: Option<i64>) {
        request.channels = channels;
        request.telegram_chat_id = chat;
        match self.store.send(request, None) {
            Ok((record, true)) => self.announce(&record),
            Ok(_) => {}
            Err(error) => log::warn!("[nfn] {error}"),
        }
    }

    pub fn agent_completed(&self, expected: &NfnSource) {
        let Some(pane) = expected.pane_id.as_deref() else {
            return;
        };
        let settings = self.ctx.settings.lock().clone();
        if !settings.notify_agent_completion_local && !settings.notify_agent_completion_remote {
            return;
        }
        let Ok(mut source) = resolve_source(pane, None) else {
            return;
        };
        if source.agent_pid != expected.agent_pid
            || source.agent_started_at != expected.agent_started_at
            || expected
                .session_id
                .as_ref()
                .is_some_and(|id| source.session_id.as_ref() != Some(id))
        {
            return;
        }
        source.group = source.group.or_else(|| expected.group.clone());
        match self.store.send(request_for_completion(source), None) {
            Ok((record, true)) => {
                self.announce(&record);
            }
            Ok(_) => {}
            Err(error) => log::warn!("[nfn] agent completion notification failed: {error}"),
        }
    }

    fn announce(&self, record: &NfnRecord) {
        if !record.pending() || record.ignored {
            return;
        }
        let settings = self.ctx.settings.lock().clone();
        let enabled = record.request.channel("desktop") && local_enabled(&settings, record);
        let viewed = record
            .request
            .source
            .pane_id
            .as_deref()
            .is_some_and(|pane| self.is_viewed(pane));
        let route = delivery(
            &settings.enhanced_notifications,
            &self.platform.lock(),
            enabled,
            viewed,
        );
        if route.overlay {
            self.push(Some(&record.id), route.sound);
        }
        if route.native {
            crate::notifications::IpcNotifier::new(self.subscribers.clone()).dispatch_native(
                record.request.title.clone(),
                record.request.body.clone(),
                settings.enhanced_notifications.sound,
            );
        }
        self.broadcast();
        self.dispatch_pending();
    }

    pub fn push(&self, arrival: Option<&str>, sound: bool) {
        let settings = self.ctx.settings.lock();
        let platform = self.platform.lock();
        let pending: Vec<_> = self
            .store
            .pending()
            .unwrap_or_default()
            .into_iter()
            .filter(|record| {
                record.request.channel("desktop")
                    && local_enabled(&settings, record)
                    && record.dismissed_at.is_none()
                    && !record.ignored
            })
            .collect();
        let count = pending.len();
        let mut records: Vec<_> = pending.into_iter().take(50).collect();
        for record in self.store.list(0).unwrap_or_default() {
            if record.request.channel("desktop")
                && local_enabled(&settings, &record)
                && !records.iter().any(|r| r.id == record.id)
            {
                records.push(record);
            }
        }
        let todos = super::todos::snapshot();
        let has_todos = todos["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty());
        let visible = settings.enhanced_notifications.delivery != "native"
            && (!records.is_empty() || has_todos)
            && (settings.enhanced_notifications.focus == "independent"
                || (platform.focused == Some(false) && platform.authorized == Some(true)));
        let auto_yes_panes: Vec<_> = self.ctx.auto_yes_panes.lock().iter().cloned().collect();
        native::push(
            json!({"type":"snapshot", "records":records, "pending_count":count, "arrival":arrival, "sound":sound,
            "settings": settings.enhanced_notifications, "templates":templates::list(), "visible":visible,
            "platform":*platform, "auto_yes_panes":auto_yes_panes, "todos":todos}),
        );
    }

    fn broadcast(&self) {
        if let Some(handle) = self.ctx.relay.lock().as_ref() {
            self.publish_messages(handle);
        }
        let subscribers = self.subscribers.clone();
        tokio::spawn(async move {
            ipc::broadcast_event(&subscribers, &IpcEvent::NfnChanged).await;
        });
    }

    fn changed(&self) {
        self.push(None, false);
        self.broadcast();
    }

    pub fn is_viewed(&self, pane_id: &str) -> bool {
        let platform = self.platform.lock().clone();
        if !platform.user_active {
            return false;
        }
        if self.viewed.lock().iter().any(|(window, (pane, at))| {
            pane.as_deref() == Some(pane_id)
                && now() - at < 35000
                && window.split(':').next().and_then(|pid| pid.parse().ok())
                    == platform.frontmost_pid
        }) {
            return true;
        }
        if let Some(pid) = platform.frontmost_pid {
            return terminal_pane_viewed(pane_id, pid);
        }
        false
    }

    pub async fn execute(&self, command: NfnCommand) -> Result<Value, String> {
        let operation = match &command {
            NfnCommand::Focus { .. } => Some("focus"),
            NfnCommand::AutoYes { .. } => Some("auto_yes"),
            NfnCommand::Respond { .. } => Some("respond"),
            _ => None,
        };
        let started = std::time::Instant::now();
        let result = self.execute_inner(command).await;
        if let Some(operation) = operation {
            log::info!(
                "[nfn] {operation} {} in {} ms",
                if result.is_ok() {
                    "completed"
                } else {
                    "failed"
                },
                started.elapsed().as_millis()
            );
        }
        result
    }

    async fn refresh_todo_agents(&self) -> Result<Value, String> {
        let live = tokio::task::spawn_blocking(super::todos::live_agents)
            .await
            .map_err(|error| error.to_string())??;
        let value = {
            let _guard = self.mutation.lock().await;
            super::todos::refresh(&live)?
        };
        self.changed();
        Ok(value)
    }

    async fn execute_inner(&self, command: NfnCommand) -> Result<Value, String> {
        match command {
            NfnCommand::Todos => return Ok(super::todos::snapshot()),
            NfnCommand::TodoRefresh => {
                return self.refresh_todo_agents().await;
            }
            NfnCommand::TodoLink { note, agents } => {
                let _guard = self.mutation.lock().await;
                let value = super::todos::link(note, agents)?;
                self.changed();
                return Ok(value);
            }
            NfnCommand::TodoAdd { text, group } => {
                let _guard = self.mutation.lock().await;
                let value = super::todos::add(&text, &group)?;
                self.changed();
                return Ok(value);
            }
            NfnCommand::TodoUpdate { id, checked } => {
                let _guard = self.mutation.lock().await;
                let value = super::todos::update(&id, checked)?;
                self.changed();
                return Ok(value);
            }
            NfnCommand::TodoStart { id, cwd } => {
                let _guard = self.mutation.lock().await;
                let value = super::todos::start(&id, &cwd)?;
                self.changed();
                return Ok(value);
            }
            NfnCommand::TodoFocus { id } => {
                self.refresh_todo_agents().await?;
                let agent = super::todos::agent(&id)?;
                if agent["connected"] == false {
                    return Err(
                        "Agent not found. Reopen the same conversation, then refresh agents."
                            .into(),
                    );
                }
                let pane = agent["pane"].as_str().ok_or("Agent has no tmux pane")?;
                let window = tmux(&["display-message", "-p", "-t", pane, "#{window_id}"])?;
                if agent["window_id"]
                    .as_str()
                    .is_some_and(|expected| expected != window)
                {
                    return Err("The linked agent window has closed".into());
                }
                let source = resolve_source(pane, None)?;
                if agent["thread"]
                    .as_str()
                    .is_some_and(|thread| source.session_id.as_deref() != Some(thread))
                {
                    return Err(
                        "The agent changed during refresh. Refresh agents and try again.".into(),
                    );
                }
                focus_source(&source).await?;
                return Ok(json!({"focused":true}));
            }
            NfnCommand::Get { id } => {
                return serde_json::to_value(self.store.get(&id)?).map_err(|e| e.to_string())
            }
            NfnCommand::List {
                offset,
                pending_only,
                query,
            } => {
                return Ok(
                    json!({"records":self.store.search(offset, pending_only, &query)?,"offset":offset,"next_offset":offset+50}),
                )
            }
            NfnCommand::Templates => return Ok(templates::list()),
            NfnCommand::IgnoredAgents => return Ok(json!({"agents":self.store.ignored_agents()?})),
            NfnCommand::Info => {
                let auto_yes_panes: Vec<_> =
                    self.ctx.auto_yes_panes.lock().iter().cloned().collect();
                return Ok(
                    json!({"records":self.store.pending_page(0)?,"pending_count":self.store.pending_count()?,"settings":self.ctx.settings.lock().enhanced_notifications,"platform":*self.platform.lock(),"templates":templates::list(),"auto_yes_panes":auto_yes_panes}),
                );
            }
            NfnCommand::Validate { yaml } => {
                return Ok(json!({"template": templates::parse(&yaml)?}))
            }
            NfnCommand::SaveTemplate { yaml } => {
                let template = templates::save(&yaml)?;
                self.changed();
                return Ok(json!({"template": template}));
            }
            NfnCommand::Context { id } => return self.context(&id).await,
            NfnCommand::Platform { state } => {
                *self.platform.lock() = state;
                self.push(None, false);
                self.dispatch_pending();
                return Ok(json!({}));
            }
            NfnCommand::ViewedPane { pane_id, window_id } => {
                let mut viewed = self.viewed.lock();
                viewed.retain(|_, (_, at)| now() - *at < 35000);
                if pane_id.is_some() {
                    let pid = window_id.split(':').next().unwrap_or("");
                    viewed.retain(|key, _| key.split(':').next() != Some(pid));
                }
                viewed.insert(window_id, (pane_id, now()));
                return Ok(json!({}));
            }
            NfnCommand::Show => {
                self.push(None, false);
                native::push(json!({"type":"show"}));
                return Ok(json!({}));
            }
            NfnCommand::Settings => {
                if cfg!(target_os = "macos") {
                    self.push(None, false);
                    native::push(json!({"type":"settings"}));
                } else {
                    open_notification_settings().await?;
                }
                return Ok(json!({"opened":true}));
            }
            NfnCommand::SaveSettings { patch } => {
                let next = {
                    let mut config = self.ctx.settings.lock();
                    let current = settings::load(&config.enhanced_notifications)?;
                    let next = settings::parse(&patch.to_string(), &current)?;
                    settings::save(&next)?;
                    config.enhanced_notifications = next.clone();
                    next
                };
                self.changed();
                return Ok(json!({"settings":next}));
            }
            NfnCommand::SetPosition { display, position } => {
                let mut config = self.ctx.settings.lock();
                let mut next = settings::load(&config.enhanced_notifications)?;
                next.placement = "custom".into();
                next.display = display;
                next.position = Some(position);
                settings::save(&next)?;
                config.enhanced_notifications = next;
                drop(config);
                self.changed();
                return Ok(json!({"saved":true}));
            }
            NfnCommand::OpenBrowser { id } => {
                let record = self.store.get(&id)?;
                open_browser(&record.request.source).await?;
                return Ok(json!({"opened":true}));
            }
            NfnCommand::OpenJob { id } => {
                let record = self.store.get(&id)?;
                let job = record
                    .request
                    .source
                    .job_id
                    .as_deref()
                    .ok_or("This notification has no job")?;
                reveal_job(job).await?;
                return Ok(json!({"opened":true}));
            }
            NfnCommand::Focus { id } => {
                let _guard = self.mutation.lock().await;
                let record = self.store.get(&id)?;
                let result = self.focus_notification(&record).await?;
                self.changed();
                return Ok(result);
            }
            NfnCommand::AutoYes { id } => {
                let record = self.store.get(&id)?;
                validate_source(&record.request.source)?;
                let pane = record
                    .request
                    .source
                    .pane_id
                    .ok_or("This request has no agent")?;
                match ipc::send_command(ipc::IpcCommand::ToggleAutoYes {
                    pane_id: pane.clone(),
                })
                .await?
                {
                    ipc::IpcResponse::Error(error) => return Err(error),
                    _ => {
                        let auto_yes = self.ctx.auto_yes_panes.lock().contains(&pane);
                        self.changed();
                        return Ok(json!({"auto_yes":auto_yes}));
                    }
                }
            }
            NfnCommand::Model { id, model, effort } => {
                let record = self.store.get(&id)?;
                validate_source(&record.request.source)?;
                let pane = record
                    .request
                    .source
                    .pane_id
                    .ok_or("This request has no agent")?;
                match ipc::send_command(ipc::IpcCommand::SetCodexModel {
                    pane_id: pane,
                    model,
                    effort,
                })
                .await?
                {
                    ipc::IpcResponse::Error(error) => return Err(error),
                    _ => {}
                }
                return Ok(json!({"ok":true}));
            }
            NfnCommand::Plugin {
                id,
                action_id,
                parameters,
            } => {
                let record = self.store.get(&id)?;
                validate_source(&record.request.source)?;
                let pane = record
                    .request
                    .source
                    .pane_id
                    .ok_or("This request has no agent")?;
                let settings = self.ctx.settings.lock().clone();
                let run =
                    crate::agent_plugins::runtime().start(pane, action_id, parameters, settings)?;
                return Ok(json!({"run":run}));
            }
            _ => {}
        }
        let operation = match &command {
            NfnCommand::Read { .. } => "read",
            NfnCommand::Dismiss { .. } => "dismiss",
            NfnCommand::Ignore { .. } => "ignore",
            _ => "cancel",
        };
        let _guard = self.mutation.lock().await;
        let result = match command {
            NfnCommand::Ignore { id } | NfnCommand::Unignore { id } => {
                let records = self.store.set_ignored(&id, operation == "ignore")?;
                json!({"records":records,"agents":self.store.ignored_agents()?})
            }
            NfnCommand::DismissMany { ids } => {
                if ids.len() > 10000 {
                    return Err("Select up to 10000 notifications at a time".into());
                }
                let mut records = self.store.dismiss_many(&ids)?;
                for record in records.clone() {
                    records.extend(self.store.supersede_previous(&record)?);
                }
                json!({"records":records})
            }
            NfnCommand::Send { mut request } => {
                request.validate()?;
                if request.channels.iter().any(|channel| channel == "telegram") {
                    let config = self
                        .ctx
                        .settings
                        .lock()
                        .telegram
                        .clone()
                        .filter(|config| config.is_configured())
                        .ok_or("Telegram is not configured")?;
                    if request
                        .telegram_chat_id
                        .is_some_and(|chat| !config.chat_ids.contains(&chat))
                    {
                        return Err("Telegram chat is not configured".into());
                    }
                }
                if let Some(pane) = request.source.pane_id.clone() {
                    let source = resolve_source(&pane, request.source.client_tty.clone())?;
                    if request
                        .source
                        .session_id
                        .as_ref()
                        .is_some_and(|id| source.session_id.as_ref() != Some(id))
                    {
                        return Err("Agent session changed before request submission".into());
                    }
                    request.source =
                        merge_reported_source(source, std::mem::take(&mut request.source));
                }
                if request.response_destination == "agent_message"
                    && request.source.agent_pid.is_none()
                {
                    return Err("agent_message requires a running supported agent".into());
                }
                let (record, created) = self.store.send(request, None)?;
                if created {
                    self.announce(&record);
                }
                serde_json::to_value(record).map_err(|e| e.to_string())?
            }
            NfnCommand::Read { id } | NfnCommand::Dismiss { id } | NfnCommand::Cancel { id } => {
                let mut record = self.store.get(&id)?;
                match operation {
                    "read" => {
                        record.read_at = Some(now());
                    }
                    "dismiss" => {
                        record.dismissed_at = Some(now());
                        record.read_at = Some(now());
                    }
                    _ => {
                        if record.status == "delivering" {
                            return Err("A response is being delivered".into());
                        }
                        if record.pending() {
                            record.status = "cancelled".into();
                        }
                    }
                }
                self.store.save(&mut record)?;
                if operation == "dismiss" {
                    self.store.supersede_previous(&record)?;
                }
                serde_json::to_value(record).map_err(|e| e.to_string())?
            }
            NfnCommand::Respond {
                id,
                action_id,
                text,
            } => self.respond(&id, &action_id, text).await?,
            _ => return Err("Unsupported notification operation".into()),
        };
        self.changed();
        Ok(result)
    }

    async fn focus_notification(&self, record: &NfnRecord) -> Result<Value, String> {
        if job_notice(record) {
            self.focus_job_session(record).await?;
        } else {
            validate_source(&record.request.source)?;
            focus_source(&record.request.source).await?;
        }
        let dismissed = self.store.dismiss_many(std::slice::from_ref(&record.id))?;
        self.store.supersede_previous(record)?;
        Ok(json!({"focused":true, "record":dismissed[0]}))
    }

    async fn focus_job_session(&self, record: &NfnRecord) -> Result<(), String> {
        let mut source = record.request.source.clone();
        if let Some(pane) = record.request.data["opened_session_pane"]
            .as_str()
            .filter(|pane| crate::terminal_backend::pane_exists(pane))
        {
            if matches!(
                crate::terminal_backend::pane_process_state(pane)?,
                crate::tmux::PaneProcessState::Running
            ) {
                source.pane_id = Some(pane.into());
                let current = resolve_source_identity(
                    pane,
                    &crate::agent_session::ProcessSnapshot::capture(),
                )?;
                if current.session_id.is_some() && current.session_id != source.session_id {
                    return Err("The originating agent session has changed".into());
                }
                return focus_source(&source).await;
            }
        }
        if let Some(pane) = source
            .pane_id
            .as_deref()
            .filter(|pane| crate::terminal_backend::pane_exists(pane))
        {
            if matches!(
                crate::terminal_backend::pane_process_state(pane)?,
                crate::tmux::PaneProcessState::Running
            ) {
                match validate_source(&source) {
                    Ok(()) => return focus_source(&source).await,
                    Err(error) => {
                        let finished = source.run_id.as_deref().is_some_and(|run| {
                            self.ctx
                                .history
                                .lock()
                                .get_by_id_bounded(run, 1)
                                .ok()
                                .flatten()
                                .is_some_and(|run| run.finished_at.is_some())
                        });
                        if source.session_id.is_none() || !finished {
                            return Err(error);
                        }
                    }
                }
            }
            if source.session_id.is_none() {
                return focus_source(&source).await;
            }
        }
        let command = session_resume_command(&source)?;
        if source
            .pane_id
            .as_deref()
            .is_some_and(crate::managed::is_managed)
        {
            let info = crate::managed::launch(
                crate::managed::Launch {
                    program: "/bin/zsh".into(),
                    args: vec!["-lc".into(), command],
                    cwd: source
                        .cwd
                        .clone()
                        .ok_or("This job has no recorded working directory")?,
                    size: Default::default(),
                    close_with_terminal: false,
                    provider: source.provider.clone().unwrap_or_default(),
                    conversation_id: source.session_id.clone(),
                    metadata: Default::default(),
                },
                &[],
            )?;
            let mut updated = record.clone();
            updated.request.data["opened_session_pane"] = json!(info.id);
            self.store.save(&mut updated)?;
            source.pane_id = Some(info.id);
            return focus_source(&source).await;
        }
        let session = source
            .group
            .clone()
            .filter(|group| crate::tmux::session_exists(group))
            .unwrap_or_else(|| self.ctx.settings.lock().default_tmux_session.clone());
        if !crate::tmux::session_exists(&session) {
            crate::tmux::create_session(&session)?;
        }
        let pane = crate::tmux::create_window_with_cwd(
            &session,
            &crate::tmux::next_ct_window_name(&session, "session"),
            source.cwd.as_deref(),
            &[],
        )?;
        if let Err(error) = crate::tmux::send_keys_to_pane(&session, &pane, &command) {
            let _ = crate::tmux::kill_pane(&pane);
            return Err(error);
        }
        let mut updated = record.clone();
        updated.request.data["opened_session_pane"] = json!(pane);
        self.store.save(&mut updated)?;
        source.pane_id = Some(pane);
        focus_source(&source).await
    }

    async fn respond(
        &self,
        id: &str,
        action_id: &str,
        text: Option<String>,
    ) -> Result<Value, String> {
        if text.as_ref().is_some_and(|text| text.len() > 32768) {
            return Err("Reply exceeds 32 KiB".into());
        }
        if action_id == "reply" && text.as_ref().is_none_or(|text| text.trim().is_empty()) {
            return Err("Enter a reply before sending".into());
        }
        let mut record = self.store.get(id)?;
        if !record.request.needs_response() && action_id == "acknowledge" {
            let dismissed = self.store.dismiss_many(&[id.to_string()])?;
            self.store.supersede_previous(&record)?;
            return Ok(json!({"record":dismissed[0]}));
        }
        if record
            .request
            .expires_at
            .is_some_and(|until| until <= now())
        {
            return Err("Request has expired".into());
        }
        let action = if action_id == "reply" {
            NfnAction {
                id: "reply".into(),
                label: "Reply".into(),
                ..Default::default()
            }
        } else {
            record
                .request
                .actions
                .iter()
                .find(|a| a.id == action_id)
                .cloned()
                .ok_or("Unknown response action")?
        };
        if action.kind == "focus" {
            return self.focus_notification(&record).await;
        }
        if action.kind != "choice" {
            validate_source(&record.request.source)?;
            let pane = record
                .request
                .source
                .pane_id
                .as_deref()
                .ok_or("Action requires an agent")?;
            return match action.kind.as_str() {
                "auto_yes" => {
                    match ipc::send_command(ipc::IpcCommand::ToggleAutoYes {
                        pane_id: pane.into(),
                    })
                    .await?
                    {
                        ipc::IpcResponse::Error(e) => Err(e),
                        _ => Ok(json!({"ok":true})),
                    }
                }
                "model" => {
                    match ipc::send_command(ipc::IpcCommand::SetCodexModel {
                        pane_id: pane.into(),
                        model: action.value,
                        effort: action
                            .parameters
                            .get("effort")
                            .cloned()
                            .unwrap_or_else(|| "high".into()),
                    })
                    .await?
                    {
                        ipc::IpcResponse::Error(error) => Err(error),
                        _ => Ok(json!({"ok":true})),
                    }
                }
                "plugin" => {
                    let settings = self.ctx.settings.lock().clone();
                    let run = crate::agent_plugins::runtime().start(
                        pane.into(),
                        action.value,
                        action.parameters.into_iter().collect(),
                        settings,
                    )?;
                    Ok(json!({"run":run}))
                }
                _ => Err("Unsupported action".into()),
            };
        }
        if record.request.source.pane_id.is_some() {
            validate_source(&record.request.source)?;
        }
        let question = if let Some(question_id) = &record.question_id {
            let question = self
                .questions
                .lock()
                .iter()
                .find(|q| {
                    &question_key(q) == question_id
                        && Some(&q.pane_id) == record.request.source.pane_id.as_ref()
                })
                .cloned()
                .ok_or("This agent prompt has already changed")?;
            let question = crate::questions::validate_live_question(
                &question,
                record.request.source.provider.as_deref(),
            )?;
            if action_id != "reply" && text.as_ref().is_some_and(|text| !text.trim().is_empty()) {
                return Err("Send the reply first, or clear it before choosing an option".into());
            }
            Some(question)
        } else {
            None
        };
        record = self.store.claim(id)?;
        self.push(None, false);
        let delivery_result = if let Some(question) = question {
            let pane = &question.pane_id;
            if action_id == "reply" {
                match question.options.iter().find(|option| {
                    let label = option.label.to_lowercase();
                    label.contains("type something")
                        || label.contains("other")
                        || label.contains("custom")
                }) {
                    Some(option) => crate::terminal_backend::send_keys_to_tui_pane_freetext(
                        pane,
                        &option.number,
                        text.as_deref().unwrap_or(""),
                    ),
                    None => Err(
                        "This prompt has no text answer. Choose an option or focus the agent."
                            .into(),
                    ),
                }
            } else if question.input_mode == "select" {
                match question
                    .options
                    .iter()
                    .find(|option| option.number == action.value)
                {
                    Some(option) => crate::terminal_backend::send_mouse_click_to_pane(
                        pane,
                        option.col,
                        question.button_row,
                    ),
                    None => Err("This prompt option has changed".into()),
                }
            } else {
                crate::terminal_backend::send_keys_to_tui_pane(pane, &action.value)
            }
        } else if record.request.response_destination == "agent_message" {
            let pane = record
                .request
                .source
                .pane_id
                .as_deref()
                .ok_or("Agent is unavailable")?;
            let message = format!(
                "Notification {} ({})\nDecision: {}{}",
                record.request.title,
                record.id,
                action.label,
                text.as_ref()
                    .filter(|text| !text.is_empty())
                    .map(|text| format!("\n{text}"))
                    .unwrap_or_default()
            );
            crate::agent_plugins::submit_notification_reply(pane, &message)
        } else {
            Ok(())
        };
        match delivery_result {
            Ok(()) => {
                record.status = "resolved".into();
                record.error = None;
                record.response = Some(NfnResponse {
                    request_id: id.into(),
                    action_id: action_id.into(),
                    text,
                    status: "resolved".into(),
                    responded_at: now(),
                });
                self.store.save(&mut record)?;
                self.store.supersede_previous(&record)?;
            }
            Err(error) => {
                record.status = "pending".into();
                record.error = Some(error.clone());
                self.store.save(&mut record)?;
                self.changed();
                return Err(error);
            }
        }
        serde_json::to_value(record).map_err(|e| e.to_string())
    }

    async fn context(&self, id: &str) -> Result<Value, String> {
        let record = self.store.get(id)?;
        let source = &record.request.source;
        let mut log = String::new();
        let mut plugins = json!([]);
        let mut source = source.clone();
        let mut auto_yes = false;
        let live_source = if job_notice(&record) {
            validate_source(&source).is_ok()
        } else {
            validate_source(&source)?;
            true
        };
        if let Some(pane) = source.pane_id.as_deref().filter(|_| live_source) {
            log = crate::terminal_backend::capture_pane_recent_ansi(pane, 200)?;
            auto_yes = self.ctx.auto_yes_panes.lock().contains(pane);
            let settings = self.ctx.settings.lock().clone();
            let (actions, session) = crate::agent_plugins::runtime().list_actions(pane, &settings);
            plugins = json!(actions);
            if let Some(session) = session {
                source.model = session.model;
            }
        } else if let Some(run) = &source.run_id {
            if let Some(path) = self.ctx.history.lock().get_log_path(run)? {
                log = tail(&path)?;
            }
        } else if let Some(job) = &source.job_id {
            let run = self
                .ctx
                .history
                .lock()
                .get_by_job_id_summaries(job, 1)?
                .into_iter()
                .next();
            if let Some(path) = run.and_then(|run| run.log_path) {
                log = tail(&path)?;
            }
        }
        let models = source
            .provider
            .as_ref()
            .and_then(|provider| {
                self.ctx
                    .settings
                    .lock()
                    .enabled_models
                    .get(provider)
                    .cloned()
            })
            .unwrap_or_default();
        Ok(
            json!({"type":"context","id":id,"source":source,"log":log,"auto_yes":auto_yes,"models":models,"plugins":plugins}),
        )
    }
}

fn job_notice(record: &NfnRecord) -> bool {
    record.question_id.is_none()
        && record.request.template == "update"
        && record.request.source.job_id.is_some()
}

fn local_enabled(settings: &crate::config::settings::AppSettings, record: &NfnRecord) -> bool {
    if record.request.data["event"] == "agent_finished" {
        settings.notify_agent_completion_local
    } else if record.request.data["event"] == "agent_alert" {
        settings.notify_questions_local
    } else if record.request.source.job_id.is_some() && record.question_id.is_none() {
        !record
            .request
            .data
            .get("event")
            .and_then(Value::as_str)
            .is_some_and(|event| event.starts_with("failed"))
            || settings.notify_job_failures_local
    } else {
        settings.notify_questions_local
    }
}

fn refresh_pending_record(
    record: &mut NfnRecord,
    questions: Option<&HashSet<String>>,
    auto_yes_panes: &HashSet<String>,
    timestamp: i64,
    source_valid: impl FnOnce(&NfnSource) -> bool,
) -> bool {
    if record.status != "pending" {
        return false;
    }
    if record
        .request
        .expires_at
        .is_some_and(|until| until <= timestamp)
    {
        record.status = "expired".into();
    } else if let Some(id) = &record.question_id {
        // Auto-yes takes over the prompt immediately, even before the next scan.
        // Session metadata can be temporarily unavailable during title changes.
        let automatic = record
            .request
            .source
            .pane_id
            .as_ref()
            .is_some_and(|pane| auto_yes_panes.contains(pane));
        if !automatic && !questions.is_some_and(|questions| !questions.contains(id)) {
            return false;
        }
        record.status = "resolved".into();
    } else if job_notice(record) {
        return false;
    } else if record.request.source.pane_id.is_some() && !source_valid(&record.request.source) {
        record.status = "expired".into();
        record.error = Some("The originating agent session is no longer available".into());
    } else {
        return false;
    }
    true
}

fn request_for_completion(source: NfnSource) -> NfnRequest {
    let name = [
        source.task.as_deref(),
        source.window_name.as_deref(),
        source.pane_title.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find(|name| !name.trim().is_empty())
    .unwrap_or("Agent");
    NfnRequest {
        title: format!("{name} finished"),
        body: "The agent finished its turn and is ready for your next message.".into(),
        template: "update".into(),
        data: json!({"event":"agent_finished"}),
        source,
        actions: vec![
            NfnAction {
                id: "focus".into(),
                label: "Open session".into(),
                kind: "focus".into(),
                ..Default::default()
            },
            NfnAction {
                id: "acknowledge".into(),
                label: "Got it".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}

fn question_key(question: &ClaudeQuestion) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    crate::questions::prompt_context_key(&question.context_lines).hash(&mut hasher);
    format!("question:{}:{:x}", question.question_id, hasher.finish())
}

fn request_for_question(question: &ClaudeQuestion, dedupe_key: String) -> NfnRequest {
    let mut source = resolve_source(&question.pane_id, None).unwrap_or_else(|_| NfnSource {
        pane_id: Some(question.pane_id.clone()),
        cwd: Some(question.cwd.clone()),
        ..Default::default()
    });
    source.group = question.matched_group.clone().or(source.group).or_else(|| {
        (!question.tmux_session.trim().is_empty()).then(|| question.tmux_session.clone())
    });
    if source.window_name.is_none() && !question.window_name.trim().is_empty() {
        source.window_name = Some(question.window_name.clone());
    }
    NfnRequest {
        title: source
            .task
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                question.matched_job.clone().unwrap_or_else(|| {
                    std::path::Path::new(&question.cwd)
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Agent approval".into())
                })
            }),
        body: question.context_lines.clone(),
        template: "agent-approval".into(),
        data: json!({"question_id":question.question_id}),
        source,
        dedupe_key: Some(dedupe_key),
        actions: question
            .options
            .iter()
            .map(|option| NfnAction {
                id: format!("option-{}", option.number),
                label: option.label.clone(),
                value: option.number.clone(),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

pub(super) fn tmux(args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end().into())
}

fn session_resume_command(source: &NfnSource) -> Result<String, String> {
    let session = source
        .session_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or("This job has no recorded agent session")?;
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let session = quote(session);
    Ok(match source.provider.as_deref() {
        Some("claude") => format!("claude --resume {session}"),
        Some("codex") => format!("codex resume {session}"),
        Some("opencode") => format!("opencode --session {session}"),
        Some("antigravity") => format!("agy --conversation {session}"),
        Some("hermes") => {
            let home = source
                .provider_home
                .as_deref()
                .ok_or("This job has no recorded Hermes profile")?;
            let profile = if std::path::Path::new(home)
                .parent()
                .and_then(std::path::Path::file_name)
                .is_some_and(|name| name == "profiles")
            {
                ""
            } else {
                " --profile default"
            };
            format!(
                "HERMES_HOME={} hermes{profile} chat --resume {session}",
                quote(home)
            )
        }
        _ => return Err("This provider does not support session resume".into()),
    })
}

fn job_request_from_history(
    history: &crate::history::HistoryStore,
    slug: &str,
    event: &str,
    run_id: Option<&str>,
) -> NfnRequest {
    let run = match run_id {
        Some(id) => history.get_by_id_bounded(id, 1).ok().flatten(),
        None => history
            .get_by_job_id_summaries(slug, 1)
            .ok()
            .and_then(|runs| runs.into_iter().next()),
    };
    let source = run
        .as_ref()
        .map(|run| job_source_from_history(history, run))
        .unwrap_or_default();
    job_request(
        slug,
        event,
        run_id.or_else(|| run.as_ref().map(|run| run.id.as_str())),
        source,
    )
}

fn job_source_from_history(
    history: &crate::history::HistoryStore,
    run: &crate::history::RunRecord,
) -> NfnSource {
    let mut source = history
        .notification_source(&run.id)
        .ok()
        .flatten()
        .unwrap_or_default();
    source.job_id = Some(run.job_id.clone());
    source.run_id = Some(run.id.clone());
    if source.session_id.is_some() {
        return source;
    }
    if source.cwd.is_none() {
        let job = crate::config::jobs::JobsConfig::jobs_dir_public()
            .and_then(|dir| std::fs::read_to_string(dir.join(&run.job_id).join("job.yaml")).ok())
            .and_then(|yaml| serde_yml::from_str::<crate::config::jobs::Job>(&yaml).ok());
        if let Some(job) = job {
            source.group = Some(crate::config::jobs::job_group(&job).into());
            source.cwd = job.work_dir.or(job.folder_path);
        }
    }
    if let Ok(Some(recovered)) = history.recover_notification_source(&run.id, source.clone()) {
        return recovered;
    }
    if run.finished_at.is_none() {
        if let Some(live) = run
            .pane_id
            .as_deref()
            .and_then(|pane| resolve_source(pane, None).ok())
        {
            return live;
        }
    }
    // Finished runs must not bind to a pane ID that tmux has since reused.
    source.pane_id = None;
    source
}

fn attach_job_session(record: &mut NfnRecord, source: NfnSource) -> bool {
    if !job_notice(record)
        || record.request.source.session_id.is_some()
        || record.request.source.job_id != source.job_id
        || record.request.source.run_id != source.run_id
        || session_resume_command(&source).is_err()
    {
        return false;
    }
    record.request.source = source;
    if !record
        .request
        .actions
        .iter()
        .any(|action| action.kind == "focus")
    {
        record.request.actions.insert(
            0,
            NfnAction {
                id: "focus".into(),
                label: "Open session".into(),
                kind: "focus".into(),
                ..Default::default()
            },
        );
    }
    true
}

fn job_request(slug: &str, event: &str, run_id: Option<&str>, mut source: NfnSource) -> NfnRequest {
    source.job_id = Some(slug.into());
    source.run_id = run_id.map(str::to_owned);
    let mut actions = Vec::new();
    if source.pane_id.is_some() || session_resume_command(&source).is_ok() {
        actions.push(NfnAction {
            id: "focus".into(),
            label: "Open session".into(),
            kind: "focus".into(),
            ..Default::default()
        });
    }
    actions.push(NfnAction {
        id: "acknowledge".into(),
        label: "Got it".into(),
        ..Default::default()
    });
    let kind = if event.starts_with("failed") {
        "failed"
    } else if matches!(event, "completed" | "finished") {
        "completed"
    } else {
        "update"
    };
    let event_key = if kind == "update" { event } else { kind };
    let mut body = format!("Job {slug} {event}");
    if let Some(run_id) = run_id {
        body.push_str(&format!("\nRun: {run_id}"));
    }
    if kind == "failed" {
        body.push_str(&format!("\nRestart: cwtctl jobs restart {slug}"));
    }
    NfnRequest {
        kind: kind.into(),
        title: format!("{slug} {event}"),
        body,
        template: "update".into(),
        data: json!({"event":event}),
        actions,
        source,
        dedupe_key: Some(format!("job:{}:{event_key}", run_id.unwrap_or("unknown"))),
        ..Default::default()
    }
}

fn merge_reported_source(mut source: NfnSource, reported: NfnSource) -> NfnSource {
    source.browser_pane_id = reported.browser_pane_id;
    source.browser_session = reported.browser_session;
    source.task = reported.task.or(source.task);
    source.group = reported.group.or(source.group);
    source.agent_title = reported.agent_title;
    source.job_id = reported.job_id;
    source.run_id = reported.run_id;
    source
}

pub fn resolve_source(pane: &str, client_tty: Option<String>) -> Result<NfnSource, String> {
    let pid = crate::terminal_backend::pane_pid(pane)?;
    let cwd = crate::terminal_backend::get_pane_path(pane)?;
    let snapshot = crate::agent_session::ProcessSnapshot::capture();
    let provider = crate::agent_session::detect_process_provider(&pid, Some(&snapshot));
    let agent_pid = crate::agent_session::provider_process_pid(&pid, &snapshot);
    let provider_home = (provider == Some(crate::agent_session::ProcessProvider::Hermes))
        .then(|| crate::agent_session::hermes::identity_for_pane(&pid, Some(&snapshot)))
        .flatten()
        .map(|identity| identity.home.to_string_lossy().into_owned());
    let info = crate::agent_session::resolve_session_info_for_provider_with_cwd(
        &pid,
        provider,
        Some(&snapshot),
        Some(&cwd),
    );
    let meta = crate::config::settings::AppSettings::load()
        .process_overrides
        .get(pane)
        .cloned();
    let mut source = NfnSource {
        pane_id: Some(pane.into()),
        pane_pid: Some(pid.clone()),
        process_started_at: snapshot.start_epoch_for_pid(&pid),
        agent_started_at: agent_pid
            .as_ref()
            .and_then(|pid| snapshot.start_epoch_for_pid(pid)),
        agent_pid,
        provider: provider.map(|p| p.as_str().into()),
        provider_home,
        session_id: info.session_id,
        model: info.model_id,
        cwd: Some(cwd.clone()),
        task: meta
            .as_ref()
            .and_then(|meta| meta.display_name.clone())
            .or(info.title),
        group: meta.and_then(|meta| meta.group_override),
        client_tty,
        ..Default::default()
    };
    if !crate::managed::is_managed(pane) {
        if let Ok(labels) = tmux(&[
            "display-message",
            "-p",
            "-t",
            pane,
            "#{window_name}\n#{pane_title}",
        ]) {
            let mut lines = labels.lines();
            source.window_name = lines
                .next()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned);
            source.pane_title = lines
                .next()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned);
        }
        if source.group.is_none() {
            source.group = crate::tmux::resolve_real_session_for_pane(pane).ok();
        }
        if let Ok(clients) = tmux(&[
            "list-clients",
            "-t",
            pane,
            "-F",
            "#{client_activity}|#{client_tty}|#{client_pid}",
        ]) {
            let selected = clients
                .lines()
                .filter_map(|line| {
                    let values: Vec<_> = line.split('|').collect();
                    (values.len() == 3).then_some(values)
                })
                .filter(|parts| source.client_tty.as_ref().is_none_or(|tty| tty == parts[1]))
                .max_by_key(|parts| parts[0].parse::<u64>().unwrap_or(0));
            if let Some(parts) = selected {
                source.client_tty = Some(parts[1].into());
                source.origin_pid = parts[2].parse().ok().and_then(terminal_app_pid);
            }
        }
    }
    if let Ok(output) = std::process::Command::new("git")
        .args(["-C", &cwd, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
    {
        if output.status.success() {
            source.branch = Some(String::from_utf8_lossy(&output.stdout).trim().into());
            source.worktree = Some(cwd);
        }
    }
    Ok(source)
}

fn validate_source(source: &NfnSource) -> Result<(), String> {
    SourceValidator::default().validate(source)
}

#[derive(Default)]
struct SourceValidator {
    snapshot: Option<crate::agent_session::ProcessSnapshot>,
    sources: HashMap<String, Result<NfnSource, String>>,
}

impl SourceValidator {
    fn validate(&mut self, source: &NfnSource) -> Result<(), String> {
        let Some(pane) = &source.pane_id else {
            return Ok(());
        };
        let current = self.sources.entry(pane.clone()).or_insert_with(|| {
            let snapshot = self
                .snapshot
                .get_or_insert_with(crate::agent_session::ProcessSnapshot::capture);
            resolve_source_identity(pane, snapshot)
        });
        let current = current.as_ref().map_err(Clone::clone)?;
        if !same_source(source, current) {
            return Err("The originating agent session has changed".into());
        }
        Ok(())
    }
}

fn resolve_source_identity(
    pane: &str,
    snapshot: &crate::agent_session::ProcessSnapshot,
) -> Result<NfnSource, String> {
    use crate::agent_session::{self, ProcessProvider};
    let pid = crate::terminal_backend::pane_pid(pane)?;
    let provider = agent_session::detect_process_provider(&pid, Some(snapshot));
    let agent_pid = agent_session::provider_process_pid(&pid, snapshot);
    let cwd = if provider == Some(ProcessProvider::Opencode) {
        Some(crate::terminal_backend::get_pane_path(pane)?)
    } else {
        None
    };
    let session_id = match provider {
        Some(provider) => {
            agent_session::resolve_session_identity(&pid, provider, snapshot, cwd.as_deref())
        }
        None => {
            agent_session::resolve_session_info_for_provider_with_cwd_fast(
                &pid,
                None,
                Some(snapshot),
                cwd.as_deref(),
            )
            .session_id
        }
    };
    Ok(NfnSource {
        pane_id: Some(pane.into()),
        pane_pid: Some(pid.clone()),
        process_started_at: snapshot.start_epoch_for_pid(&pid),
        agent_started_at: agent_pid
            .as_ref()
            .and_then(|pid| snapshot.start_epoch_for_pid(pid)),
        agent_pid,
        provider: provider.map(|provider| provider.as_str().into()),
        session_id,
        ..Default::default()
    })
}

fn invalid_pending_sources(records: &[NfnRecord]) -> HashSet<String> {
    let mut validator = SourceValidator::default();
    records
        .iter()
        .filter(|record| {
            record.status == "pending" && record.question_id.is_none() && !job_notice(record)
        })
        .filter(|record| validator.validate(&record.request.source).is_err())
        .map(|record| record.id.clone())
        .collect()
}

fn same_source(source: &NfnSource, current: &NfnSource) -> bool {
    source.pane_pid == current.pane_pid
        && source.process_started_at == current.process_started_at
        && source.agent_pid == current.agent_pid
        && source.agent_started_at == current.agent_started_at
        && source.provider == current.provider
        && source
            .session_id
            .as_ref()
            .is_none_or(|id| current.session_id.as_ref() == Some(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_jobs_keep_their_session_and_remain_openable_after_exit() {
        let source = NfnSource {
            pane_id: Some("%17".into()),
            session_id: Some("conversation-17".into()),
            provider: Some("codex".into()),
            cwd: Some("/workspace/project".into()),
            ..Default::default()
        };
        let request = job_request("project/job", "failed (exit 143)", Some("run-17"), source);
        assert_eq!(request.kind, "failed");
        assert_eq!(request.dedupe_key.as_deref(), Some("job:run-17:failed"));
        assert!(request.body.contains("failed (exit 143)"));
        assert_eq!(
            request.source.session_id.as_deref(),
            Some("conversation-17")
        );
        assert_eq!(request.source.run_id.as_deref(), Some("run-17"));
        assert_eq!(request.actions[0].kind, "focus");
        assert_eq!(
            session_resume_command(&request.source).unwrap(),
            "codex resume 'conversation-17'"
        );
        let mut record = pending_permission();
        record.question_id = None;
        record.request = request;
        assert!(!refresh_pending_record(
            &mut record,
            None,
            &HashSet::new(),
            20_000,
            |_| panic!("job sessions outlive their process")
        ));
        assert_eq!(record.status, "pending");
    }

    #[test]
    fn jobs_without_agent_sessions_keep_the_job_action_and_resume_quotes_ids() {
        let request = job_request(
            "project/script",
            "failed",
            Some("run-script"),
            NfnSource::default(),
        );
        assert_eq!(request.actions.len(), 1);
        assert_eq!(request.actions[0].id, "acknowledge");
        assert!(session_resume_command(&request.source).is_err());
        let source = NfnSource {
            provider: Some("claude".into()),
            session_id: Some("session'; touch /tmp/incorrect".into()),
            ..Default::default()
        };
        assert_eq!(
            session_resume_command(&source).unwrap(),
            "claude --resume 'session'\\''; touch /tmp/incorrect'"
        );
    }

    #[test]
    fn failed_jobs_can_resume_saved_sessions_without_a_terminal_pane() {
        let source = NfnSource {
            session_id: Some("binary-conversation".into()),
            provider: Some("codex".into()),
            cwd: Some("/workspace/project".into()),
            ..Default::default()
        };
        let request = job_request(
            "project/script",
            "failed (exit 1)",
            Some("run-script"),
            source,
        );
        assert!(request.source.pane_id.is_none());
        assert_eq!(request.actions[0].kind, "focus");
        assert_eq!(
            session_resume_command(&request.source).unwrap(),
            "codex resume 'binary-conversation'"
        );

        for provider in ["shell", "unknown", "hermes"] {
            let source = NfnSource {
                session_id: Some("conversation".into()),
                provider: Some(provider.into()),
                ..Default::default()
            };
            let request = job_request("project/script", "failed", None, source);
            assert_eq!(request.actions.len(), 1, "{provider}");
            assert_eq!(request.actions[0].id, "acknowledge");
        }
        let source = NfnSource {
            session_id: Some(" ".into()),
            provider: Some("codex".into()),
            ..Default::default()
        };
        assert_eq!(
            job_request("project/script", "failed", None, source)
                .actions
                .len(),
            1
        );
    }

    #[test]
    fn recovered_job_cards_gain_a_session_action_without_reopening_history() {
        let mut record = pending_permission();
        record.question_id = None;
        record.request = job_request(
            "project/repair",
            "failed (exit 1)",
            Some("failed-run"),
            NfnSource::default(),
        );
        record.dismissed_at = Some(100);
        record.read_at = Some(90);
        let source = NfnSource {
            job_id: Some("project/repair".into()),
            run_id: Some("failed-run".into()),
            provider: Some("codex".into()),
            session_id: Some("repair-session".into()),
            cwd: Some("/workspace/project".into()),
            ..Default::default()
        };
        let mut other_run = source.clone();
        other_run.run_id = Some("newer-run".into());
        assert!(!attach_job_session(&mut record, other_run));
        assert!(attach_job_session(&mut record, source.clone()));
        assert_eq!(record.request.actions[0].kind, "focus");
        assert_eq!(record.request.source, source);
        assert_eq!(record.dismissed_at, Some(100));
        assert_eq!(record.read_at, Some(90));
        assert_eq!(record.status, "pending");
        assert!(record.response.is_none());
        assert!(!attach_job_session(&mut record, source));
        assert_eq!(record.request.actions.len(), 2);
    }

    fn pending_permission() -> NfnRecord {
        serde_json::from_value(json!({
            "id": "permission", "status": "pending", "created_at": 0, "updated_at": 0,
            "question_id": "live-prompt",
            "request": {"title": "Run checks?", "source": {"pane_id": "%10"}}
        }))
        .unwrap()
    }

    #[test]
    fn hermes_job_resume_keeps_its_profile() {
        let mut source = NfnSource {
            provider: Some("hermes".into()),
            provider_home: Some("/home/me/.hermes/profiles/work".into()),
            session_id: Some("conversation".into()),
            ..Default::default()
        };
        assert_eq!(
            session_resume_command(&source).unwrap(),
            "HERMES_HOME='/home/me/.hermes/profiles/work' hermes chat --resume 'conversation'"
        );
        source.provider_home = Some("/home/me/.hermes".into());
        assert_eq!(
            session_resume_command(&source).unwrap(),
            "HERMES_HOME='/home/me/.hermes' hermes --profile default chat --resume 'conversation'"
        );
    }

    #[test]
    fn live_permissions_survive_metadata_lookup_failures_and_resolve_with_the_prompt() {
        let mut record = pending_permission();
        let questions = HashSet::from(["live-prompt".into()]);
        for timestamp in [10_000, 20_000, 300_000] {
            assert!(!refresh_pending_record(
                &mut record,
                Some(&questions),
                &HashSet::new(),
                timestamp,
                |_| { panic!("live permission lifetime must not depend on session metadata") }
            ));
            assert_eq!(record.status, "pending");
            assert!(record.error.is_none());
        }
        assert!(!refresh_pending_record(
            &mut record,
            None,
            &HashSet::new(),
            310_000,
            |_| false
        ));
        assert!(refresh_pending_record(
            &mut record,
            Some(&HashSet::new()),
            &HashSet::new(),
            320_000,
            |_| false
        ));
        assert_eq!(record.status, "resolved");
    }

    #[test]
    fn auto_yes_resolves_live_permissions_before_the_next_prompt_scan() {
        let questions = HashSet::from(["live-prompt".into()]);
        let auto_yes = HashSet::from(["%10".into()]);
        for current in [None, Some(&questions)] {
            let mut record = pending_permission();
            assert!(refresh_pending_record(
                &mut record,
                current,
                &auto_yes,
                10_000,
                |_| panic!("auto-yes does not depend on session metadata")
            ));
            assert_eq!(record.status, "resolved");
            assert!(record.response.is_none());
            assert!(!refresh_pending_record(
                &mut record,
                Some(&questions),
                &HashSet::new(),
                20_000,
                |_| true
            ));
            assert_eq!(record.status, "resolved");
        }
    }

    #[test]
    fn auto_yes_only_handles_detected_pending_permissions_for_its_pane() {
        let questions = HashSet::from(["live-prompt".into()]);
        let auto_yes = HashSet::from(["%10".into()]);
        let mut other_pane = pending_permission();
        other_pane.request.source.pane_id = Some("%11".into());
        let mut explicit_request = pending_permission();
        explicit_request.question_id = None;
        let mut delivering = pending_permission();
        delivering.status = "delivering".into();
        for mut record in [other_pane, explicit_request, delivering] {
            let before = record.clone();
            assert!(!refresh_pending_record(
                &mut record,
                Some(&questions),
                &auto_yes,
                10_000,
                |_| true
            ));
            assert_eq!(record, before);
        }
    }

    #[test]
    fn auto_yes_handling_survives_restart_and_keeps_the_permission_in_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notifications.sqlite");
        let id = {
            let store = Store::open(&path).unwrap();
            let permission = pending_permission();
            let (mut record, _) = store
                .send(permission.request, permission.question_id)
                .unwrap();
            assert!(refresh_pending_record(
                &mut record,
                None,
                &HashSet::from(["%10".into()]),
                now(),
                |_| true
            ));
            store.save(&mut record).unwrap();
            assert_eq!(store.pending_count().unwrap(), 0);
            record.id
        };
        let store = Store::open(&path).unwrap();
        assert!(store.pending_page(0).unwrap().is_empty());
        assert_eq!(store.get(&id).unwrap().status, "resolved");
        assert_eq!(store.list(0).unwrap()[0].id, id);
    }

    #[test]
    fn explicit_expiry_and_non_prompt_source_checks_still_apply() {
        let auto_yes = HashSet::new();
        let mut record = pending_permission();
        record.request.expires_at = Some(5_000);
        assert!(refresh_pending_record(
            &mut record,
            None,
            &auto_yes,
            5_000,
            |_| true
        ));
        assert_eq!(record.status, "expired");

        let mut record = pending_permission();
        record.question_id = None;
        assert!(!refresh_pending_record(
            &mut record,
            None,
            &auto_yes,
            10_000,
            |_| true
        ));
        assert!(refresh_pending_record(
            &mut record,
            None,
            &auto_yes,
            20_000,
            |_| false
        ));
        assert_eq!(record.status, "expired");
        assert!(record.error.is_some());

        let mut record = pending_permission();
        record.question_id = None;
        record.request.source.job_id = Some("project/job".into());
        assert!(refresh_pending_record(
            &mut record,
            None,
            &auto_yes,
            20_000,
            |_| false
        ));
        assert_eq!(record.status, "expired");
    }

    #[test]
    fn completions_use_update_cards_and_their_own_notification_settings() {
        let source = NfnSource {
            pane_id: Some("%13".into()),
            session_id: Some("conversation".into()),
            task: Some("Fix notifications".into()),
            ..Default::default()
        };
        let request = request_for_completion(source.clone());
        assert_eq!(request.source, source);
        assert_eq!(request.title, "Fix notifications finished");
        assert_eq!(request.template, "update");
        assert_eq!(request.data["event"], "agent_finished");
        assert_eq!(request.actions[0].kind, "focus");
        assert_eq!(request.actions[1].id, "acknowledge");
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("notifications.sqlite")).unwrap();
        let (record, _) = store.send(request, None).unwrap();
        assert!(record.question_id.is_none());
        let mut settings: crate::config::settings::AppSettings =
            serde_json::from_str("{}").unwrap();
        settings.notify_questions_local = false;
        assert!(settings.notify_agent_completion_remote);
        assert!(local_enabled(&settings, &record));
        settings.notify_agent_completion_local = false;
        settings.notify_questions_local = true;
        assert!(!local_enabled(&settings, &record));
        // An unread update must not deduplicate the next completion.
        assert!(store.send(request_for_completion(source), None).unwrap().1);
    }

    #[test]
    fn reported_labels_preserve_the_bound_agent_and_tmux_metadata() {
        let source = NfnSource {
            pane_id: Some("%1".into()),
            agent_pid: Some("42".into()),
            group: Some("project".into()),
            window_name: Some("Current tmux title".into()),
            ..Default::default()
        };
        let unchanged = merge_reported_source(source.clone(), NfnSource::default());
        assert_eq!(unchanged.group, source.group);
        let reported = serde_json::from_value(json!({"group":"Custom group", "agent_title":"Reported title", "agent_pid":"wrong", "window_name":"wrong"})).unwrap();
        let merged = merge_reported_source(source, reported);
        assert_eq!(merged.group.as_deref(), Some("Custom group"));
        assert_eq!(merged.agent_title.as_deref(), Some("Reported title"));
        assert_eq!(merged.window_name.as_deref(), Some("Current tmux title"));
        assert_eq!(merged.agent_pid.as_deref(), Some("42"));
    }

    #[test]
    fn job_folder_rejects_paths_outside_the_job_directory() {
        for job in ["", "/tmp", "../outside", "project/../../outside"] {
            assert!(job_directory(job).is_err());
        }
    }
    #[test]
    fn focus_finds_a_terminal_when_the_agent_session_is_detached() {
        let clients = "10|/dev/ttys001|101|$1\n20|/dev/ttys002|202|$2";
        let selected = select_terminal_client(clients, None, "$4").unwrap();
        assert_eq!(selected.tty, "/dev/ttys002");
        assert_eq!(selected.pid, 202);
        assert_eq!(
            select_terminal_client(clients, Some("/dev/closed"), "$1")
                .unwrap()
                .tty,
            "/dev/ttys001"
        );
        assert_eq!(
            select_terminal_client(clients, Some("/dev/ttys001"), "$2")
                .unwrap()
                .tty,
            "/dev/ttys001"
        );
        assert!(select_terminal_client("", None, "$4").is_none());
    }

    #[test]
    fn source_binding_rejects_an_agent_restart_inside_the_same_shell() {
        let source = NfnSource {
            pane_pid: Some("10".into()),
            process_started_at: Some(1),
            agent_pid: Some("20".into()),
            agent_started_at: Some(2),
            provider: Some("codex".into()),
            ..Default::default()
        };
        let mut current = source.clone();
        assert!(same_source(&source, &current));
        current.agent_pid = Some("21".into());
        assert!(!same_source(&source, &current));
        current = source.clone();
        current.agent_started_at = Some(3);
        assert!(!same_source(&source, &current));
        current = source.clone();
        current.provider = Some("claude".into());
        assert!(!same_source(&source, &current));
        let mut source = source;
        source.session_id = Some("session-1".into());
        current = source.clone();
        current.session_id = Some("session-2".into());
        assert!(!same_source(&source, &current));
    }

    #[test]
    fn source_checks_reuse_pane_identity_without_loading_card_metadata() {
        let source = NfnSource {
            pane_id: Some("%1".into()),
            pane_pid: Some("10".into()),
            process_started_at: Some(1),
            agent_pid: Some("20".into()),
            agent_started_at: Some(2),
            provider: Some("codex".into()),
            session_id: Some("session-1".into()),
            ..Default::default()
        };
        let mut validator = SourceValidator::default();
        validator.sources.insert("%1".into(), Ok(source.clone()));
        for index in 0..225 {
            let mut record_source = source.clone();
            record_source.task = Some(format!("Historical card {index}"));
            record_source.cwd = Some("/no-longer-mounted/worktree".into());
            record_source.client_tty = Some("/dev/closed-terminal".into());
            assert!(validator.validate(&record_source).is_ok());
        }
        let mut stale = source;
        stale.session_id = Some("session-2".into());
        assert!(validator.validate(&stale).is_err());
        assert!(
            validator.snapshot.is_none(),
            "cached panes need no new process snapshot"
        );
    }
}

fn job_directory(job: &str) -> Result<std::path::PathBuf, String> {
    if job.is_empty()
        || std::path::Path::new(job)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Invalid job identifier".into());
    }
    let directory = crate::config::jobs::JobsConfig::jobs_dir_public()
        .ok_or("Could not determine job directory")?
        .join(job);
    if !directory.is_dir() {
        return Err("This job folder no longer exists".into());
    }
    Ok(directory)
}

async fn bmux_command(args: &[&str]) -> Result<Value, String> {
    let mut command = tokio::process::Command::new("bmux");
    command.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "BMUX did not respond".to_string())?
        .map_err(|error| format!("Could not open BMUX: {error}"))?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "BMUX returned an invalid response".to_string())?;
    if !output.status.success() || value["ok"] != true {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Could not open browser session")
            .to_string());
    }
    Ok(value["result"].clone())
}

async fn open_browser(source: &NfnSource) -> Result<(), String> {
    let pane = source
        .browser_pane_id
        .as_deref()
        .ok_or("This message has no browser pane")?;
    let session = source
        .browser_session
        .as_deref()
        .ok_or("This message has no browser session")?;
    let client = bmux_command(&["attach-session", "-t", session]).await?;
    let id = client["id"]
        .as_str()
        .ok_or("BMUX returned no browser client")?;
    bmux_command(&["select-pane", "-c", id, "-t", pane]).await?;
    Ok(())
}

async fn reveal_job(job: &str) -> Result<(), String> {
    let directory = job_directory(job)?;
    #[cfg(target_os = "macos")]
    let status = tokio::process::Command::new("open")
        .arg("-R")
        .arg(directory)
        .status()
        .await;
    #[cfg(not(target_os = "macos"))]
    let status = tokio::process::Command::new("xdg-open")
        .arg(directory)
        .status()
        .await;
    if !status.map_err(|e| e.to_string())?.success() {
        return Err("Could not open the job folder".into());
    }
    Ok(())
}

async fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = tokio::process::Command::new("open");
        command.args(["-b", "cc.clawtab"]);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = tokio::process::Command::new("xdg-open");
    if !command
        .arg("clawtab://settings/notifications")
        .status()
        .await
        .map_err(|e| e.to_string())?
        .success()
    {
        return Err("Could not open notification settings".into());
    }
    Ok(())
}

async fn focus_source(source: &NfnSource) -> Result<(), String> {
    let pane = source
        .pane_id
        .as_deref()
        .ok_or("This request has no agent pane")?;
    if crate::managed::is_managed(pane) {
        return match ipc::send_desktop_command(ipc::DesktopIpcCommand::OpenPane {
            pane_id: pane.into(),
        })
        .await?
        {
            ipc::IpcResponse::Error(error) => Err(error),
            _ => {
                native::activate_clawtab();
                Ok(())
            }
        };
    }
    let session = tmux(&["display-message", "-t", pane, "-p", "#{session_id}"])?;
    let clients = tmux(&[
        "list-clients",
        "-F",
        "#{client_activity}|#{client_tty}|#{client_pid}|#{session_id}",
    ])?;
    let client = select_terminal_client(&clients, source.client_tty.as_deref(), &session)
        .ok_or("No terminal is attached to tmux. Attach a terminal, then open the agent again.")?;
    let origin = terminal_app_pid(client.pid);
    tmux(&[
        "switch-client",
        "-c",
        client.tty,
        "-t",
        &session,
        ";",
        "select-window",
        "-t",
        pane,
        ";",
        "select-pane",
        "-t",
        pane,
    ])?;
    if let Some(pid) = origin {
        native::activate(pid);
    }
    Ok(())
}

struct TerminalClient<'a> {
    tty: &'a str,
    pid: u32,
}

fn select_terminal_client<'a>(
    clients: &'a str,
    preferred_tty: Option<&str>,
    target_session: &str,
) -> Option<TerminalClient<'a>> {
    clients
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split('|').collect();
            if parts.len() != 4 || parts[1].is_empty() {
                return None;
            }
            Some((
                (
                    preferred_tty == Some(parts[1]),
                    parts[3] == target_session,
                    parts[0].parse::<u64>().ok()?,
                ),
                TerminalClient {
                    tty: parts[1],
                    pid: parts[2].parse().ok()?,
                },
            ))
        })
        .max_by_key(|(priority, _)| *priority)
        .map(|(_, client)| client)
}

fn terminal_app_pid(mut pid: u32) -> Option<u32> {
    for _ in 0..20 {
        let output = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "ppid=,comm="])
            .output()
            .ok()?;
        let value = String::from_utf8_lossy(&output.stdout);
        let (parent, command) = value.trim().split_once(char::is_whitespace)?;
        if command.contains(".app/Contents/MacOS/") {
            return Some(pid);
        }
        let parent = parent.parse::<u32>().ok()?;
        if parent <= 1 || parent == pid {
            return None;
        }
        pid = parent;
    }
    None
}

fn terminal_pane_viewed(pane: &str, frontmost: u32) -> bool {
    if crate::managed::is_managed(pane) {
        return false;
    }
    let Ok(clients) = tmux(&[
        "list-clients",
        "-F",
        "#{client_activity}|#{client_pid}|#{pane_id}",
    ]) else {
        return false;
    };
    let candidates: Vec<_> = clients
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.split('|').collect();
            if parts.len() != 3 {
                return None;
            }
            Some((parts[1].parse::<u32>().ok()?, parts[2]))
        })
        .filter(|(pid, _)| terminal_app_pid(*pid) == Some(frontmost))
        .collect();
    !candidates.is_empty() && candidates.iter().all(|(_, active)| *active == pane)
}

fn tail(path: &str) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(64 * 1024)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(64 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<_> = text.lines().rev().take(200).collect();
    Ok(lines.into_iter().rev().collect::<Vec<_>>().join("\n"))
}
