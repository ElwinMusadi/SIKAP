// ============================================================
// WhatsApp.gs — WhatsApp Gateway Integration
// Supports two providers: Fonnte (unofficial) and Meta Cloud API (official).
// Active provider is stored in Script Properties under WA_PROVIDER.
// ============================================================

// ---- Fonnte ----
var FONNTE_API_URL = 'https://api.fonnte.com/send';
var FONNTE_TOKEN_KEY = 'FONNTE_TOKEN';

// ---- Meta Cloud API ----
var META_API_BASE = 'https://graph.facebook.com/v21.0';
var META_TOKEN_KEY = 'META_WA_TOKEN';
var META_PHONE_ID_KEY = 'META_WA_PHONE_ID';

// ---- Provider selector ----
var WA_PROVIDER_KEY = 'WA_PROVIDER'; // 'fonnte' or 'meta'

// ---- Shared ----
var SIKAP_APP_URL = 'https://sikap.uptdpenda-kupang.web.id';

function _getFonnteToken() {
  try { return PropertiesService.getScriptProperties().getProperty(FONNTE_TOKEN_KEY); }
  catch (e) { Logger.log('_getFonnteToken error: ' + e); return null; }
}

function _getMetaToken() {
  try { return PropertiesService.getScriptProperties().getProperty(META_TOKEN_KEY); }
  catch (e) { Logger.log('_getMetaToken error: ' + e); return null; }
}

function _getMetaPhoneId() {
  try { return PropertiesService.getScriptProperties().getProperty(META_PHONE_ID_KEY); }
  catch (e) { Logger.log('_getMetaPhoneId error: ' + e); return null; }
}

function _getWaProvider() {
  try { return PropertiesService.getScriptProperties().getProperty(WA_PROVIDER_KEY) || 'fonnte'; }
  catch (e) { return 'fonnte'; }
}

// ============================================================
// FONNTE SENDER
// ============================================================

function sendFonnteMessage(target, message) {
  try {
    var token = _getFonnteToken();
    if (!token) return { success: false, message: 'Token Fonnte belum dikonfigurasi.' };

    var normalizedTarget = String(target || '').split(',').map(function(t) {
      var n = t.replace(/\D/g, '');
      return n.startsWith('0') ? '62' + n.substring(1) : n;
    }).filter(Boolean).join(',');

    if (!normalizedTarget) return { success: false, message: 'Nomor HP tidak valid.' };

    var payload = 'target=' + encodeURIComponent(normalizedTarget) +
                  '&message=' + encodeURIComponent(message) +
                  '&countryCode=62';

    var options = {
      method: 'post',
      headers: { 'Authorization': token },
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
      }
      return { success: false, message: 'Fonnte error: ' + (parsed.reason || parsed.message || responseText) };
    }
    return { success: false, message: 'HTTP ' + responseCode + ': ' + responseText };
  } catch (e) {
    Logger.log('sendFonnteMessage error: ' + e.toString());
    return { success: false, message: 'Gagal mengirim pesan: ' + e.message };
  }
}

// ============================================================
// META CLOUD API SENDER
// ============================================================

function _normalizePhoneE164(phone) {
  var n = String(phone || '').replace(/\D/g, '');
  return n.startsWith('0') ? '62' + n.substring(1) : n;
}

