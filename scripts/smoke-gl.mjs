#!/usr/bin/env node
// Starts no processes itself. With Vite and Chromium remote debugging already
// running, exercise the opt-in WebGL renderer and fail on a browser exception.
// Usage: node scripts/smoke-gl.mjs http://127.0.0.1:5173 /absolute/DOOM2.WAD
const [baseUrl, wadPath] = process.argv.slice(2);

if (!baseUrl || !wadPath) {
  throw new Error("Usage: node scripts/smoke-gl.mjs <vite-url> <absolute-wad-path>");
}

const targetResponse = await fetch("http://127.0.0.1:9222/json/new?" + encodeURIComponent(`${baseUrl}?renderer=gl`), {
  method: "PUT",
});
if (!targetResponse.ok) throw new Error(`Could not create Chromium target: ${targetResponse.status}`);

const { webSocketDebuggerUrl } = await targetResponse.json();
const socket = new WebSocket(webSocketDebuggerUrl);
const messages = [];
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    messages.push(details.exception?.description ?? details.exception?.value ?? details.text);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    const text = message.params.args.map((arg) => arg.value ?? arg.description).join(" ");
    // The engine restores its default timing before D_DoomLoop has installed
    // Emscripten's loop. It is unrelated to GL startup and pre-dates M6.
    if (!text.includes("emscripten_set_main_loop_timing: Cannot set timing mode")) messages.push(text);
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

await send("Runtime.enable");
await send("DOM.enable");
let nodeId = 0;
const deadline = Date.now() + 10_000;
while (!nodeId && Date.now() < deadline) {
  try {
    const { root } = await send("DOM.getDocument");
    ({ nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file-input" }));
  } catch {
    // Vite can replace the document while its client connects. Retry with a
    // fresh root instead of retaining an invalid node id.
    nodeId = 0;
  }
  if (!nodeId) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!nodeId) {
  const { root } = await send("DOM.getDocument");
  const { outerHTML } = await send("DOM.getOuterHTML", { nodeId: root.nodeId });
  throw new Error(`WAD file input was not found after page load. Document: ${outerHTML.slice(0, 500)}`);
}
await send("DOM.setFileInputFiles", { files: [wadPath], nodeId });
await new Promise((resolve) => setTimeout(resolve, 250));

const clicked = await send("Runtime.evaluate", {
  expression: 'document.querySelector("#start")?.click()',
  awaitPromise: true,
});
if (clicked.exceptionDetails) throw new Error(clicked.exceptionDetails.text);

await new Promise((resolve) => setTimeout(resolve, 8000));
socket.close();

if (messages.length > 0) {
  throw new Error(`Browser reported errors:\n${messages.join("\n")}`);
}
