export type SettingsNavGroup<T extends string> = {
  label: string;
  panes: { id: T; label: string; detail: string }[];
};

/**
 * Settings navigation is separate from the individual forms so adding an operator tool does
 * not turn the user-facing experience controls back into one undifferentiated chip row.
 */
export default function SettingsNav<T extends string>({
  groups,
  active,
  onSelect,
}: {
  groups: SettingsNavGroup<T>[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {groups.map((group) => (
        <div className="settings-nav-group" key={group.label}>
          <div className="settings-nav-label">{group.label}</div>
          {group.panes.map((pane) => (
            <button
              key={pane.id}
              data-active={active === pane.id}
              aria-current={active === pane.id ? 'page' : undefined}
              onClick={() => onSelect(pane.id)}
            >
              <span>{pane.label}</span>
              <small>{pane.detail}</small>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