function sendMetaMessage(target, message, templateData) {
  try {
    var token = _getMetaToken();
    var phoneId = _getMetaPhoneId();

    if (!token) return { success: false, message: 'Token Meta WhatsApp belum dikonfigurasi.' };
    if (!phoneId) return { success: false, message: 'Phone Number ID Meta belum dikonfigurasi.' };

    var normalizedTarget = _normalizePhoneE164(target);
    if (!normalizedTarget || normalizedTarget.length < 10) {
      return { success: false, message: 'Nomor HP tidak valid: ' + target };
    }

    var url = META_API_BASE + '/' + phoneId + '/messages';
    var bodyObj = {
      messaging_product: 'whatsapp',
      to: normalizedTarget
    };

    if (templateData) {
      bodyObj.type = 'template';
      bodyObj.template = {
        name: templateData.name,
        language: { code: templateData.language || 'id' },
        components: templateData.components || []
      };
    } else {
      bodyObj.type = 'text';
      bodyObj.text = { body: message };
    }

    var body = JSON.stringify(bodyObj);

    var options = {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      payload: body,
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();
    Logger.log('Meta API response [' + responseCode + ']: ' + responseText);

    var parsed = {};
    try { parsed = JSON.parse(responseText); } catch (e) {}

    if (responseCode === 200 && parsed.messages && parsed.messages.length > 0) {
      return { success: true, message: 'Pesan terkirim via Meta ke ' + normalizedTarget };
    }
    var errMsg = (parsed.error && parsed.error.message) ? parsed.error.message : responseText;
    return { success: false, message: 'Meta error: ' + errMsg };
  } catch (e) {
    Logger.log('sendMetaMessage error: ' + e.toString());
    return { success: false, message: 'Gagal kirim via Meta: ' + e.message };
  }
}

// ============================================================
// UNIVERSAL ROUTER
// ============================================================

function sendWhatsApp(target, message, templateData) {
  var provider = _getWaProvider();

  if (provider === 'meta') {
    var numbers = String(target || '').split(',').map(function(n) { return n.trim(); }).filter(Boolean);
    if (numbers.length === 0) return { success: false, message: 'Nomor HP tidak valid.' };

    var successCount = 0;
    var errors = [];
    numbers.forEach(function(num) {
      var result = sendMetaMessage(num, message, templateData);
      if (result.success) { successCount++; }
      else { errors.push(num + ': ' + result.message); }
    });

    if (successCount === numbers.length) return { success: true, message: 'Pesan terkirim via Meta ke ' + successCount + ' nomor.' };
    if (successCount > 0) return { success: true, message: 'Pesan terkirim ke ' + successCount + '/' + numbers.length + ' nomor. Gagal: ' + errors.join('; ') };
    return { success: false, message: 'Semua pengiriman gagal: ' + errors.join('; ') };
  }

  return sendFonnteMessage(target, message);
}

// ============================================================
// NOTIFICATION FUNCTIONS
// ============================================================

function notifyDokumenApproved(targetNip, namaDokumen, namaLengkap) {
  try {
    var pegawai = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!pegawai) return 'Pegawai tidak ditemukan';

    var noHp = String(pegawai.data[COL_PEGAWAI.NO_HP] || '').replace(/^'+/, '').trim();
    var nama = namaLengkap || String(pegawai.data[COL_PEGAWAI.NAMA_LENGKAP] || '').trim();
    if (!noHp) return 'No HP kosong';

    var message =
      'Halo *' + nama + '*,\n\n' +
      'Dokumen *' + namaDokumen + '* Anda telah \u2705 *diverifikasi* oleh Administrator TU.\n\n' +
      'Silakan login ke SIKAP untuk melihat status dokumen Anda.\n\n' +
      SIKAP_APP_URL;

    var templateData = {
      name: 'dokumen_terverifikasi',
      language: 'id',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: nama },
            { type: 'text', text: namaDokumen }
          ]
        }
      ]
    };

    var result = sendWhatsApp(noHp, message, templateData);
    Logger.log('notifyDokumenApproved: ' + JSON.stringify(result));
    return result.success ? 'WhatsApp terkirim' : 'WhatsApp gagal: ' + result.message;
  } catch (e) {
    Logger.log('notifyDokumenApproved silent error: ' + e.toString());
    return 'WhatsApp error: ' + e.message;
  }
}

function notifyDokumenRejected(targetNip, namaDokumen, namaLengkap, alasan) {
  try {
    var pegawai = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!pegawai) return 'Pegawai tidak ditemukan';

    var noHp = String(pegawai.data[COL_PEGAWAI.NO_HP] || '').replace(/^'+/, '').trim();
    var nama = namaLengkap || String(pegawai.data[COL_PEGAWAI.NAMA_LENGKAP] || '').trim();
    if (!noHp) return 'No HP kosong';

    var message =
      'Halo *' + nama + '*,\n\n' +
      'Dokumen *' + namaDokumen + '* Anda \u274c *ditolak* oleh Administrator TU.\n' +
      'Alasan: _' + alasan + '_\n\n' +
      'Silakan login ke SIKAP dan unggah ulang dokumen Anda.\n\n' +
      SIKAP_APP_URL;

    var result = sendWhatsApp(noHp, message);
    Logger.log('notifyDokumenRejected: ' + JSON.stringify(result));
    return result.success ? 'WhatsApp terkirim' : 'WhatsApp gagal: ' + result.message;
  } catch (e) {
    Logger.log('notifyDokumenRejected silent error: ' + e.toString());
    return 'WhatsApp error: ' + e.message;
  }
}

