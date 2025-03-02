// solc-worker.js
// Import solc in the worker context. Use the UMD build that works in workers.
importScripts("https://cdn.jsdelivr.net/npm/solc/solc.min.js");

onmessage = function (e) {
  const input = e.data;
  try {
    // Compile synchronously inside the worker thread.
    // This synchronous compile is acceptable in a worker.
    const output = solc.compile(JSON.stringify(input));
    postMessage({ output });
  } catch (err) {
    postMessage({ error: err.message });
  }
};
