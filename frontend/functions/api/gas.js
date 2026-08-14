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
    const gasResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      redirect: 'follow', // CF Worker akan mengikuti 302 redirect dengan mulus
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: bodyText
    });

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
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
