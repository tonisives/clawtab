use super::*;

fn remote_enabled(settings: &crate::config::settings::AppSettings, record: &NfnRecord) -> bool {
    if record
        .request
        .channels
        .iter()
        .any(|channel| channel == "mobile")
    {
        return true;
    }
    if !record.request.channel("desktop") {
        return false;
    }
    if record.request.data["event"] == "agent_finished" {
        settings.notify_agent_completion_remote
    } else if record.question_id.is_some() || record.request.data["event"] == "agent_alert" {
        settings.notify_questions_remote
    } else {
        true
    }
}

fn mobile_due(settings: &NfnSettings, platform: &PlatformState, record: &NfnRecord) -> bool {
    if !record.pending()
        || record.ignored
        || record.status == "delivering"
        || record.dismissed_at.is_some()
        || record
            .request
            .expires_at
            .is_some_and(|until| until <= now())
    {
        return false;
    }
    if record
        .request
        .channels
        .iter()
        .any(|channel| channel == "mobile")
    {
        return true;
    }
    if !record.request.channel("desktop") {
        return false;
    }
    settings.mobile_when_idle
        && (platform.screen_sleeping
            || platform.screen_locked
            || (platform.available
                && (!platform.user_active
                    || platform.idle_seconds >= u64::from(settings.idle_seconds)))
            || !cfg!(target_os = "macos"))
}

fn retryable(record: &NfnRecord, channel: &str) -> bool {
    record.deliveries.get(channel).is_none_or(|delivery| {
        matches!(delivery.status.as_str(), "failed" | "queued" | "sending")
            && now() - delivery.updated_at >= 60_000
    })
}

impl Service {
    pub fn publish_messages(&self, handle: &crate::relay::RelayHandle) {
        let mut records = self.store.pending_page(0).unwrap_or_default();
        for record in self.store.list(0).unwrap_or_default() {
            if !records.iter().any(|existing| existing.id == record.id) {
                records.push(record);
            }
        }
        let mut bytes = 0;
        let records = records
            .into_iter()
            .filter(|record| record.request.channel("mobile") || record.request.channel("desktop"))
            .filter_map(|record| {
                let value = serde_json::to_value(record).ok()?;
                bytes += value.to_string().len();
                (bytes < 1024 * 1024).then_some(value)
            })
            .collect();
        handle.send_message(&clawtab_protocol::DesktopMessage::MessagesChanged { records });
    }

