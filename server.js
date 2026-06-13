import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const MAX_BODY_BYTES = 18 * 1024 * 1024;

loadDotEnv(path.join(__dirname, ".env"));

const SHEET_COLUMNS = [
  "Customer Name",
  "Mobile",
  "Date",
  "Vehicle Reg. No.",
  "Make-Model",
  "Variant",
  "Avg. km/mo",
  "Odo Reading",
  "Type of Service",
  "Tyre Position",
  "Brand",
  "Platform",
  "Size",
  "NSD",
  "Fitment Year"
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, {
        ready: getMissingConfig().length === 0,
        missing: getMissingConfig(),
        appendMode: getAppendMode(),
        sheetName: env("GOOGLE_SHEET_NAME", "Sheet1"),
        aiProvider: getAiProvider(),
        model: getAiModel(),
        columns: SHEET_COLUMNS
      });
    }

    if (req.method === "POST" && url.pathname === "/api/analyze-append") {
      const missing = getMissingConfig();
      if (missing.length) {
        return sendJson(res, 400, { error: `Missing configuration: ${missing.join(", ")}` });
      }

      const payload = await readJsonBody(req);
      validatePayload(payload);

      const analysis = await analyzeScreenshot(payload);
      const rows = buildSheetRows(payload, analysis);
      const appendResult = await appendToGoogleSheet(rows);

      if (appendResult?.ok === false) {
        throw new Error(`Sheet append failed: ${appendResult.error || "Apps Script returned ok:false"}`);
      }

      return sendJson(res, 200, { analysis, rows, appendResult });
    }

    if (req.method === "POST" && url.pathname === "/api/append-headers") {
      const missing = getMissingAppendConfig();
      if (missing.length) {
        return sendJson(res, 400, { error: `Missing configuration: ${missing.join(", ")}` });
      }

      const appendResult = await appendToGoogleSheet(SHEET_COLUMNS);
      if (appendResult?.ok === false) {
        throw new Error(`Header append failed: ${appendResult.error || "Apps Script returned ok:false"}`);
      }
      return sendJson(res, 200, { row: SHEET_COLUMNS, appendResult });
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, { error: error.message || "Unexpected server error" });
  }
});

const port = Number(env("PORT", "3000"));
const host = env("HOST", "127.0.0.1");
server.listen(port, host, () => {
  console.log(`Screenshot Sheet Updater is running at http://localhost:${port}`);
});

async function analyzeScreenshot({ imageDataUrl, fileName, notes }) {
  const prompt = [
    "Analyze this screenshot and extract service customer details and vehicle tyre details for a spreadsheet.",
    "Return only valid JSON with these fields:",
    "{",
    '  "service_date": "YYYY-MM-DD if visible",',
    '  "customer_name": "customer name",',
    '  "phone": "phone number",',
    '  "vehicle_reg_no": "vehicle registration number",',
    '  "make_model": "make and model",',
    '  "variant": "variant",',
    '  "avg_km_month": "average km per month as visible",',
    '  "odo_reading": "odometer reading as visible",',
    '  "type_of_service": "service description",',
    '  "tyres": [',
    '    { "position": "FL/FR/RL/RR or visible name", "brand": "", "tyre_name": "", "nsd": "", "platform": "", "size": "", "fitment_year": "" }',
    "  ],",
    '  "confidence": 0.0',
    "}",
    "If something is unreadable, say so. Do not invent details.",
    notes ? `User notes/context: ${notes}` : "",
    fileName ? `File name: ${fileName}` : ""
  ].filter(Boolean).join("\n");

  if (getAiProvider() === "groq") {
    return analyzeScreenshotWithGroq({ imageDataUrl, prompt });
  }

  return analyzeScreenshotWithXai({ imageDataUrl, prompt });
}

async function analyzeScreenshotWithXai({ imageDataUrl, prompt }) {
  const response = await postJson("https://api.x.ai/v1/responses", {
    model: env("XAI_MODEL", "grok-4.3"),
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: imageDataUrl, detail: "high" },
          { type: "input_text", text: prompt }
        ]
      }
    ],
    max_output_tokens: 1200,
    store: false
  }, {
    Authorization: `Bearer ${env("XAI_API_KEY")}`
  });

  const content = getResponseText(response);
  if (!content) {
    throw new Error("xAI returned an empty analysis.");
  }

  return normalizeAnalysis(parseJsonFromModel(content));
}

