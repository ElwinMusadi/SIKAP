// ============================================================
// Main.gs — Google Apps Script Entry Point
// SIKAP - Sistem Informasi Kepegawaian dan Arsip Pegawai
// UPTD Pendapatan Daerah Wilayah Kota Kupang
// ============================================================

/**
 * Serves the main SPA HTML page.
 * This is the single entry point for the web application.
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('SIKAP — Sistem Informasi Kepegawaian')
    .setFaviconUrl('https://www.google.com/s2/favicons?domain=nttprov.go.id')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Includes an HTML file as a template partial.
 * Used by Index.html to modularize the SPA into separate files.
 * @param {string} filename - The name of the HTML file to include (without .html extension).
 * @returns {string} The evaluated HTML content of the file.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
