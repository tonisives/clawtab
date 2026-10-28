use super::{auto_yes_option_updates, AUTO_YES_MONITOR_BELL_ORIGINAL, AUTO_YES_PANE_OPTION};
use std::collections::HashSet;

#[test]
fn unchanged_auto_yes_options_need_no_writes() {
    let panes = "%1\t@1\t1\n%2\t@1\t\n%3\t@2\t";
    let windows = "@1\t0\ton\n@2\t1\t";
    assert!(auto_yes_option_updates(panes, windows, &HashSet::from(["%1".into()])).is_empty());
}

#[test]
fn enabling_one_pane_has_constant_write_cost() {
    let panes = (0..500)
        .map(|index| format!("%{index}\t@{index}\t\n"))
        .collect::<String>();
    let windows = (0..500)
        .map(|index| format!("@{index}\t1\t\n"))
        .collect::<String>();
    let updates = auto_yes_option_updates(&panes, &windows, &HashSet::from(["%1".into()]));
    let commands: Vec<_> = updates.split(|arg| arg == ";").collect();
    assert_eq!(commands.len(), 3);
    assert_eq!(
        commands[0],
        ["set-option", "-pt", "%1", AUTO_YES_PANE_OPTION, "1"]
    );
    assert_eq!(
        commands[1],
        [
            "set-option",
            "-w",
            "-t",
            "@1",
            AUTO_YES_MONITOR_BELL_ORIGINAL,
            "on"
        ]
    );
    assert_eq!(
        commands[2],
        ["set-option", "-w", "-t", "@1", "monitor-bell", "off"]
    );
}

#[test]
fn bell_stays_suppressed_until_the_last_enabled_pane_is_disabled() {
    let panes = "%1\t@1\t1\n%2\t@1\t1";
    let windows = "@1\t0\ton\n@1\t0\ton";
    let updates = auto_yes_option_updates(panes, windows, &HashSet::from(["%2".into()]));
    assert_eq!(
        updates,
        ["set-option", "-pqu", "-t", "%1", AUTO_YES_PANE_OPTION]
    );

    let updates = auto_yes_option_updates("%1\t@1\t\n%2\t@1\t1", windows, &HashSet::new());
    let commands: Vec<_> = updates.split(|arg| arg == ";").collect();
    assert_eq!(
        commands.len(),
        3,
        "linked windows must only be restored once"
    );
    assert_eq!(
        commands[1],
        ["set-option", "-w", "-t", "@1", "monitor-bell", "on"]
    );
    assert_eq!(
        commands[2],
        [
            "set-option",
            "-wqu",
            "-t",
            "@1",
            AUTO_YES_MONITOR_BELL_ORIGINAL
        ]
    );
}

#[test]
fn originally_disabled_bells_remain_disabled() {
    let enabled = HashSet::from(["%1".into()]);
    let updates = auto_yes_option_updates("%1\t@1\t", "@1\t0\t", &enabled);
    let commands: Vec<_> = updates.split(|arg| arg == ";").collect();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[1].last().unwrap(), "off");

    let updates = auto_yes_option_updates("%1\t@1\t", "@1\t0\toff", &HashSet::new());
    assert_eq!(
        updates,
        [
            "set-option",
            "-wqu",
            "-t",
            "@1",
            AUTO_YES_MONITOR_BELL_ORIGINAL
        ]
    );
}
