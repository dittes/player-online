// Sends visitors to the page in their language (/en/, /de/, /pl/, /cs/).
(function () {
  var supported = ['en', 'de', 'pl', 'cs'];
  var pick = 'en';
  var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  for (var i = 0; i < list.length; i++) {
    var code = String(list[i]).slice(0, 2).toLowerCase();
    if (supported.indexOf(code) >= 0) { pick = code; break; }
  }
  location.replace('/' + pick + '/' + location.search + location.hash);
})();
