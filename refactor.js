const fs = require('fs');
const path = require('path');

const jsDir = path.join(__dirname, 'frontend', 'js');
const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js') && f !== 'JS_Api.js');

const methodMap = {
  login: 'POST', logout: 'POST', changePassword: 'POST', forceChangePassword: 'POST',
  checkSession: 'GET', getUserProfile: 'GET', getDashboardAdmin: 'GET', getMasterDataPegawai: 'GET',
  getPegawaiById: 'GET', getDaftarAntreanVerifikasi: 'GET', getMyProfile: 'GET', getMyDashboard: 'GET',
  getArsipDokumenPegawai: 'GET', getDokumenPreview: 'GET',
  createPegawai: 'POST', updatePegawai: 'POST', resetPasswordPegawai: 'POST', nonaktifkanPegawai: 'POST',
  aktifkanPegawai: 'POST', updateMyProfile: 'POST', uploadFotoProfil: 'POST', uploadDokumen: 'POST',
  hapusDokumen: 'POST', verifikasiDokumen: 'POST',
  adminGetDashboardStats: 'GET'
};

const payloadMap = {
  login: ['nip', 'password'],
  logout: ['token'],
  changePassword: ['token', 'newPassword', 'currentPassword'],
  forceChangePassword: ['token', 'newPassword'],
  checkSession: ['token'],
  getUserProfile: ['token'],
  getDashboardAdmin: ['token'],
  getMasterDataPegawai: ['token'],
  getPegawaiById: ['token', 'targetNip'],
  getDaftarAntreanVerifikasi: ['token'],
  getMyProfile: ['token'],
  getMyDashboard: ['token'],
  getArsipDokumenPegawai: ['token', 'targetNip'],
  getDokumenPreview: ['token', 'idArsip'],
  createPegawai: ['token', 'pegawaiData'],
  updatePegawai: ['token', 'targetNip', 'updates'],
  resetPasswordPegawai: ['token', 'targetNip'],
  nonaktifkanPegawai: ['token', 'targetNip'],
  aktifkanPegawai: ['token', 'targetNip'],
  updateMyProfile: ['token', 'updates'],
  uploadFotoProfil: ['token', 'base64Data', 'mimeType'],
  uploadDokumen: ['token', 'idDokumen', 'base64Data', 'mimeType'],
  hapusDokumen: ['token', 'idArsip'],
  verifikasiDokumen: ['token', 'idArsip', 'status', 'catatan'],
  adminGetDashboardStats: ['token']
};

for (const file of files) {
  const filePath = path.join(jsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  // Replace success handler
  content = content.replace(/google\.script\.run\s*\n\s*\.withSuccessHandler/g, "SIKAP.Api.MAGIC_SUCCESS");
  content = content.replace(/google\.script\.run\s*\.withSuccessHandler/g, "SIKAP.Api.MAGIC_SUCCESS");
  
  // Replace failure handler
  content = content.replace(/\.withFailureHandler/g, ".MAGIC_FAILURE");

  // Regex to match MAGIC_SUCCESS...MAGIC_FAILURE...method
  const apiNames = Object.keys(methodMap).join('|');
  const fullBlockRegex = new RegExp(`SIKAP\\.Api\\.MAGIC_SUCCESS\\(([^]*?)\\)\\s*\\.MAGIC_FAILURE\\(([^]*?)\\)\\s*\\.(${apiNames})\\(([\\s\\S]*?)\\);`, 'g');
  
  content = content.replace(fullBlockRegex, (match, successHandler, failureHandler, methodName, argsString) => {
    const methodType = methodMap[methodName] === 'POST' ? 'post' : 'get';
    const args = argsString.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const paramNames = payloadMap[methodName] || [];
    
    let payloadStr = "{ ";
    for (let i = 0; i < paramNames.length; i++) {
      if (i < args.length) {
        payloadStr += `${paramNames[i]}: ${args[i]}, `;
      }
    }
    payloadStr += "}";
    
    return `SIKAP.Api.${methodType}('${methodName}', ${payloadStr})\n    .then(${successHandler})\n    .catch(${failureHandler});`;
  });

  // Regex to match MAGIC_SUCCESS without failure handler
  const successOnlyRegex = new RegExp(`SIKAP\\.Api\\.MAGIC_SUCCESS\\(([^]*?)\\)\\s*\\.(${apiNames})\\(([\\s\\S]*?)\\);`, 'g');
  content = content.replace(successOnlyRegex, (match, successHandler, methodName, argsString) => {
    const methodType = methodMap[methodName] === 'POST' ? 'post' : 'get';
    const args = argsString.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const paramNames = payloadMap[methodName] || [];
    
    let payloadStr = "{ ";
    for (let i = 0; i < paramNames.length; i++) {
      if (i < args.length) {
        payloadStr += `${paramNames[i]}: ${args[i]}, `;
      }
    }
    payloadStr += "}";
    
    return `SIKAP.Api.${methodType}('${methodName}', ${payloadStr})\n    .then(${successHandler});`;
  });

  // Handle plain google.script.run
  const simpleRegex = new RegExp(`google\\.script\\.run\\.(${apiNames})\\(([\\s\\S]*?)\\);`, 'g');
  content = content.replace(simpleRegex, (match, methodName, argsString) => {
    const methodType = methodMap[methodName] === 'POST' ? 'post' : 'get';
    const args = argsString.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const paramNames = payloadMap[methodName] || [];
    
    let payloadStr = "{ ";
    for (let i = 0; i < paramNames.length; i++) {
      if (i < args.length) {
        payloadStr += `${paramNames[i]}: ${args[i]}, `;
      }
    }
    payloadStr += "}";
    
    return `SIKAP.Api.${methodType}('${methodName}', ${payloadStr}).catch(function(){});`;
  });

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Processed ${file}`);
}
