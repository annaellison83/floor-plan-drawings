const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json"
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ enabled: false, error: "Method not allowed" })
    };
  }

  const key = String(process.env.GOOGLE_MAPS_BROWSER_KEY || "").trim();

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      enabled: Boolean(key),
      key
    })
  };
};
