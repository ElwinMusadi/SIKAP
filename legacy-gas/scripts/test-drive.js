const http = require('http');

const API_URL = 'http://127.0.0.1:8788/api/gas';

async function callApi(action, payload) {
  const response = await fetch(`${API_URL}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

async function runTests() {
  console.log("=== SIKAP GOOGLE DRIVE API TEST SUITE ===");
  try {
    // 1. LOGIN
    console.log("\n[TEST 1] Login...");
    const loginRes = await callApi('login', { nip: '199003152015022003', password: '022003' });
    const token = loginRes.data.token;
    console.log("Token acquired.");

    // 2. GET ARSIP DOKUMEN (Metadata fetch)
    console.log("\n[TEST 2] Get Arsip Dokumen Pegawai...");
    const arsipRes = await callApi('getArsipDokumenPegawai', { token: token });
    console.log("Result:", arsipRes.success ? "SUCCESS" : "FAILED", arsipRes.data?.summaryText);
    
    // Find an unuploaded document to upload, or just pick DOC-TASPEN
    // Note: this assumes DOC-TASPEN is not uploaded yet, or we'll just test the duplicate check.
    const idDokumen = 'DOC-TASPEN';

    // 3. UPLOAD DOKUMEN (Base64 small text file masquerading as PNG for testing)
    console.log("\n[TEST 3] Upload Dokumen (Base64)...");
    const dummyBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="; // 1x1 transparent PNG
    const uploadRes = await callApi('uploadDokumen', {
      token: token,
      idDokumen: idDokumen,
      base64Data: dummyBase64,
      mimeType: 'image/png'
    });
    console.log("Result:", uploadRes.success ? "SUCCESS" : "FAILED", uploadRes.message);

    // 4. GET PREVIEW DOKUMEN
    if (uploadRes.success) {
      console.log("\n[TEST 4] Get Preview Dokumen...");
      const idArsip = uploadRes.data.idArsip;
      const previewRes = await callApi('getDokumenPreview', { token: token, idArsip: idArsip });
      console.log("Result:", previewRes.success ? "SUCCESS" : "FAILED", previewRes.data?.previewUrl ? "URL Generated" : "No URL");

      // 5. HAPUS DOKUMEN
      console.log("\n[TEST 5] Hapus Dokumen...");
      const deleteRes = await callApi('hapusDokumen', { token: token, idArsip: idArsip });
      console.log("Result:", deleteRes.success ? "SUCCESS" : "FAILED", deleteRes.message);
    } else if (uploadRes.message.includes('antrian verifikasi')) {
      console.log("\n[TEST 4-5 SKIP] Document already waiting for verification. Expected duplicate rejection works.");
    }

    console.log("\n=== ALL TESTS COMPLETED ===");
  } catch (err) {
    console.error("TEST FAILED:", err);
  }
}

// Wait for wrangler to be ready
setTimeout(runTests, 2000);
