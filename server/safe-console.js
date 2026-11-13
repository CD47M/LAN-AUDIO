'use strict';
// Keeps console logging safe for GUI-subsystem builds where stdout may be
// unavailable or closed. Intended to be required first by the server.

const noop = () => {};

function safeWrap(name) {
  const original = console[name] ? console[name].bind(console) : noop;
  console[name] = (...args) => {
    try {
      original(...args);
    } catch {
      /* stdout unavailable (GUI subsystem / no console) */
    }
  };
}

for (const name of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  safeWrap(name);
}

// Writing to a closed stdout can still throw asynchronously on Windows.
process.stdout.on?.('error', noop);
process.stderr.on?.('error', noop);

module.exports = {};