function notifyAdminsNewDocument(namaPegawai, namaDokumen) {
  try {
    var pegawaiSheet = getSheet(SHEET_NAMES.DATA_PEGAWAI);
    if (!pegawaiSheet) return 'Sheet Data_Pegawai tidak ditemukan';

    var data = pegawaiSheet.getDataRange().getValues();
    var adminNumbers = [];

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var role = String(row[COL_PEGAWAI.ROLE]).trim();
      var noHp = String(row[COL_PEGAWAI.NO_HP]).trim();
      var statusAkun = String(row[COL_PEGAWAI.STATUS_AKUN]).trim();
      if (role.indexOf('Admin') !== -1 && statusAkun === 'Aktif' && noHp) {
        adminNumbers.push(noHp.replace(/^'+/, ''));
      }
    }

    if (adminNumbers.length === 0) return 'Tidak ada Admin aktif dengan nomor HP';

    var message =
      'Halo Administrator TU,\n\n' +
      'Pegawai *' + namaPegawai + '* baru saja mengunggah/memperbarui dokumen *' + namaDokumen + '*.\n\n' +
      'Mohon segera login ke SIKAP untuk melakukan verifikasi dokumen tersebut.\n\n' +
      SIKAP_APP_URL;

    var result = sendWhatsApp(adminNumbers.join(','), message);
    Logger.log('notifyAdminsNewDocument: ' + JSON.stringify(result));
    return result.success ? 'WhatsApp terkirim ke ' + adminNumbers.length + ' Admin' : 'WhatsApp gagal: ' + result.message;
  } catch (e) {
    Logger.log('notifyAdminsNewDocument silent error: ' + e.toString());
    return 'WhatsApp error: ' + e.message;
  }
}

// ============================================================
// ADMIN API FUNCTIONS
// ============================================================

function adminSaveFonnteToken(token, fonnteToken) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };
    var cleanToken = String(fonnteToken || '').trim();
    if (!cleanToken) return { success: false, message: 'Token Fonnte tidak boleh kosong.' };
    PropertiesService.getScriptProperties().setProperty(FONNTE_TOKEN_KEY, cleanToken);
    logActivity(auth.session.nip, auth.session.role, 'CONFIG_UPDATE', 'SYSTEM', 'FONNTE_TOKEN', 'Konfigurasi token Fonnte diperbarui', 'SUCCESS');
    return { success: true, message: 'Token Fonnte berhasil disimpan.' };
  } catch (e) {
    return { success: false, message: 'Gagal menyimpan token: ' + e.message };
  }
}

function adminGetFonnteStatus(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };
    var existing = _getFonnteToken();
    return { success: true, data: { isConfigured: !!existing, tokenHint: existing ? '\u2022\u2022\u2022\u2022' + existing.slice(-4) : null } };
  } catch (e) {
    return { success: false, message: 'Gagal memeriksa status: ' + e.message };
  }
}

function adminTestFonnteMessage(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };
    var admin = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, auth.session.nip);
    if (!admin) return { success: false, message: 'Data Admin tidak ditemukan.' };
    var noHp = String(admin.data[COL_PEGAWAI.NO_HP] || '').replace(/^'+/, '').trim();
    if (!noHp) return { success: false, message: 'Nomor HP Admin belum terdaftar di Data Pegawai.' };
    var nama = String(admin.data[COL_PEGAWAI.NAMA_LENGKAP] || auth.session.nip).trim();
    var provider = _getWaProvider().toUpperCase();
    var message =
      '\u2705 *Ini adalah pesan uji dari SIKAP.*\n\n' +
      'Halo *' + nama + '*,\n' +
      'Konfigurasi notifikasi WhatsApp SIKAP berhasil! Pesan ini dikirim pada ' +
      _formatDateTime(new Date()) + ' WITA via *' + provider + '*.\n\n' +
      SIKAP_APP_URL;
    return sendWhatsApp(noHp, message);
  } catch (e) {
    return { success: false, message: 'Gagal mengirim pesan uji: ' + e.message };
  }
}

