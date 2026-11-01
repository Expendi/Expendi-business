import "./secrets/bootstrap.js";

// Dynamic on purpose: static imports would evaluate (and could read env)
// before the asynchronous Doppler bootstrap above has finished.
await import("./server.js");
