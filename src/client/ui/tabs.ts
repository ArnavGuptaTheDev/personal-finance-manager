// Keyboard-accessible tabs (arrow keys move between tabs) for the Tabs component.
export function bindTabs(list: HTMLElement, onChange: (value: string) => void) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  const select = (tab: HTMLButtonElement, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    if (focus) tab.focus();
    onChange(tab.dataset.value ?? '');
  };
  list.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('[role=tab]');
    if (tab) select(tab);
  });
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length]!, true);
  });
}
