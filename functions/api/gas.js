export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ success: false, message: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Get GAS URL from environment variables
  const gasUrl = env.GAS_WEB_APP_URL;
  if (!gasUrl) {
    return new Response(JSON.stringify({ success: false, message: "GAS Web App URL is not configured." }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    
    if (!action) {
      return new Response(JSON.stringify({ success: false, message: "Parameter 'action' tidak ditemukan." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const payloadText = await request.text();
    
    // Validate JSON parsing structure
    try {
      if (payloadText) {
        JSON.parse(payloadText);
      }
    } catch (e) {
      return new Response(JSON.stringify({ success: false, message: "Payload JSON tidak valid." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Forward the request to GAS
    // We send Content-Type: text/plain because GAS expects text/plain for raw payload bodies (preventing CORS preflight issues natively)
    const gasResponse = await fetch(`${gasUrl}?action=${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: payloadText,
      redirect: "follow" // GAS uses 302 redirects for POST requests
    });

    if (!gasResponse.ok) {
      throw new Error(`GAS returned status ${gasResponse.status}`);
    }

    const responseData = await gasResponse.text();

    return new Response(responseData, {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });

  } catch (error) {
    // Avoid logging sensitive data, just log the general error
    console.error("API Gateway Error:", error.message);
    
    return new Response(JSON.stringify({
      success: false,
      message: "Terjadi kesalahan pada server gateway."
    }), {
      status: 502, // Bad Gateway
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
}
