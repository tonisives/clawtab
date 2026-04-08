const shortcuts: { label: string; keys: string[] }[] = [
  { label: "Next sidebar item", keys: ["Tab"] },
  { label: "Previous sidebar item", keys: ["Shift", "Tab"] },
  { label: "Toggle sidebar", keys: ["Cmd", "E"] },
  { label: "Split pane vertically", keys: ["Ctrl", "V"] },
  { label: "Split pane horizontally", keys: ["Ctrl", "S"] },
  { label: "Move to left pane", keys: ["Cmd", "H"] },
  { label: "Move to pane below", keys: ["Cmd", "J"] },
  { label: "Move to pane above", keys: ["Cmd", "K"] },
  { label: "Move to right pane", keys: ["Cmd", "L"] },
];

export function ShortcutsPanel() {
  return (
    <div className="settings-section">
      <h2>Keyboard Shortcuts</h2>
      <div className="field-group">
        <span className="field-group-title">General</span>
        <table className="shortcuts-table">
          <tbody>
            {shortcuts.map((s) => (
              <tr key={s.label}>
                <td className="shortcut-label">{s.label}</td>
                <td className="shortcut-keys">
                  {s.keys.map((k, i) => (
                    <span key={i}>
                      {i > 0 && <span className="shortcut-plus">+</span>}
                      <kbd>{k}</kbd>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
