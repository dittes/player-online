import { saveSettings, type Settings } from './store';

/** The (i) menu shared by the launcher, the imprint and the player: colours, language and the imprint. */
export const THEMES: Array<[Settings['theme'], string]> = [
  ['auto', 'Automatic (follow system)'],
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['oled', 'OLED black'],
  ['contrast', 'High contrast'],
];
export const ACCENTS: Array<[Settings['accent'], string]> = [
  ['orange', '#ff8a24'],
  ['blue', '#4c9aff'],
  ['green', '#35c27a'],
  ['pink', '#ff5c9a'],
  ['purple', '#a06bff'],
];
const LANGS: Array<[string, string]> = [['en', 'English'], ['de', 'Deutsch'], ['pl', 'Polski'], ['cs', 'Čeština']];

export function applyTheme(settings: Settings) {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = settings.theme;
  if (settings.accent === 'orange') root.removeAttribute('data-accent');
  else root.dataset.accent = settings.accent;
  // keep the browser / installed-app chrome in the same colour as the top bar
  requestAnimationFrame(() => {
    const c = getComputedStyle(root).getPropertyValue('--panel').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c || '#0f1115');
  });
}

const label = (text: string) => Object.assign(document.createElement('div'), { className: 'label', textContent: text });

/** Fills `el` (appending) with the colour choices, the language links and the imprint link. */
export function appendAboutSections(el: HTMLElement, settings: Settings) {
  const lang = (document.documentElement.lang || 'en').slice(0, 2);

  el.append(label('Colours'));
  const themeButtons: HTMLButtonElement[] = [];
  THEMES.forEach(([id, text]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(settings.theme === id));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.theme = id;
      saveSettings(settings);
      applyTheme(settings);
      themeButtons.forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    themeButtons.push(b);
    el.append(b);
  });

  el.append(label('Accent colour'));
  const row = document.createElement('div');
  row.className = 'swatches';
  ACCENTS.forEach(([id, color]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = id;
    b.setAttribute('aria-label', `Accent ${id}`);
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(settings.accent === id));
    b.style.background = color;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      settings.accent = id;
      saveSettings(settings);
      applyTheme(settings);
      row.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    row.append(b);
  });
  el.append(row, document.createElement('hr'), label('Language'));

  for (const [code, name] of LANGS) {
    const a = document.createElement('a');
    a.href = location.pathname.replace(/^\/(en|de|pl|cs)\//, `/${code}/`);
    a.hreflang = code;
    a.lang = code;
    a.textContent = name;
    a.setAttribute('role', 'menuitem');
    if (code === lang) a.setAttribute('aria-current', 'true');
    el.append(a);
  }
  el.append(document.createElement('hr'));
  const imprint = document.createElement('a');
  imprint.href = `/${lang}/imprint/`;
  imprint.textContent = 'Imprint & privacy';
  imprint.setAttribute('role', 'menuitem');
  el.append(imprint);
}
