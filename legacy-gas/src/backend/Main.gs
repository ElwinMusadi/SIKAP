// ============================================================
// Main.gs — Google Apps Script Entry Point
// SIKAP - Sistem Informasi Kepegawaian dan Arsip Pegawai
// UPTD Pendapatan Daerah Wilayah Kota Kupang
// ============================================================

// AKfycbxgtqzd0pU96Z7MChma9GwfW-ESy-7PDPAlsUSPMl6-oh78m1aVJ5BRl5cdyWnhfgue

/**
 * Serves the main SPA HTML page.
 * This is the single entry point for the web application.
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile("frontend/Index")
    .evaluate()
    .setTitle("SIKAP — Sistem Informasi Kepegawaian")
    .setFaviconUrl("https://raw.githubusercontent.com/ElwinMusadi/app-assets/main/logo-ntt.png")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Includes an HTML file as a template partial.
 * Used by Index.html to modularize the SPA into separate files.
 * @param {string} filename - The name of the HTML file to include (without .html extension).
 * @returns {string} The evaluated HTML content of the file.
 */
function include(filename) {
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
  } catch (e) {
    // If file not found, try checking in frontend/ folder (clasp uploads subdirectories as prefixed filenames)
    return HtmlService.createHtmlOutputFromFile("frontend/" + filename).getContent();
  }
}
