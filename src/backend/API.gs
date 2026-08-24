// ============================================================
// API.gs — Google Apps Script API Layer (CORS Backend)
// ============================================================

/**
 * HTTP POST Entry Point for external API access (e.g., Cloudflare Pages).
 * Processes JSON requests, maps arguments, and safely invokes backend functions.
 */
function doPost(e) {
  try {
    // 1. Validate action parameter
    var action = e.parameter.action;
    if (!action) {
      throw new Error("Parameter 'action' tidak ditemukan.");
    }

    // 2. Parse JSON Payload
    var payload = {};
    if (e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (err) {
        throw new Error("Payload JSON tidak valid.");
      }
    }

    // 3. Whitelist of allowed API handlers
    // DO NOT allow dynamic execution using eval() or global[action]
    var API_HANDLERS = {
      login: login,
      logout: logout,
      changePassword: changePassword,
      forceChangePassword: forceChangePassword,
      checkSession: checkSession,
      getUserProfile: getUserProfile,
      adminGetDashboardStats: adminGetDashboardStats,
      adminGetLogAktivitas: adminGetLogAktivitas,
      adminGetAllPegawai: adminGetAllPegawai,
      adminGetPegawaiDetail: adminGetPegawaiDetail,
      adminGetVerificationQueue: adminGetVerificationQueue,
      getMyProfile: getMyProfile,
      getMyDashboard: getMyDashboard,
      getArsipDokumenPegawai: getArsipDokumenPegawai,
      getDokumenPreview: getDokumenPreview,
      adminTambahPegawai: adminTambahPegawai,
      adminUpdatePegawai: adminUpdatePegawai,
      adminResetPassword: adminResetPassword,
      adminSetStatusAkun: adminSetStatusAkun,
      updateMyProfile: updateMyProfile,
      adminUploadFotoPegawai: adminUploadFotoPegawai,
      uploadFotoProfil: uploadFotoProfil,
      uploadDokumen: uploadDokumen,
      hapusDokumen: hapusDokumen,
      adminApproveDokumen: adminApproveDokumen,
      adminRejectDokumen: adminRejectDokumen,
      adminBackupDatabase: adminBackupDatabase,
      adminBackupFull: adminBackupFull,
      adminDeletePegawai: adminDeletePegawai,
      adminSaveFonnteToken: adminSaveFonnteToken,
      adminGetFonnteStatus: adminGetFonnteStatus,
      adminTestFonnteMessage: adminTestFonnteMessage
    };

    // 4. Validate action against whitelist
    if (typeof API_HANDLERS[action] !== 'function') {
      throw new Error("Action '" + action + "' tidak didukung atau tidak diizinkan.");
    }

    // 5. Payload Argument Mapping
    // This defines the exact order of arguments each backend function expects.
    var payloadMap = {
      login: ['nip', 'password'],
      logout: ['token'],
      changePassword: ['token', 'newPassword', 'currentPassword'],
      forceChangePassword: ['token', 'newPassword'],
      checkSession: ['token'],
      getUserProfile: ['token'],
      adminGetDashboardStats: ['token'],
      adminGetLogAktivitas: ['token'],
      adminGetAllPegawai: ['token'],
      adminGetPegawaiDetail: ['token', 'targetNip'],
      adminGetVerificationQueue: ['token'],
      getMyProfile: ['token'],
      getMyDashboard: ['token'],
      getArsipDokumenPegawai: ['token', 'targetNip'],
      getDokumenPreview: ['token', 'idArsip'],
      adminTambahPegawai: ['token', 'data'],
      adminUpdatePegawai: ['token', 'targetNip', 'updates'],
      adminResetPassword: ['token', 'targetNip'],
      adminSetStatusAkun: ['token', 'targetNip', 'newStatus'],
      updateMyProfile: ['token', 'updates'],
      adminUploadFotoPegawai: ['token', 'targetNip', 'base64Data', 'mimeType'],
      uploadFotoProfil: ['token', 'base64Data', 'mimeType'],
      uploadDokumen: ['token', 'idDokumen', 'base64Data', 'mimeType'],
      hapusDokumen: ['token', 'idArsip'],
      adminApproveDokumen: ['token', 'idArsip'],
      adminRejectDokumen: ['token', 'idArsip', 'alasanPenolakan'],
      adminBackupDatabase: ['token'],
      adminBackupFull: ['token'],
      adminDeletePegawai: ['token', 'targetNip'],
      adminSaveFonnteToken: ['token', 'fonnteToken'],
      adminGetFonnteStatus: ['token'],
      adminTestFonnteMessage: ['token']
    };

    var paramNames = payloadMap[action] || [];
    
    // Map JSON properties to an array of arguments
    var args = [];
    for (var i = 0; i < paramNames.length; i++) {
      args.push(payload[paramNames[i]]);
    }

    // 6. Call the actual backend function
    var handler = API_HANDLERS[action];
    var result = handler.apply(null, args);

    // 7. Return standardized successful response
    // GAS will automatically handle CORS headers for TextOutput with JSON MimeType
    return ContentService.createTextOutput(JSON.stringify(result !== undefined ? result : null))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    // 8. Handle errors safely and return as JSON
    var errorResponse = {
      success: false,
      message: error.message || error.toString()
    };
    return ContentService.createTextOutput(JSON.stringify(errorResponse))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
