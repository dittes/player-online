import './launcher.css';
import './i18n';
import { appendAboutSections, applyTheme } from './aboutmenu';
import { loadSettings } from './store';

/** Theme and the (i) menu for the launcher and the imprint pages. */
const settings = loadSettings();
applyTheme(settings);

const btn = document.getElementById('btn-about');
const menu = document.getElementById('menu-about');
if (btn && menu) {
  const close = (focus = false) => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focus) btn.focus();
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    menu.replaceChildren();
    appendAboutSections(menu, settings);
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLElement>('button, a')?.focus();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') return close(true);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menu.querySelectorAll<HTMLElement>('button, a')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
}
