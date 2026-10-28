/**
 * Runtime translation of the player UI. The app's source strings are English; every string that reaches the page
 * (static HTML, menus, toasts, effect panel) is looked up here by its exact English text and replaced when the page
 * language (<html lang>) is German, Polish or Czech. Unknown strings stay English.
 */
type Lang = 'de' | 'pl' | 'cs';
const LANGS: Lang[] = ['de', 'pl', 'cs'];

// [English, German, Polish, Czech]
const EXACT: Array<[string, string, string, string]> = [
  ['Open', 'Öffnen', 'Otwórz', 'Otevřít'],
  ['Folder', 'Ordner', 'Folder', 'Složka'],
  ['URL', 'URL', 'URL', 'URL'],
  ['Open files', 'Dateien öffnen', 'Otwórz pliki', 'Otevřít soubory'],
  ['Open folder', 'Ordner öffnen', 'Otwórz folder', 'Otevřít složku'],
  ['Open files (O)', 'Dateien öffnen (O)', 'Otwórz pliki (O)', 'Otevřít soubory (O)'],
  ['Open a network address (U)', 'Netzwerkadresse öffnen (U)', 'Otwórz adres sieciowy (U)', 'Otevřít síťovou adresu (U)'],
  ['Install this app', 'App installieren', 'Zainstaluj aplikację', 'Nainstalovat aplikaci'],
  ['Install', 'Installieren', 'Zainstaluj', 'Nainstalovat'],
  ['Theme', 'Design', 'Motyw', 'Motiv'],
  ['Media information (I)', 'Medieninformationen (I)', 'Informacje o pliku (I)', 'Informace o médiu (I)'],
  ['Playlist (Shift+L)', 'Wiedergabeliste (Umschalt+L)', 'Lista odtwarzania (Shift+L)', 'Seznam skladeb (Shift+L)'],
  ['Player', 'Player', 'Odtwarzacz', 'Přehrávač'],
  ['Drop files here, or open them from your device. Everything plays inside this page — nothing is uploaded.', 'Dateien hierher ziehen oder vom Gerät öffnen. Alles wird direkt auf dieser Seite abgespielt – nichts wird hochgeladen.', 'Upuść pliki tutaj lub otwórz je z urządzenia. Wszystko odtwarza się na tej stronie – nic nie jest przesyłane.', 'Přetáhněte soubory sem nebo je otevřete ze zařízení. Vše se přehrává přímo na této stránce – nic se nenahrává.'],
  ['Got it', 'Verstanden', 'Rozumiem', 'Rozumím'],
  ['MP4, WebM, MKV, MOV, AVI, WMV, FLV, MPEG, TS, MP3, FLAC, WAV, OGG, M4A, WMA and more', 'MP4, WebM, MKV, MOV, AVI, WMV, FLV, MPEG, TS, MP3, FLAC, WAV, OGG, M4A, WMA und mehr', 'MP4, WebM, MKV, MOV, AVI, WMV, FLV, MPEG, TS, MP3, FLAC, WAV, OGG, M4A, WMA i inne', 'MP4, WebM, MKV, MOV, AVI, WMV, FLV, MPEG, TS, MP3, FLAC, WAV, OGG, M4A, WMA a další'],
  ['Seek', 'Position', 'Przewiń', 'Přetáčení'],
  ['Volume', 'Lautstärke', 'Głośność', 'Hlasitost'],
  ['Previous (P)', 'Zurück (P)', 'Poprzedni (P)', 'Předchozí (P)'],
  ['Play / pause (Space)', 'Wiedergabe / Pause (Leertaste)', 'Odtwarzaj / pauza (spacja)', 'Přehrát / pozastavit (mezerník)'],
  ['Next (N)', 'Weiter (N)', 'Następny (N)', 'Další (N)'],
  ['Mute (M)', 'Stumm (M)', 'Wycisz (M)', 'Ztlumit (M)'],
  ['Loop A–B (A)', 'Wiederholung A–B (A)', 'Pętla A–B (A)', 'Smyčka A–B (A)'],
  ['Chapters and bookmarks (B adds a bookmark)', 'Kapitel und Lesezeichen (B setzt ein Lesezeichen)', 'Rozdziały i zakładki (B dodaje zakładkę)', 'Kapitoly a záložky (B přidá záložku)'],
  ['Audio track (T)', 'Tonspur (T)', 'Ścieżka dźwiękowa (T)', 'Zvuková stopa (T)'],
  ['Speed ([ and ])', 'Geschwindigkeit ([ und ])', 'Prędkość ([ i ])', 'Rychlost ([ a ])'],
  ['Subtitles (C)', 'Untertitel (C)', 'Napisy (C)', 'Titulky (C)'],
  ['Stream quality', 'Streamqualität', 'Jakość strumienia', 'Kvalita streamu'],
  ['Snapshot (S)', 'Standbild (S)', 'Zrzut klatki (S)', 'Snímek (S)'],
  ['Cast / AirPlay', 'Cast / AirPlay', 'Cast / AirPlay', 'Cast / AirPlay'],
  ['Picture in picture', 'Bild-in-Bild', 'Obraz w obrazie', 'Obraz v obraze'],
  ['Audio and video effects (E)', 'Audio- und Videoeffekte (E)', 'Efekty audio i wideo (E)', 'Audio a video efekty (E)'],
  ['Full screen (F)', 'Vollbild (F)', 'Pełny ekran (F)', 'Celá obrazovka (F)'],
  ['Effects', 'Effekte', 'Efekty', 'Efekty'],
  ['Audio', 'Audio', 'Dźwięk', 'Zvuk'],
  ['Video', 'Video', 'Wideo', 'Video'],
  ['Close', 'Schließen', 'Zamknij', 'Zavřít'],
  ['Playlist', 'Wiedergabeliste', 'Lista odtwarzania', 'Seznam skladeb'],
  ['Shuffle', 'Zufällig', 'Losowo', 'Náhodně'],
  ['Repeat', 'Wiederholen', 'Powtarzaj', 'Opakovat'],
  ['Add files', 'Dateien hinzufügen', 'Dodaj pliki', 'Přidat soubory'],
  ['Clear playlist', 'Wiedergabeliste leeren', 'Wyczyść listę', 'Vymazat seznam'],
  ['Nothing queued yet.', 'Noch nichts in der Warteschlange.', 'Nic jeszcze nie ma w kolejce.', 'Zatím nic ve frontě.'],
  ['Remove', 'Entfernen', 'Usuń', 'Odebrat'],
  ['A new version is ready.', 'Eine neue Version ist bereit.', 'Dostępna jest nowa wersja.', 'Je dostupná nová verze.'],
  ['Reload', 'Neu laden', 'Odśwież', 'Znovu načíst'],
  ['Open a network address', 'Netzwerkadresse öffnen', 'Otwórz adres sieciowy', 'Otevřít síťovou adresu'],
  ['A direct link to a video or audio file, an HLS playlist (.m3u8) or a DASH manifest (.mpd). The server must allow other websites to read it (CORS) for adaptive streams.', 'Ein direkter Link zu einer Video- oder Audiodatei, einer HLS-Playlist (.m3u8) oder einem DASH-Manifest (.mpd). Der Server muss bei adaptiven Streams den Zugriff durch andere Websites erlauben (CORS).', 'Bezpośredni link do pliku wideo lub audio, listy HLS (.m3u8) albo manifestu DASH (.mpd). W przypadku strumieni adaptacyjnych serwer musi zezwalać innym stronom na odczyt (CORS).', 'Přímý odkaz na video nebo zvukový soubor, playlist HLS (.m3u8) nebo manifest DASH (.mpd). U adaptivních streamů musí server povolit čtení z jiných webů (CORS).'],
  ['Play', 'Abspielen', 'Odtwórz', 'Přehrát'],
  ['Pause', 'Pause', 'Pauza', 'Pozastavit'],
  ['Cancel', 'Abbrechen', 'Anuluj', 'Zrušit'],
  ['Media information', 'Medieninformationen', 'Informacje o pliku', 'Informace o médiu'],
  ['Inside the file', 'In der Datei', 'W pliku', 'V souboru'],
  ['Off', 'Aus', 'Wyłączone', 'Vypnuto'],
  ['Later  (+0.1 s)', 'Später  (+0,1 s)', 'Później  (+0,1 s)', 'Později  (+0,1 s)'],
  ['Earlier  (−0.1 s)', 'Früher  (−0,1 s)', 'Wcześniej  (−0,1 s)', 'Dříve  (−0,1 s)'],
  ['Tip: drop .srt/.vtt/.ass files, or name them like the video.', 'Tipp: .srt/.vtt/.ass-Dateien hierher ziehen oder wie das Video benennen.', 'Wskazówka: upuść pliki .srt/.vtt/.ass lub nazwij je tak jak wideo.', 'Tip: přetáhněte soubory .srt/.vtt/.ass nebo je pojmenujte stejně jako video.'],
  ['Chapters', 'Kapitel', 'Rozdziały', 'Kapitoly'],
  ['Bookmarks', 'Lesezeichen', 'Zakładki', 'Záložky'],
  ['Remove bookmark', 'Lesezeichen entfernen', 'Usuń zakładkę', 'Odebrat záložku'],
  ['Accent colour', 'Akzentfarbe', 'Kolor akcentu', 'Barva zvýraznění'],
  ['Equalizer preset', 'Equalizer-Voreinstellung', 'Ustawienie korektora', 'Předvolba ekvalizéru'],
  ['Aspect ratio', 'Seitenverhältnis', 'Proporcje obrazu', 'Poměr stran'],
  // messages
  ['End of playlist', 'Ende der Wiedergabeliste', 'Koniec listy odtwarzania', 'Konec seznamu skladeb'],
  ['No audio or video files found.', 'Keine Audio- oder Videodateien gefunden.', 'Nie znaleziono plików audio ani wideo.', 'Nenalezeny žádné zvukové ani video soubory.'],
  ['Muted', 'Stumm', 'Wyciszono', 'Ztlumeno'],
  ['Loop off', 'Wiederholung aus', 'Pętla wyłączona', 'Smyčka vypnuta'],
  ['Subtitles off', 'Untertitel aus', 'Napisy wyłączone', 'Titulky vypnuty'],
  ['Snapshot saved', 'Standbild gespeichert', 'Zapisano zrzut klatki', 'Snímek uložen'],
  ['Shuffle on', 'Zufall an', 'Losowo włączone', 'Náhodně zapnuto'],
  ['Shuffle off', 'Zufall aus', 'Losowo wyłączone', 'Náhodně vypnuto'],
  ['Reading subtitles…', 'Untertitel werden gelesen …', 'Odczytywanie napisów…', 'Čtení titulků…'],
  ['That subtitle track is empty.', 'Diese Untertitelspur ist leer.', 'Ta ścieżka napisów jest pusta.', 'Tato stopa titulků je prázdná.'],
  ['Could not read that subtitle track.', 'Die Untertitelspur konnte nicht gelesen werden.', 'Nie można odczytać tej ścieżki napisów.', 'Stopu titulků se nepodařilo přečíst.'],
  ['Only one audio track', 'Nur eine Tonspur', 'Tylko jedna ścieżka dźwiękowa', 'Pouze jedna zvuková stopa'],
  ['Already bookmarked', 'Bereits als Lesezeichen gesetzt', 'Zakładka już istnieje', 'Záložka již existuje'],
  ['No cast or AirPlay devices were found.', 'Keine Cast- oder AirPlay-Geräte gefunden.', 'Nie znaleziono urządzeń Cast ani AirPlay.', 'Nebyla nalezena žádná zařízení Cast ani AirPlay.'],
  ['Enter a web address starting with http:// or https://.', 'Geben Sie eine Webadresse ein, die mit http:// oder https:// beginnt.', 'Wpisz adres internetowy zaczynający się od http:// lub https://.', 'Zadejte webovou adresu začínající http:// nebo https://.'],
  ['Installed. Open it from your home screen or app list.', 'Installiert. Öffnen Sie die App über den Home-Bildschirm oder die App-Liste.', 'Zainstalowano. Otwórz aplikację z ekranu głównego lub listy aplikacji.', 'Nainstalováno. Otevřete aplikaci z domovské obrazovky nebo seznamu aplikací.'],
  ['Could not open the shared file.', 'Die geteilte Datei konnte nicht geöffnet werden.', 'Nie można otworzyć udostępnionego pliku.', 'Sdílený soubor se nepodařilo otevřít.'],
  ['Ready to work offline.', 'Bereit für den Offline-Betrieb.', 'Gotowe do pracy offline.', 'Připraveno pro offline použití.'],
  ['Speed can’t be changed with the built-in player', 'Mit dem integrierten Player lässt sich die Geschwindigkeit nicht ändern', 'Wbudowany odtwarzacz nie pozwala zmienić prędkości', 'Vestavěný přehrávač neumožňuje změnu rychlosti'],
  ['Picture-in-picture isn’t available here.', 'Bild-in-Bild ist hier nicht verfügbar.', 'Obraz w obrazie nie jest tutaj dostępny.', 'Obraz v obraze zde není k dispozici.'],
  ['2× speed', '2× Geschwindigkeit', 'Prędkość 2×', 'Rychlost 2×'],
  // effects panel
  ['Equalizer and effects on', 'Equalizer und Effekte an', 'Korektor i efekty włączone', 'Ekvalizér a efekty zapnuty'],
  ['Preamp', 'Vorverstärkung', 'Przedwzmacniacz', 'Předzesilení'],
  ['Sound', 'Klang', 'Dźwięk', 'Zvuk'],
  ['Night mode (even out loud and quiet parts)', 'Nachtmodus (laute und leise Stellen angleichen)', 'Tryb nocny (wyrównuje głośne i ciche fragmenty)', 'Noční režim (vyrovná hlasité a tiché pasáže)'],
  ['Play as mono', 'Als Mono wiedergeben', 'Odtwarzaj jako mono', 'Přehrávat jako mono'],
  ['Balance', 'Balance', 'Balans', 'Vyvážení'],
  ['Reset audio', 'Audio zurücksetzen', 'Resetuj dźwięk', 'Obnovit zvuk'],
  ['Colour', 'Farbe', 'Kolor', 'Barva'],
  ['Brightness', 'Helligkeit', 'Jasność', 'Jas'],
  ['Contrast', 'Kontrast', 'Kontrast', 'Kontrast'],
  ['Saturation', 'Sättigung', 'Nasycenie', 'Sytost'],
  ['Hue', 'Farbton', 'Odcień', 'Odstín'],
  ['Gamma', 'Gamma', 'Gamma', 'Gama'],
  ['Sharpen', 'Schärfen', 'Wyostrzenie', 'Doostření'],
  ['Black and white', 'Schwarzweiß', 'Czarno-biały', 'Černobílé'],
  ['Invert colours', 'Farben invertieren', 'Odwróć kolory', 'Invertovat barvy'],
  ['Picture', 'Bild', 'Obraz', 'Obraz'],
  ['Zoom', 'Zoom', 'Powiększenie', 'Přiblížení'],
  ['Rotate ⟲', 'Drehen ⟲', 'Obróć ⟲', 'Otočit ⟲'],
  ['Rotate ⟳', 'Drehen ⟳', 'Obróć ⟳', 'Otočit ⟳'],
  ['Flip ↔', 'Spiegeln ↔', 'Odbij ↔', 'Překlopit ↔'],
  ['Flip ↕', 'Spiegeln ↕', 'Odbij ↕', 'Překlopit ↕'],
  ['Reset video', 'Video zurücksetzen', 'Resetuj wideo', 'Obnovit video'],
  ['Drag the picture to move it when zoomed in. Double-click a slider to reset it.', 'Bild bei Zoom per Ziehen verschieben. Doppelklick auf einen Regler setzt ihn zurück.', 'Po powiększeniu przeciągnij obraz, aby go przesunąć. Dwukrotne kliknięcie suwaka resetuje go.', 'Po přiblížení obraz posunete tažením. Dvojklik na posuvník jej obnoví.'],
  ['Original', 'Original', 'Oryginalne', 'Původní'],
  ['Fill (crop)', 'Füllen (zuschneiden)', 'Wypełnij (przytnij)', 'Vyplnit (oříznout)'],
  ['Stretch', 'Strecken', 'Rozciągnij', 'Roztáhnout'],
  ['Flat', 'Flach', 'Płaski', 'Plochý'],
  ['Bass boost', 'Bassverstärkung', 'Wzmocnienie basów', 'Zdůraznění basů'],
  ['Treble boost', 'Höhenverstärkung', 'Wzmocnienie wysokich tonów', 'Zdůraznění výšek'],
  ['Vocal', 'Gesang', 'Wokal', 'Zpěv'],
  ['Speech', 'Sprache', 'Mowa', 'Řeč'],
  ['Rock', 'Rock', 'Rock', 'Rock'],
  ['Pop', 'Pop', 'Pop', 'Pop'],
  ['Dance', 'Dance', 'Dance', 'Dance'],
  ['Classical', 'Klassik', 'Klasyka', 'Klasika'],
  ['Laptop', 'Laptop', 'Laptop', 'Notebook'],
  ['Auto', 'Automatisch', 'Automatyczny', 'Automaticky'],
  ['Light', 'Hell', 'Jasny', 'Světlý'],
  ['Dark', 'Dunkel', 'Ciemny', 'Tmavý'],
];