function adminSaveMetaConfig(token, metaToken, metaPhoneId) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };
    var cleanToken = String(metaToken || '').trim();
    var cleanPhoneId = String(metaPhoneId || '').trim();
    if (!cleanToken) return { success: false, message: 'Token Meta tidak boleh kosong.' };
    if (!cleanPhoneId) return { success: false, message: 'Phone Number ID tidak boleh kosong.' };
    var props = PropertiesService.getScriptProperties();
    props.setProperty(META_TOKEN_KEY, cleanToken);
    props.setProperty(META_PHONE_ID_KEY, cleanPhoneId);
    logActivity(auth.session.nip, auth.session.role, 'CONFIG_UPDATE', 'SYSTEM', 'META_WA_CONFIG', 'Konfigurasi Meta WhatsApp Cloud API diperbarui', 'SUCCESS');
    return { success: true, message: 'Konfigurasi Meta WhatsApp berhasil disimpan.' };
  } catch (e) {
    return { success: false, message: 'Gagal menyimpan konfigurasi Meta: ' + e.message };
  }
}

function adminGetWaProvider(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };
    var fonnteToken = _getFonnteToken();
    var metaToken = _getMetaToken();
    var metaPhoneId = _getMetaPhoneId();
    var provider = _getWaProvider();
    return {
      success: true,
      data: {
        activeProvider: provider,
        fonnte: { isConfigured: !!fonnteToken, tokenHint: fonnteToken ? '\u2022\u2022\u2022\u2022' + fonnteToken.slice(-4) : null },
        meta: { isConfigured: !!(metaToken && metaPhoneId), tokenHint: metaToken ? '\u2022\u2022\u2022\u2022' + metaToken.slice(-4) : null, phoneId: metaPhoneId || null }
      }
    };
  } catch (e) {
    return { success: false, message: 'Gagal memuat status penyedia: ' + e.message };
  }
}

function adminSetWaProvider(token, provider) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };
    var cleanProvider = String(provider || '').toLowerCase().trim();
    if (cleanProvider !== 'fonnte' && cleanProvider !== 'meta') {
      return { success: false, message: 'Penyedia tidak valid.' };
    }
    PropertiesService.getScriptProperties().setProperty(WA_PROVIDER_KEY, cleanProvider);
    logActivity(auth.session.nip, auth.session.role, 'CONFIG_UPDATE', 'SYSTEM', 'WA_PROVIDER', 'Penyedia WhatsApp diubah ke: ' + cleanProvider, 'SUCCESS');
    return { success: true, message: 'Penyedia WhatsApp diubah ke ' + cleanProvider + '.' };
  } catch (e) {
    return { success: false, message: 'Gagal mengubah penyedia: ' + e.message };
  }
}

function adminTestMetaMessage(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };
    var admin = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, auth.session.nip);
    if (!admin) return { success: false, message: 'Data Admin tidak ditemukan.' };
    var noHp = String(admin.data[COL_PEGAWAI.NO_HP] || '').replace(/^'+/, '').trim();
    if (!noHp) return { success: false, message: 'Nomor HP Admin belum terdaftar di Data Pegawai.' };
    var nama = String(admin.data[COL_PEGAWAI.NAMA_LENGKAP] || auth.session.nip).trim();
    var message =
      '\u2705 *Ini adalah pesan uji dari SIKAP.*\n\n' +
      'Halo *' + nama + '*,\n' +
      'Konfigurasi Meta WhatsApp Cloud API berhasil! Pesan ini dikirim pada ' +
      _formatDateTime(new Date()) + ' WITA.\n\n' +
      SIKAP_APP_URL;
    return sendMetaMessage(noHp, message);
  } catch (e) {
    return { success: false, message: 'Gagal mengirim pesan uji Meta: ' + e.message };
  }
}

function _forceAuth() { UrlFetchApp.fetch("https://google.com"); }