async function analyzeScreenshotWithGroq({ imageDataUrl, prompt }) {
  const response = await postJson("https://api.groq.com/openai/v1/chat/completions", {
    model: env("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ],
    temperature: 0,
    max_completion_tokens: 1200,
    response_format: { type: "json_object" }
  }, {
    Authorization: `Bearer ${getAiKey()}`
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Groq returned an empty analysis.");
  }

  return normalizeAnalysis(parseJsonFromModel(content));
}

function buildSheetRows(payload, analysis) {
  const tyres = analysis.tyres.length ? analysis.tyres : [{}];
  return tyres.map((tyre) => [
    analysis.customer_name,
    analysis.phone,
    analysis.service_date,
    analysis.vehicle_reg_no,
    analysis.make_model,
    analysis.variant,
    analysis.avg_km_month,
    analysis.odo_reading,
    analysis.type_of_service,
    tyre.position || "",
    tyre.brand || "",
    tyre.platform || "",
    tyre.size || "",
    tyre.nsd || "",
    tyre.fitment_year || ""
  ]);
}

async function appendToGoogleSheet(rows) {
  if (env("GOOGLE_APPS_SCRIPT_WEBAPP_URL")) {
    return appendWithAppsScript(rows);
  }

  const token = await getGoogleAccessToken();
  const spreadsheetId = env("GOOGLE_SHEET_ID");
  const sheetName = env("GOOGLE_SHEET_NAME", "Sheet1");
  const range = `${sheetName}!A:O`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  return postJson(url, {
    majorDimension: "ROWS",
    values: Array.isArray(rows[0]) ? rows : [rows]
  }, {
    Authorization: `Bearer ${token}`
  });
}

async function appendWithAppsScript(rows) {
  const url = new URL(env("GOOGLE_APPS_SCRIPT_WEBAPP_URL"));
  const token = env("GOOGLE_APPS_SCRIPT_TOKEN");
  if (token) {
    url.searchParams.set("token", token);
  }

  const result = await postJson(url.toString(), {
    rows: Array.isArray(rows[0]) ? rows : [rows],
    columns: SHEET_COLUMNS,
    sheetName: env("GOOGLE_SHEET_NAME", "Sheet1")
  });

  if (result?.ok === false) {
    throw new Error(`Apps Script append failed: ${result.error || "unknown error"}`);
  }
  if (!result || result.ok !== true) {
    throw new Error("Apps Script append did not return ok:true.");
  }

  return result;
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(env("GOOGLE_PRIVATE_KEY_ID") ? { kid: env("GOOGLE_PRIVATE_KEY_ID") } : {})
  };
  const claims = {
    iss: env("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const privateKey = env("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  const assertion = `${unsigned}.${base64Url(signature)}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google auth failed: ${json.error_description || json.error || response.statusText}`);
  }

  return json.access_token;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = json.error?.message || json.error_description || json.error || response.statusText;
    throw new Error(message);
  }
  return json;
}

function parseJsonFromModel(content) {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Could not parse the model response as JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function getResponseText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n");
}

function normalizeAnalysis(value) {
  const confidence = Number(value.confidence);
  const tyres = Array.isArray(value.tyres) ? value.tyres : [];
  return {
    service_date: stringValue(value.service_date),
    customer_name: stringValue(value.customer_name),
    phone: stringValue(value.phone),
    vehicle_reg_no: stringValue(value.vehicle_reg_no),
    make_model: stringValue(value.make_model),
    variant: stringValue(value.variant),
    avg_km_month: stringValue(value.avg_km_month),
    odo_reading: stringValue(value.odo_reading),
    type_of_service: stringValue(value.type_of_service),
    tyres: tyres.map((tyre) => ({
      position: stringValue(tyre.position),
      brand: stringValue(tyre.brand),
      tyre_name: stringValue(tyre.tyre_name),
      nsd: stringValue(tyre.nsd),
      platform: stringValue(tyre.platform),
      size: stringValue(tyre.size),
      fitment_year: stringValue(tyre.fitment_year)
    })),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
  };
}

function stringValue(value) {
  return value === undefined || value === null ? "" : String(value);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw httpError(400, "Expected a JSON body.");
  }
  if (typeof payload.imageDataUrl !== "string" || !payload.imageDataUrl.startsWith("data:image/")) {
    throw httpError(400, "Upload a PNG, JPG, or WebP screenshot.");
  }
  if (payload.imageDataUrl.length > MAX_BODY_BYTES) {
    throw httpError(413, "Image is too large. Try a screenshot under about 12 MB.");
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(httpError(400, "Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    return sendText(res, 403, "Forbidden");
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendText(res, 404, "Not found");
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(content);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[ext] || "application/octet-stream";
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getMissingConfig() {
  const missing = [];
  if (!getAiKey()) {
    missing.push("GROQ_API_KEY or XAI_API_KEY");
  }
  missing.push(...getMissingAppendConfig());
  return missing;
}

function getMissingAppendConfig() {
  if (env("GOOGLE_APPS_SCRIPT_WEBAPP_URL")) {
    return [];
  }

  if (env("GOOGLE_SERVICE_ACCOUNT_EMAIL") && env("GOOGLE_PRIVATE_KEY") && env("GOOGLE_SHEET_ID")) {
    return [];
  }

  return [
    "GOOGLE_APPS_SCRIPT_WEBAPP_URL"
  ];
}

function getAppendMode() {
  if (env("GOOGLE_APPS_SCRIPT_WEBAPP_URL")) {
    return "apps-script-webhook";
  }
  if (env("GOOGLE_SERVICE_ACCOUNT_EMAIL") && env("GOOGLE_PRIVATE_KEY") && env("GOOGLE_SHEET_ID")) {
    return "service-account";
  }
  return "not-configured";
}

function getAiProvider() {
  if (env("AI_PROVIDER")) {
    return env("AI_PROVIDER").toLowerCase();
  }
  if (env("GROQ_API_KEY") || env("XAI_API_KEY").startsWith("gsk_")) {
    return "groq";
  }
  return "xai";
}

function getAiModel() {
  if (getAiProvider() === "groq") {
    return env("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct");
  }
  return env("XAI_MODEL", "grok-4.3");
}

function getAiKey() {
  if (getAiProvider() === "groq") {
    return env("GROQ_API_KEY") || env("XAI_API_KEY");
  }
  return env("XAI_API_KEY");
}

function env(key, fallback = "") {
  return process.env[key] || fallback;
}

function base64Url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