// Messages that contain a value: matched on the start (prefix) and translated up to the value.
const PREFIX: Array<[string, string, string, string]> = [
  ['Subtitles: ', 'Untertitel: ', 'Napisy: ', 'Titulky: '],
  ['Audio: ', 'Ton: ', 'Dźwięk: ', 'Zvuk: '],
  ['Quality: ', 'Qualität: ', 'Jakość: ', 'Kvalita: '],
  ['Aspect: ', 'Seitenverhältnis: ', 'Proporcje: ', 'Poměr stran: '],
  ['Volume ', 'Lautstärke ', 'Głośność ', 'Hlasitost '],
  ['Speed ', 'Geschwindigkeit ', 'Prędkość ', 'Rychlost '],
  ['Brightness ', 'Helligkeit ', 'Jasność ', 'Jas '],
  ['Repeat: ', 'Wiederholen: ', 'Powtarzanie: ', 'Opakování: '],
  ['Repeat ', 'Wiederholen: ', 'Powtarzanie: ', 'Opakování: '],
  ['Resumed at ', 'Fortgesetzt bei ', 'Wznowiono od ', 'Pokračuje od '],
  ['Loop start ', 'Wiederholung ab ', 'Początek pętli ', 'Začátek smyčky '],
  ['Looping ', 'Wiederholung ', 'Pętla ', 'Smyčka '],
  ['Delay ', 'Verzögerung ', 'Opóźnienie ', 'Zpoždění '],
  ['Bookmark added at ', 'Lesezeichen gesetzt bei ', 'Dodano zakładkę w ', 'Záložka přidána v '],
  ['Bookmark ', 'Lesezeichen ', 'Zakładka ', 'Záložka '],
  ['Reading subtitles… ', 'Untertitel werden gelesen … ', 'Odczytywanie napisów… ', 'Čtení titulků… '],
  ['Accent ', 'Akzent ', 'Akcent ', 'Zvýraznění '],
];

