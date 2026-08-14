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
      case 'adminGetDashboardStats':
        result = adminGetDashboardStats(e.parameter.token);
        break;
      case 'adminGetAllPegawai':
        result = adminGetAllPegawai(e.parameter.token);
        break;
      case 'adminGetPegawaiDetail':
        result = adminGetPegawaiDetail(e.parameter.token, e.parameter.targetNip);
        break;
      case 'adminGetVerificationQueue':
        result = adminGetVerificationQueue(e.parameter.token);
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
      case 'adminTambahPegawai':
        result = adminTambahPegawai(payload.token, payload.data);
        break;
      case 'adminUpdatePegawai':
        result = adminUpdatePegawai(payload.token, payload.targetNip, payload.updates);
        break;
      case 'adminUploadFotoPegawai':
        result = adminUploadFotoPegawai(payload.token, payload.targetNip, payload.base64Data, payload.mimeType);
        break;
      case 'adminSetStatusAkun':
        result = adminSetStatusAkun(payload.token, payload.targetNip, payload.newStatus);
        break;
      case 'adminResetPassword':
        result = adminResetPassword(payload.token, payload.targetNip);
        break;
      case 'adminApproveDokumen':
        result = adminApproveDokumen(payload.token, payload.idArsip);
        break;
      case 'adminRejectDokumen':
        result = adminRejectDokumen(payload.token, payload.idArsip, payload.alasanPenolakan);
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
        
      default:
        return createJsonResponse({ success: false, message: 'Unknown POST action: ' + action });
    }
    
    return createJsonResponse(result);
    
  } catch (err) {
    Logger.log('doPost Error [' + action + ']: ' + err.toString());
    return createJsonResponse({ success: false, message: 'Server error: ' + err.toString() });
  }
}
