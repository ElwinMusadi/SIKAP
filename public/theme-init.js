// Applies the saved light/dark preference before the app renders (no flash of the wrong theme).
// Loaded as a same-origin file because the CSP forbids inline scripts. Key: src/app/theme.tsx.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('sikap.theme');
  } catch (e) {
    theme = null;
  }
  var dark = theme === 'dark' || (theme !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
})();
