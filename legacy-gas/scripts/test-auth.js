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
  console.log("=== SIKAP AUTHENTICATION API TEST SUITE ===");
  try {
    // 1. LOGIN ADMIN
    console.log("\n[TEST 1] Admin Login...");
    const adminLogin = await callApi('login', { nip: '198506122010011002', password: '011002' });
    console.log("Result:", adminLogin.success ? "SUCCESS" : "FAILED", adminLogin.message);
    if (!adminLogin.success) throw new Error("Admin login failed");
    const adminToken = adminLogin.data.token;
    console.log("Admin Token:", adminToken);

    // 2. CHECK SESSION (ADMIN)
    console.log("\n[TEST 2] Admin Check Session...");
    const adminSession = await callApi('checkSession', { token: adminToken });
    console.log("Result:", adminSession.success ? "SUCCESS" : "FAILED", adminSession.data?.nama);

    // 3. ADMIN ENDPOINT (adminGetDashboardStats)
    console.log("\n[TEST 3] Admin accessing Admin Endpoint...");
    const adminStats = await callApi('adminGetDashboardStats', { token: adminToken });
    console.log("Result:", adminStats.success ? "SUCCESS" : "FAILED", adminStats.message || "Stats retrieved");

    // 4. LOGIN PEGAWAI
    console.log("\n[TEST 4] Pegawai Login...");
    const pegawaiLogin = await callApi('login', { nip: '199003152015022003', password: '022003' });
    console.log("Result:", pegawaiLogin.success ? "SUCCESS" : "FAILED", pegawaiLogin.message);
    const pegawaiToken = pegawaiLogin.data.token;

    // 5. PEGAWAI ACCESSING ADMIN ENDPOINT (Should Fail)
    console.log("\n[TEST 5] Pegawai accessing Admin Endpoint (Unauthorized)...");
    const unauthorizedStats = await callApi('adminGetDashboardStats', { token: pegawaiToken });
    console.log("Result:", unauthorizedStats.success ? "SUCCESS" : "FAILED (Expected)", unauthorizedStats.message);

    // 6. INVALID TOKEN ACCESS
    console.log("\n[TEST 6] Invalid Token Access...");
    const invalidAccess = await callApi('getUserProfile', { token: 'invalid-token-123' });
    console.log("Result:", invalidAccess.success ? "SUCCESS" : "FAILED (Expected)", invalidAccess.message);

    // 7. LOGOUT
    console.log("\n[TEST 7] Logout Admin...");
    const logoutRes = await callApi('logout', { token: adminToken });
    console.log("Result:", logoutRes.success ? "SUCCESS" : "FAILED", logoutRes.message);

    // 8. ACCESS AFTER LOGOUT
    console.log("\n[TEST 8] Access Profile After Logout...");
    const afterLogoutAccess = await callApi('getUserProfile', { token: adminToken });
    console.log("Result:", afterLogoutAccess.success ? "SUCCESS" : "FAILED (Expected)", afterLogoutAccess.message);

    console.log("\n=== ALL TESTS COMPLETED ===");
  } catch (err) {
    console.error("TEST FAILED:", err);
  }
}

// Wait for wrangler to be ready
setTimeout(runTests, 2000);
