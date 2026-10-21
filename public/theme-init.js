// Applies the saved dark-mode opt-in before the app renders (no flash of the wrong theme).
// Light is the default and the OS colour scheme is ignored; only "dark" switches it.
// Loaded as a same-origin file because the CSP forbids inline scripts. Key: src/app/theme.tsx.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('sikap.theme');
  } catch (e) {
    theme = null;
  }
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#0d0e11');
  }
})();
