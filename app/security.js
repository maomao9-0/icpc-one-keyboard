import { state } from "./state.js";

export function createClientKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sessionPayload(action, extra = {}) {
  return {
    action,
    code: state.identity.code,
    clientId: state.identity.clientId,
    clientKey: state.identity.clientKey,
    ...extra,
  };
}

export function sessionQuery() {
  return new URLSearchParams({
    code: state.identity.code,
    clientId: state.identity.clientId,
    clientKey: state.identity.clientKey,
  });
}
