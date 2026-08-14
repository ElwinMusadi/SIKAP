// ============================================================
// Main.gs — Google Apps Script REST API Router
// SIKAP - Sistem Informasi Kepegawaian dan Arsip Pegawai
// ============================================================

/**
 * Wrapper to return JSON response correctly
 */
function createJsonResponse(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Handle GET Requests
 * Used for fetching data (read-only operations)
 */
function doGet(e) {
  var action = e.parameter.action;
  
  if (!action) {
    return createJsonResponse({ success: false, message: 'Action is missing in GET request.' });
  }

  try {
    var result;
    
    switch (action) {
      // --- Auth / Session ---
      case 'checkSession':
        result = checkSession(e.parameter.token);
        break;
      case 'getUserProfile':
        result = getUserProfile(e.parameter.token);
        break;
        
      // --- Admin ---
      case 'getDashboardAdmin':
        result = getDashboardAdmin(e.parameter.token);
        break;
      case 'getMasterDataPegawai':
        result = getMasterDataPegawai(e.parameter.token);
        break;
      case 'getPegawaiById':
        result = getPegawaiById(e.parameter.token, e.parameter.targetNip);
        break;
      case 'getDaftarAntreanVerifikasi':
        result = getDaftarAntreanVerifikasi(e.parameter.token);
        break;
        
      // --- Pegawai ---
      case 'getMyProfile':
        result = getMyProfile(e.parameter.token);
        break;
      case 'getMyDashboard':
        result = getMyDashboard(e.parameter.token);
        break;
        
      // --- Dokumen ---
      case 'getArsipDokumenPegawai':
        result = getArsipDokumenPegawai(e.parameter.token, e.parameter.targetNip);
        break;
      case 'getDokumenPreview':
        result = getDokumenPreview(e.parameter.token, e.parameter.idArsip);
        break;
        
      default:
        return createJsonResponse({ success: false, message: 'Unknown GET action: ' + action });
    }
    
    return createJsonResponse(result);
    
  } catch (err) {
    Logger.log('doGet Error [' + action + ']: ' + err.toString());
    return createJsonResponse({ success: false, message: 'Server error: ' + err.toString() });
  }
}

/**
 * Handle POST Requests
 * Used for creating, updating, or deleting data (mutations)
 */
function doPost(e) {
  var action = e.parameter.action;
  
  if (!action) {
    return createJsonResponse({ success: false, message: 'Action is missing in POST request.' });
  }
  
  var payload = {};
  if (e.postData && e.postData.contents) {
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return createJsonResponse({ success: false, message: 'Invalid JSON payload.' });
    }
  }

  try {
    var result;
    
    switch (action) {
      // --- Auth ---
      case 'login':
        result = login(payload.nip, payload.password);
        break;
      case 'logout':
        result = logout(payload.token);
        break;
      case 'changePassword':
        result = changePassword(payload.token, payload.newPassword, payload.currentPassword);
        break;
      case 'forceChangePassword':
        result = forceChangePassword(payload.token, payload.newPassword);
        break;
        
      // --- Admin ---
      case 'createPegawai':
        result = createPegawai(payload.token, payload.pegawaiData);
        break;
      case 'updatePegawai':
        result = updatePegawai(payload.token, payload.targetNip, payload.updates);
        break;
      case 'resetPasswordPegawai':
        result = resetPasswordPegawai(payload.token, payload.targetNip);
        break;
      case 'nonaktifkanPegawai':
        result = nonaktifkanPegawai(payload.token, payload.targetNip);
        break;
      case 'aktifkanPegawai':
        result = aktifkanPegawai(payload.token, payload.targetNip);
        break;
        
      // --- Pegawai ---
      case 'updateMyProfile':
        result = updateMyProfile(payload.token, payload.updates);
        break;
      case 'uploadFotoProfil':
        result = uploadFotoProfil(payload.token, payload.base64Data, payload.mimeType);
        break;
        
      // --- Dokumen ---
      case 'uploadDokumen':
        result = uploadDokumen(payload.token, payload.idDokumen, payload.base64Data, payload.mimeType);
        break;
      case 'hapusDokumen':
        result = hapusDokumen(payload.token, payload.idArsip);
        break;
      case 'verifikasiDokumen':
        result = verifikasiDokumen(payload.token, payload.idArsip, payload.status, payload.catatan);
        break;
        
      default:
        return createJsonResponse({ success: false, message: 'Unknown POST action: ' + action });
    }
    
    return createJsonResponse(result);
    
  } catch (err) {
    Logger.log('doPost Error [' + action + ']: ' + err.toString());
    return createJsonResponse({ success: false, message: 'Server error: ' + err.toString() });
  }
}
