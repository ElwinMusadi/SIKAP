// ============================================================
// WhatsApp.gs — Fonnte WhatsApp Gateway Integration
// Handles sending WhatsApp notifications to employees.
// Token is stored securely in Script Properties.
// ============================================================

var FONNTE_API_URL = 'https://api.fonnte.com/send';
var FONNTE_TOKEN_KEY = 'FONNTE_TOKEN';
var SIKAP_APP_URL = 'https://sikap.uptdpenda-kupang.web.id/';

/**
 * Retrieves the Fonnte token from Script Properties.
 * @returns {string|null} The token, or null if not set.
 */
function _getFonnteToken() {
  try {
    return PropertiesService.getScriptProperties().getProperty(FONNTE_TOKEN_KEY);
  } catch (e) {
    Logger.log('_getFonnteToken error: ' + e.toString());
    return null;
  }
}

/**
 * Sends a WhatsApp message via Fonnte API.
 * @param {string} target - Destination phone number (e.g. '082345678901' or '6282345678901').
 * @param {string} message - The message text to send.
 * @returns {{success: boolean, message: string}} Result object.
 */
function sendFonnteMessage(target, message) {
  try {
    var token = _getFonnteToken();
    if (!token) {
      Logger.log('sendFonnteMessage: Fonnte token not configured.');
      return { success: false, message: 'Token Fonnte belum dikonfigurasi.' };
    }

    // Normalize phone number to international format (add 62 prefix if starts with 0)
    var normalizedTarget = String(target || '').replace(/\D/g, '');
    if (normalizedTarget.startsWith('0')) {
      normalizedTarget = '62' + normalizedTarget.substring(1);
    }

    if (!normalizedTarget || normalizedTarget.length < 10) {
      Logger.log('sendFonnteMessage: Invalid phone number: ' + target);
      return { success: false, message: 'Nomor HP tidak valid.' };
    }

    var payload = 'target=' + encodeURIComponent(normalizedTarget) +
                  '&message=' + encodeURIComponent(message) +
                  '&countryCode=62';

    var options = {
      method: 'post',
      headers: {
        'Authorization': token
      },
      contentType: 'application/x-www-form-urlencoded',
      payload: payload,
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(FONNTE_API_URL, options);
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    Logger.log('Fonnte response [' + responseCode + ']: ' + responseText);

    if (responseCode === 200) {
      var parsed = {};
      try { parsed = JSON.parse(responseText); } catch (e) {}
      if (parsed.status === true || parsed.status === 'true') {
        return { success: true, message: 'Pesan WhatsApp berhasil dikirim.' };
      } else {
        var reason = parsed.reason || parsed.message || responseText;
        return { success: false, message: 'Fonnte error: ' + reason };
      }
    } else {
      return { success: false, message: 'HTTP ' + responseCode + ': ' + responseText };
    }
  } catch (e) {
    Logger.log('sendFonnteMessage error: ' + e.toString());
    return { success: false, message: 'Gagal mengirim pesan: ' + e.message };
  }
}

/**
 * Sends a WhatsApp notification when a document is approved.
 * Called from adminApproveDokumen(). Fails silently.
 * @param {string} targetNip - NIP of the employee.
 * @param {string} namaDokumen - Name of the approved document.
 * @param {string} namaLengkap - Full name of the employee.
 */
function notifyDokumenApproved(targetNip, namaDokumen, namaLengkap) {
  try {
    var pegawai = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!pegawai) {
      Logger.log('notifyDokumenApproved: Pegawai tidak ditemukan: ' + targetNip);
      return 'Pegawai tidak ditemukan';
    }

    var noHp = String(pegawai.data[COL_PEGAWAI.NO_HP] || '').replace(/^'+/, '').trim();
    var nama = namaLengkap || String(pegawai.data[COL_PEGAWAI.NAMA_LENGKAP] || '').trim();

    if (!noHp) {
      Logger.log('notifyDokumenApproved: Nomor HP kosong untuk NIP ' + targetNip + '. Notifikasi dilewati.');
      return 'No HP kosong';
    }

    var message =
      'Halo *' + nama + '*,\n\n' +
      'Dokumen *' + namaDokumen + '* Anda telah ✅ *diverifikasi* oleh Administrator SIKAP.\n\n' +
      'Silakan login ke SIKAP untuk melihat status dokumen Anda.\n\n' +
      '— SIKAP UPTD Pendapatan Daerah Wilayah Kota Kupang\n' +
      SIKAP_APP_URL;

    var result = sendFonnteMessage(noHp, message);
    Logger.log('notifyDokumenApproved → ' + JSON.stringify(result));
    return result.success ? 'WhatsApp terkirim' : 'WhatsApp gagal: ' + result.message;
  } catch (e) {
    // Silent fail — do not disrupt the approval flow
    Logger.log('notifyDokumenApproved silent error: ' + e.toString());
    return 'WhatsApp error: ' + e.message;
  }
}

/**
 * Sends a WhatsApp notification when a document is rejected.
 * Called from adminRejectDokumen(). Fails silently.
 * @param {string} targetNip - NIP of the employee.
 * @param {string} namaDokumen - Name of the rejected document.
 * @param {string} namaLengkap - Full name of the employee.
 * @param {string} alasan - Rejection reason.
 */
function notifyDokumenRejected(targetNip, namaDokumen, namaLengkap, alasan) {
  try {
    var pegawai = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!pegawai) {
      Logger.log('notifyDokumenRejected: Pegawai tidak ditemukan: ' + targetNip);
      return 'Pegawai tidak ditemukan';
    }

    var noHp = String(pegawai.data[COL_PEGAWAI.NO_HP] || '').replace(/^'+/, '').trim();
    var nama = namaLengkap || String(pegawai.data[COL_PEGAWAI.NAMA_LENGKAP] || '').trim();

    if (!noHp) {
      Logger.log('notifyDokumenRejected: Nomor HP kosong untuk NIP ' + targetNip + '. Notifikasi dilewati.');
      return 'No HP kosong';
    }

    var message =
      'Halo *' + nama + '*,\n\n' +
      'Dokumen *' + namaDokumen + '* Anda ❌ *ditolak* oleh Administrator SIKAP.\n' +
      'Alasan: _' + alasan + '_\n\n' +
      'Silakan login ke SIKAP dan unggah ulang dokumen Anda.\n\n' +
      '— SIKAP UPTD Pendapatan Daerah Wilayah Kota Kupang\n' +
      SIKAP_APP_URL;

    var result = sendFonnteMessage(noHp, message);
    Logger.log('notifyDokumenRejected → ' + JSON.stringify(result));
    return result.success ? 'WhatsApp terkirim' : 'WhatsApp gagal: ' + result.message;
  } catch (e) {
    // Silent fail — do not disrupt the rejection flow
    Logger.log('notifyDokumenRejected silent error: ' + e.toString());
    return 'WhatsApp error: ' + e.message;
  }
}

// ============================================================
// ADMIN API FUNCTIONS (called from API.gs)
// ============================================================

/**
 * Saves the Fonnte token to Script Properties.
 * @param {string} token - Admin session token.
 * @param {string} fonnteToken - The Fonnte API token to save.
 * @returns {Object} Result object.
 */
function adminSaveFonnteToken(token, fonnteToken) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var cleanToken = String(fonnteToken || '').trim();
    if (!cleanToken) {
      return { success: false, message: 'Token Fonnte tidak boleh kosong.' };
    }

    PropertiesService.getScriptProperties().setProperty(FONNTE_TOKEN_KEY, cleanToken);
    logActivity(auth.session.nip, auth.session.role, 'CONFIG_UPDATE', 'SYSTEM',
      'FONNTE_TOKEN', 'Konfigurasi token Fonnte WhatsApp diperbarui', 'SUCCESS');

    return { success: true, message: 'Token Fonnte berhasil disimpan.' };
  } catch (e) {
    Logger.log('adminSaveFonnteToken error: ' + e.toString());
    return { success: false, message: 'Gagal menyimpan token: ' + e.message };
  }
}

