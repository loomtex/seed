// Identity view — register FIDO token, view public key.
import { register, getIdentity, clearCredential, hasCredential } from "../auth.js";

export async function renderIdentity(el) {
  const registered = await hasCredential();

  if (!registered) {
    el.innerHTML = `
      <h2>Identity</h2>
      <p class="text-muted">
        Register a FIDO key to sign git operations from this browser.
        No private key material is stored — your token derives the signing
        key at authentication time via the WebAuthn PRF extension.
      </p>
      <button id="register-btn" class="btn">Register FIDO key</button>
      <div id="auth-error" class="error hidden"></div>
    `;
    el.querySelector("#register-btn").onclick = handleRegister;
    return;
  }

  // Credential exists — try to derive public key (needs token touch)
  el.innerHTML = `
    <h2>Identity</h2>
    <p class="text-muted">Touch your FIDO key to derive your public key.</p>
    <div class="spinner"></div>
  `;

  try {
    const identity = await getIdentity();
    renderRegistered(el, identity);
  } catch (err) {
    el.innerHTML = `
      <h2>Identity</h2>
      <p class="text-muted">
        A FIDO credential is registered but the key could not be derived.
        Insert your token and reload, or re-register.
      </p>
      <button id="clear-btn" class="btn btn-danger">Remove credential</button>
      <div id="auth-error" class="error">${esc(err.message)}</div>
    `;
    el.querySelector("#clear-btn").onclick = handleClear;
  }
}

function renderRegistered(el, identity) {
  if (!identity?.publicKey) {
    el.innerHTML = `
      <h2>Identity</h2>
      <p class="text-muted">Insert your FIDO token and reload to see your public key.</p>
      <button id="clear-btn" class="btn btn-danger">Remove credential</button>
    `;
    el.querySelector("#clear-btn").onclick = handleClear;
    return;
  }

  el.innerHTML = `
    <h2>Identity</h2>
    <p class="text-muted">
      Your signing identity, derived from your FIDO token.
      Add this public key to a repo's <code>.authorized_keys</code> to authorize pushes.
    </p>
    <div class="key-display">
      <label>Public key (authorized_keys format)</label>
      <pre id="pubkey">${esc(identity.authorizedKeys)}</pre>
      <button id="copy-btn" class="btn btn-sm">Copy</button>
    </div>
    <hr>
    <button id="clear-btn" class="btn btn-danger">Remove credential</button>
  `;

  el.querySelector("#copy-btn").onclick = () => {
    navigator.clipboard.writeText(identity.authorizedKeys);
    const btn = el.querySelector("#copy-btn");
    btn.textContent = "Copied";
    setTimeout(() => btn.textContent = "Copy", 2000);
  };
  el.querySelector("#clear-btn").onclick = handleClear;
}

async function handleRegister() {
  const errorEl = document.getElementById("auth-error");
  const btn = document.getElementById("register-btn");
  btn.disabled = true;
  btn.textContent = "Touch your key...";
  errorEl.classList.add("hidden");

  try {
    await register();
    // Re-render with the new identity
    await renderIdentity(document.getElementById("app"));
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Register FIDO key";
  }
}

async function handleClear() {
  await clearCredential();
  await renderIdentity(document.getElementById("app"));
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
