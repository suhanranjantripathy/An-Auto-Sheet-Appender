const form = document.querySelector("#uploadForm");
const input = document.querySelector("#screenshotInput");
const notes = document.querySelector("#notes");
const webhookToken = document.querySelector("#webhookToken");
const dropzone = document.querySelector("#dropzone");
const previewFrame = document.querySelector("#previewFrame");
const preview = document.querySelector("#preview");
const results = document.querySelector("#results");
const statusEl = document.querySelector("#status");
const modelBadge = document.querySelector("#modelBadge");
const submitButton = document.querySelector("#submitButton");
const headersButton = document.querySelector("#headersButton");

let selectedDataUrl = "";
let selectedFileName = "";

init();

async function init() {
  input.addEventListener("change", handleFileSelect);
  form.addEventListener("submit", handleSubmit);
  headersButton.addEventListener("click", appendHeaders);

  for (const eventName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragging");
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragging");
    });
  }

  dropzone.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    if (file) {
      setFile(file);
    }
  });

  await refreshConfig();
}

async function refreshConfig() {
  try {
    const config = await getJson("/api/config");
    modelBadge.textContent = config.model;
    statusEl.textContent = config.ready ? `Ready for ${config.sheetName} via ${config.appendMode}` : `Setup needed: ${config.missing.join(", ")}`;
    statusEl.className = `status ${config.ready ? "ready" : "needs-setup"}`;
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.className = "status needs-setup";
  }
}

async function handleFileSelect() {
  const [file] = input.files;
  if (file) {
    await setFile(file);
  }
}

async function setFile(file) {
  if (!file.type.startsWith("image/")) {
    showError("Choose an image file.");
    return;
  }
  selectedFileName = file.name;
  selectedDataUrl = await fileToDataUrl(file);
  preview.src = selectedDataUrl;
  preview.alt = selectedFileName;
  previewFrame.classList.add("has-image");
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!selectedDataUrl) {
    showError("Choose a screenshot first.");
    return;
  }

  setBusy(true, "Analyzing screenshot");
  try {
    const response = await postJson("/api/analyze-append", {
      imageDataUrl: selectedDataUrl,
      fileName: selectedFileName,
      notes: notes.value.trim(),
      googleAppsScriptToken: webhookToken.value.trim()
    });
    const appendedRows = response.appendResult?.appendedRows || response.rows?.length || 0;
    renderAnalysis(response.analysis, response.appendResult);
    statusEl.textContent = `Appended ${appendedRows} row${appendedRows === 1 ? "" : "s"} to sheet`;
    statusEl.className = "status ready";
  } catch (error) {
    showError(error.message);
    if (/already been entered|duplicate/i.test(error.message)) {
      window.alert("Warning: this data has already been entered.");
    }
  } finally {
    setBusy(false);
  }
}

async function appendHeaders() {
  setBusy(true, "Appending headers");
  try {
    const response = await postJson("/api/append-headers", {
      googleAppsScriptToken: webhookToken.value.trim()
    });
    const appendedRows = response.appendResult?.appendedRows || 1;
    statusEl.textContent = `Headers appended (${appendedRows} row)`;
    statusEl.className = "status ready";
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

function renderAnalysis(analysis, appendResult) {
  results.innerHTML = "";
  const appendedRows = appendResult?.appendedRows || 0;
  const lastRow = appendResult?.lastRow ? ` Last row: ${appendResult.lastRow}.` : "";
  const items = [
    ["Customer", analysis.customer_name],
    ["Phone", analysis.phone],
    ["Service date", analysis.service_date],
    ["Vehicle", `${analysis.vehicle_reg_no} · ${analysis.make_model} · ${analysis.variant}`, "wide"],
    ["Usage", `Avg km/mo: ${analysis.avg_km_month || "None found"} · Odo: ${analysis.odo_reading || "None found"}`],
    ["Service", analysis.type_of_service, "wide"],
    ["Tyres", (analysis.tyres || []).map((tyre) => `${tyre.position}: ${tyre.brand} ${tyre.tyre_name}, NSD ${tyre.nsd}, ${tyre.platform}, ${tyre.size}, ${tyre.fitment_year}`), "wide"],
    ["Confidence", `${Math.round(Number(analysis.confidence || 0) * 100)}%`],
    ["Sheet status", appendedRows ? `${appendedRows} rows appended successfully.${lastRow}` : "Not appended"]
  ];

  for (const [label, value, className = ""] of items) {
    const item = document.createElement("div");
    item.className = `result-item ${className}`;
    const title = document.createElement("strong");
    title.textContent = label;
    item.append(title);
    item.append(renderValue(value));
    results.append(item);
  }
}

function renderValue(value) {
  if (Array.isArray(value)) {
    const list = document.createElement("ul");
    const values = value.length ? value : ["None found"];
    for (const text of values) {
      const li = document.createElement("li");
      li.textContent = text;
      list.append(li);
    }
    return list;
  }
  const p = document.createElement("p");
  p.textContent = value || "None found";
  return p;
}

function showError(message) {
  statusEl.textContent = message;
  statusEl.className = "status needs-setup";
}

function setBusy(isBusy, label = "Working") {
  submitButton.disabled = isBusy;
  headersButton.disabled = isBusy;
  if (isBusy) {
    statusEl.textContent = label;
    statusEl.className = "status";
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || response.statusText);
  }
  return json;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || response.statusText);
  }
  return json;
}
