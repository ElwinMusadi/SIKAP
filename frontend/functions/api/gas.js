export async function onRequest(context) {
  const { request, env } = context;

  // URL GAS dari Environment Variable Cloudflare
  const gasUrl = env.VITE_GAS_API_URL;

  if (!gasUrl) {
    return new Response(JSON.stringify({ success: false, message: "VITE_GAS_API_URL is not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Handle CORS preflight options directly
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  try {
    // Tangkap body dari request client (browser)
    let bodyText = null;
    if (request.method === 'POST') {
      bodyText = await request.text();
    }

    // Ambil URL parameter (action) dari request client
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    
    // Bangun URL GAS dengan meneruskan parameter
    const targetUrl = new URL(gasUrl);
    url.searchParams.forEach((value, key) => {
      targetUrl.searchParams.append(key, value);
    });

    // Meneruskan request ke Google Apps Script (Server-to-Server)
    let gasResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      redirect: 'manual', // Tangani redirect secara manual untuk menghindari bug CF Worker pada POST redirect
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: bodyText
    });

    // Jika GAS merespons dengan 302 Redirect (standar untuk doPost)
    if (gasResponse.status === 302 || gasResponse.status === 303) {
      const location = gasResponse.headers.get('location');
      if (location) {
        // Lakukan request GET ke URL hasil redirect
        gasResponse = await fetch(location, {
          method: 'GET',
          redirect: 'follow'
        });
      }
    }

    const responseText = await gasResponse.text();

    return new Response(responseText, {
      status: gasResponse.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ success: false, message: "Proxy error: " + error.message }), {
      status: 200, // Gunakan 200 agar frontend tidak throw error, tapi memunculkan pesan gagal
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }
}