const REGEX: Array<[RegExp, string, string, string]> = [
  [/^Added (\d+) to the playlist\.$/, '$1 zur Wiedergabeliste hinzugefügt.', 'Dodano do listy: $1.', 'Přidáno do seznamu: $1.'],
  [/^Can’t play “(.*)”: (.*)$/, '„$1“ kann nicht abgespielt werden: $2', 'Nie można odtworzyć „$1”: $2', 'Soubor „$1“ nelze přehrát: $2'],
  [/^(\d+) lines$/, '$1 Zeilen', '$1 wierszy', '$1 řádků'],
];

const lang = (document.documentElement.lang || 'en').slice(0, 2) as Lang;
const col = LANGS.indexOf(lang);
const exact = new Map<string, string>();
if (col >= 0) for (const row of EXACT) exact.set(row[0], row[col + 1]);

export function tr(text: string): string {
  if (col < 0) return text;
  const s = text.trim();
  if (!s || /^\d/.test(s)) return text;
  const hit = exact.get(s);
  if (hit !== undefined) return text.replace(s, hit);
  for (const [en, ...rest] of PREFIX) if (s.startsWith(en)) return text.replace(en, rest[col]);
  for (const [re, ...rest] of REGEX) if (re.test(s)) return text.replace(s, s.replace(re, rest[col]));
  return text;
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    const t = root as Text;
    const v = tr(t.data);
    if (v !== t.data) t.data = v;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  for (const a of ['title', 'aria-label', 'placeholder']) {
    const cur = el.getAttribute(a);
    if (cur) {
      const v = tr(cur);
      if (v !== cur) el.setAttribute(a, v);
    }
  }
  for (const c of el.childNodes) walk(c);
}

if (col >= 0) {
  const start = () => {
    walk(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach(walk);
        else if (r.type === 'characterData') walk(r.target);
        else walk(r.target);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}
