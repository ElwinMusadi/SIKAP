async function testLogin() {
  const url = "https://script.google.com/macros/s/AKfycbzKG4pdxKDfCCCpQuotDvTO4DsfP935FPopQ680XOkR8wtt3tCqxZGzDveeCMGQR7_p/exec?action=login";
  
  try {
    console.log("Fetching...");
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({nip: "198506122010011002", password: "011002"})
    });
    
    console.log("Status:", response.status);
    const text = await response.text();
    console.log("Body:", text);
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

testLogin();