/**
 * Checks whether a Fonnte token is currently configured (without exposing its value).
 * @param {string} token - Admin session token.
 * @returns {Object} Result object with isConfigured boolean.
 */
function adminGetFonnteStatus(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var existing = _getFonnteToken();
    return {
      success: true,
      data: {
        isConfigured: !!existing,
        // Show only last 4 chars for confirmation
        tokenHint: existing ? '••••••••••••••••' + existing.slice(-4) : null
      }
    };
  } catch (e) {
    Logger.log('adminGetFonnteStatus error: ' + e.toString());
    return { success: false, message: 'Gagal memeriksa status: ' + e.message };
  }
}

/**
 * Sends a WhatsApp test message to the admin's own phone number.
 * @param {string} token - Admin session token.
 * @returns {Object} Result object.
 */
function adminTestFonnteMessage(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var admin = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, auth.session.nip);
    if (!admin) return { success: false, message: 'Data Admin tidak ditemukan.' };

    var noHp = String(admin.data[COL_PEGAWAI.NO_HP] || '').replace(/^'+/, '').trim();
    if (!noHp) {
      return { success: false, message: 'Nomor HP Admin belum terdaftar di Data Pegawai. Isi terlebih dahulu sebelum melakukan uji.' };
    }

    var nama = String(admin.data[COL_PEGAWAI.NAMA_LENGKAP] || auth.session.nip).trim();

    var message =
      '✅ *Ini adalah pesan uji dari SIKAP.*\n\n' +
      'Halo *' + nama + '*,\n' +
      'Konfigurasi notifikasi WhatsApp SIKAP berhasil! Pesan ini dikirim pada ' +
      _formatDateTime(new Date()) + ' WITA.\n\n' +
      '— SIKAP UPTD Pendapatan Daerah Wilayah Kota Kupang\n' +
      SIKAP_APP_URL;

    return sendFonnteMessage(noHp, message);
  } catch (e) {
    Logger.log('adminTestFonnteMessage error: ' + e.toString());
    return { success: false, message: 'Gagal mengirim pesan uji: ' + e.message };
  }
}
function _forceAuth() { UrlFetchApp.fetch("https://google.com"); }
