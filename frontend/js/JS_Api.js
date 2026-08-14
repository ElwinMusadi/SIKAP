// ============================================================
// JS_Api.js — Fetch Wrapper and google.script.run Polyfill
// ============================================================

window.SIKAP = window.SIKAP || {};

SIKAP.Api = (function() {
  const API_URL = import.meta.env.VITE_GAS_API_URL;

  if (!API_URL) {
    console.error('VITE_GAS_API_URL is missing in .env!');
  }

  const methodMap = {
    login: 'POST', logout: 'POST', changePassword: 'POST', forceChangePassword: 'POST',
    checkSession: 'GET', getUserProfile: 'GET', adminGetDashboardStats: 'GET', adminGetAllPegawai: 'GET',
    adminGetPegawaiDetail: 'GET', adminGetVerificationQueue: 'GET', getMyProfile: 'GET', getMyDashboard: 'GET',
    getArsipDokumenPegawai: 'GET', getDokumenPreview: 'GET', adminTambahPegawai: 'POST', adminUpdatePegawai: 'POST',
    adminResetPassword: 'POST', adminSetStatusAkun: 'POST', updateMyProfile: 'POST', adminUploadFotoPegawai: 'POST',
    uploadFotoProfil: 'POST', uploadDokumen: 'POST', hapusDokumen: 'POST', adminApproveDokumen: 'POST', adminRejectDokumen: 'POST'
  };

  const payloadMap = {
    login: ['nip', 'password'],
    logout: ['token'],
    changePassword: ['token', 'newPassword', 'currentPassword'],
    forceChangePassword: ['token', 'newPassword'],
    checkSession: ['token'],
    getUserProfile: ['token'],
    adminGetDashboardStats: ['token'],
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
    adminRejectDokumen: ['token', 'idArsip', 'alasanPenolakan']
  };

  async function get(action, params = {}) {
    try {
      const url = new URL(API_URL);
      url.searchParams.append('action', action);
      
      if (!params.token && SIKAP.state && SIKAP.state.token) {
        params.token = SIKAP.state.token;
      }
      
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, value);
        }
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
      });

      if (!response.ok) throw new Error('Network response was not ok');
      return await response.json();
    } catch (error) {
      console.error(`[API GET ${action}] Error:`, error);
      throw error;
    }
  }

  async function post(action, payload = {}) {
    try {
      const url = new URL(API_URL);
      url.searchParams.append('action', action);
      
      if (!payload.token && SIKAP.state && SIKAP.state.token) {
        payload.token = SIKAP.state.token;
      }

      const response = await fetch(url.toString(), {
        method: 'POST',
        redirect: 'follow',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error('Network response was not ok');
      return await response.json();
    } catch (error) {
      console.error(`[API POST ${action}] Error:`, error);
      throw error;
    }
  }

  // --- POLYFILL FOR google.script.run ---
  function createRunner(successCb, failureCb) {
    return new Proxy({}, {
      get: function(target, prop) {
        if (prop === 'withSuccessHandler') {
          return function(cb) { return createRunner(cb, failureCb); };
        }
        if (prop === 'withFailureHandler') {
          return function(cb) { return createRunner(successCb, cb); };
        }
        
        // This is the actual backend method call
        return function(...args) {
          const methodName = prop;
          if (!methodMap[methodName]) {
            console.error(`Method ${methodName} is not mapped in JS_Api.js`);
            if (failureCb) failureCb(new Error(`Method not found: ${methodName}`));
            return;
          }

          const methodType = methodMap[methodName] === 'POST' ? 'post' : 'get';
          const paramNames = payloadMap[methodName] || [];
          
          let payload = {};
          for(let i = 0; i < paramNames.length; i++) {
            payload[paramNames[i]] = args[i];
          }
          
          // Execute the fetch
          SIKAP.Api[methodType](methodName, payload)
            .then(res => {
              if (successCb) successCb(res);
            })
            .catch(err => {
              if (failureCb) failureCb(err);
            });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createRunner(null, null);

  return { get, post };
})();
