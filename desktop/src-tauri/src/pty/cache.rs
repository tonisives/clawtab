use std::collections::{HashMap, VecDeque};

pub(super) const MAX_RECENT_PANES: usize = 12;
pub(super) const MAX_CACHED_BYTES_PER_PANE: usize = 256 * 1024;

pub(super) struct RecentPaneCache {
    order: VecDeque<String>,
    entries: HashMap<String, Vec<u8>>,
}

impl RecentPaneCache {
    pub(super) fn new() -> Self {
        Self {
            order: VecDeque::new(),
            entries: HashMap::new(),
        }
    }

    fn touch(&mut self, pane_id: &str) {
        if let Some(idx) = self.order.iter().position(|id| id == pane_id) {
            self.order.remove(idx);
        }
        self.order.push_front(pane_id.to_string());
        while self.order.len() > MAX_RECENT_PANES {
            if let Some(oldest) = self.order.pop_back() {
                self.entries.remove(&oldest);
            }
        }
    }

    pub(super) fn append(&mut self, pane_id: &str, bytes: &[u8]) {
        if bytes.is_empty() {
            self.touch(pane_id);
            return;
        }

        self.touch(pane_id);
        let entry = self.entries.entry(pane_id.to_string()).or_default();
        entry.extend_from_slice(bytes);
        if entry.len() > MAX_CACHED_BYTES_PER_PANE {
            let overflow = entry.len() - MAX_CACHED_BYTES_PER_PANE;
            entry.drain(..overflow);
        }
    }

    pub(super) fn get(&mut self, pane_id: &str) -> Vec<u8> {
        if self.entries.contains_key(pane_id) {
            self.touch(pane_id);
        }
        self.entries.get(pane_id).cloned().unwrap_or_default()
    }
}