    pub(super) fn dispatch_pending(&self) {
        let Ok(_guard) = self.mutation.try_lock() else {
            return;
        };
        let settings = self.ctx.settings.lock().clone();
        let platform = self.platform.lock().clone();
        for mut record in self.store.pending().unwrap_or_default() {
            if record.status != "pending"
                || record.ignored
                || record.dismissed_at.is_some()
                || record
                    .request
                    .expires_at
                    .is_some_and(|until| until <= now())
            {
                continue;
            }
            if remote_enabled(&settings, &record)
                && mobile_due(&settings.enhanced_notifications, &platform, &record)
                && retryable(&record, "mobile")
            {
                let sent = self.ctx.relay.lock().as_ref().is_some_and(|handle| {
                    handle
                        .send_raw(
                            json!({"type":"message_notification","record":record}).to_string(),
                        )
                        .is_ok()
                });
                if sent {
                    record.deliveries.insert(
                        "mobile".into(),
                        MessageDelivery {
                            status: "queued".into(),
                            updated_at: now(),
                            ..Default::default()
                        },
                    );
                    let _ = self.store.save_delivery(
                        &record.id,
                        "mobile",
                        &record.deliveries["mobile"],
                    );
                }
            }
            if record
                .request
                .channels
                .iter()
                .any(|channel| channel == "telegram")
            {
                let Some(config) = settings
                    .telegram
                    .clone()
                    .filter(|config| !config.bot_token.is_empty())
                else {
                    continue;
                };
                let targets = record
                    .request
                    .telegram_chat_id
                    .map_or_else(|| config.chat_ids.clone(), |chat| vec![chat]);
                for target in targets {
                    let key = format!("telegram:{target}");
                    if !retryable(&record, &key) {
                        continue;
                    }
                    record.deliveries.insert(
                        key.clone(),
                        MessageDelivery {
                            status: "sending".into(),
                            updated_at: now(),
                            target: Some(target),
                            ..Default::default()
                        },
                    );
                    if self
                        .store
                        .save_delivery(&record.id, &key, &record.deliveries[&key])
                        .is_err()
                    {
                        continue;
                    }
                    let Some(service) = service().cloned() else {
                        continue;
                    };
                    let record = record.clone();
                    let token = config.bot_token.clone();
                    tokio::spawn(async move {
                        let result =
                            crate::telegram::send_clawtab_message(&token, target, &record).await;
                        let _guard = service.mutation.lock().await;
                        if let Ok(mut current) = service.store.get(&record.id) {
                            let delivery = current.deliveries.entry(key.clone()).or_default();
                            delivery.updated_at = now();
                            match result {
                                Ok(ids) => {
                                    delivery.status = "sent".into();
                                    delivery.external_id = ids.last().copied();
                                    delivery.external_ids = ids;
                                    delivery.error = None;
                                }
                                Err(error) => {
                                    delivery.status = "failed".into();
                                    delivery.error = Some(error);
                                }
                            }
                            let _ = service.store.save_delivery(&current.id, &key, delivery);
                            service.changed();
                        }
                    });
                }
            }
        }
        for mut record in self.store.deliveries_to_close().unwrap_or_default() {
            if record.pending() && record.dismissed_at.is_none() {
                continue;
            }
            let keys: Vec<_> = record
                .deliveries
                .keys()
                .filter(|key| key.starts_with("telegram:"))
                .cloned()
                .collect();
            for key in keys {
                let delivery = record.deliveries.get_mut(&key).unwrap();
                if delivery.status != "sent"
                    && !(matches!(delivery.status.as_str(), "close_failed" | "closing")
                        && now() - delivery.updated_at > 60_000)
                {
                    continue;
                }
                let (Some(config), Some(chat)) = (settings.telegram.clone(), delivery.target)
                else {
                    continue;
                };
                let ids = delivery.external_ids.clone();
                delivery.status = "closing".into();
                delivery.updated_at = now();
                if self
                    .store
                    .save_delivery(&record.id, &key, delivery)
                    .is_err()
                {
                    continue;
                }
                let Some(service) = service().cloned() else {
                    continue;
                };
                let record = record.clone();
                tokio::spawn(async move {
                    let mut result = Ok(());
                    for id in ids {
                        if let Err(error) =
                            crate::telegram::clear_clawtab_message(&config.bot_token, chat, id)
                                .await
                        {
                            result = Err(error);
                        }
                    }
                    let _guard = service.mutation.lock().await;
                    if let Ok(mut current) = service.store.get(&record.id) {
                        if let Some(delivery) = current.deliveries.get_mut(&key) {
                            delivery.status = if result.is_ok() {
                                "closed"
                            } else {
                                "close_failed"
                            }
                            .into();
                            delivery.error = result.err();
                            delivery.updated_at = now();
                            let _ = service.store.save_delivery(&current.id, &key, delivery);
                        }
                    }
                });
            }
        }
    }

    pub async fn mobile_receipt(&self, id: &str, status: &str, error: Option<String>) {
        if !matches!(status, "sent" | "failed") {
            return;
        }
        let _guard = self.mutation.lock().await;
        if let Ok(mut record) = self.store.get(id) {
            if let Some(delivery) = record.deliveries.get_mut("mobile") {
                delivery.status = status.into();
                delivery.updated_at = now();
                delivery.error = error;
                let _ = self.store.save_delivery(&record.id, "mobile", delivery);
                self.broadcast();
            }
        }
    }

    pub async fn telegram_reply(
        &self,
        chat: i64,
        id: Option<&str>,
        external: Option<i64>,
        index: Option<usize>,
        text: Option<String>,
    ) -> Option<Result<Value, String>> {
        let record = if let Some(id) = id {
            self.store.get(id).ok()
        } else {
            let mut records = self.store.pending().unwrap_or_default();
            records.extend(self.store.list(0).unwrap_or_default());
            records.into_iter().find(|record| {
                record.deliveries.values().any(|delivery| {
                    delivery.target == Some(chat)
                        && (delivery.external_id == external
                            || external.is_some_and(|id| delivery.external_ids.contains(&id)))
                })
            })
        }?;
        if !record
            .deliveries
            .values()
            .any(|delivery| delivery.target == Some(chat))
        {
            return Some(Err("Message belongs to another chat".into()));
        }
        if !record.pending() || record.dismissed_at.is_some() {
            return Some(Err("Message already resolved".into()));
        }
        let command = if !record.request.needs_response() {
            NfnCommand::Dismiss { id: record.id }
        } else {
            let action_id = if let Some(index) = index {
                match record.request.actions.get(index) {
                    Some(action) if action.kind == "choice" => action.id.clone(),
                    _ => return Some(Err("Unknown message choice".into())),
                }
            } else {
                "reply".into()
            };
            NfnCommand::Respond {
                id: record.id,
                action_id,
                text,
            }
        };
        Some(self.execute(command).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_delivery_keeps_the_same_request_and_stops_after_resolution_or_dismissal() {
        let mut record = NfnRecord {
            id: "one".into(),
            request: NfnRequest {
                title: "Question".into(),
                ..Default::default()
            },
            status: "pending".into(),
            response: None,
            created_at: 0,
            updated_at: 0,
            read_at: Some(1),
            dismissed_at: None,
            ignored: false,
            error: None,
            question_id: None,
            deliveries: Default::default(),
        };
        let settings = NfnSettings::default();
        let mut platform = PlatformState {
            available: true,
            user_active: true,
            ..Default::default()
        };
        if cfg!(target_os = "macos") {
            assert!(!mobile_due(&settings, &platform, &record));
        }
        platform.idle_seconds = 60;
        assert!(mobile_due(&settings, &platform, &record));
        record.ignored = true;
        assert!(!mobile_due(&settings, &platform, &record));
        record.ignored = false;
        platform.idle_seconds = 0;
        platform.screen_locked = true;
        assert!(mobile_due(&settings, &platform, &record));
        platform.screen_locked = false;
        platform.screen_sleeping = true;
        assert!(mobile_due(&settings, &platform, &record));
        let disabled = NfnSettings {
            mobile_when_idle: false,
            ..settings.clone()
        };
        assert!(!mobile_due(&disabled, &platform, &record));
        record.deliveries.insert(
            "mobile".into(),
            MessageDelivery {
                status: "sent".into(),
                updated_at: now(),
                ..Default::default()
            },
        );
        assert!(!retryable(&record, "mobile"));
        record.deliveries.get_mut("mobile").unwrap().status = "queued".into();
        assert!(!retryable(&record, "mobile"));
        record.deliveries.get_mut("mobile").unwrap().updated_at = now() - 61_000;
        assert!(retryable(&record, "mobile"));
        record.dismissed_at = Some(2);
        assert!(!mobile_due(&settings, &platform, &record));
        record.dismissed_at = None;
        record.status = "resolved".into();
        assert!(!mobile_due(&settings, &platform, &record));
        record.status = "pending".into();
        record.request.channels = vec!["telegram".into()];
        assert!(!mobile_due(&settings, &platform, &record));
        record.request.channels = vec!["mobile".into()];
        platform.screen_sleeping = false;
        assert!(mobile_due(&settings, &platform, &record));
        assert!(mobile_due(&disabled, &platform, &record));
        record.request.channels.push("desktop".into());
        record.request.data = json!({"event":"agent_finished"});
        let app_settings = crate::config::settings::AppSettings {
            notify_agent_completion_remote: false,
            ..Default::default()
        };
        assert!(remote_enabled(&app_settings, &record));
        record.request.channels = vec!["desktop".into()];
        assert!(!remote_enabled(&app_settings, &record));
    }
}
