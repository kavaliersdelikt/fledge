import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

/** True when this browser can do passkeys (needs a secure context: https or localhost). */
export function passkeysSupported(): boolean {
  try {
    return typeof window !== "undefined" && window.isSecureContext !== false && browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Why passkeys can't be used here, for a Notice. */
export function passkeyUnsupportedReason(): string {
  if (typeof window !== "undefined" && window.isSecureContext === false)
    return "Passkeys only work on pages opened over https (or on localhost). Open the panel over https to use them.";
  return "This browser doesn’t support passkeys.";
}

// The API may answer with the options directly or wrapped in { publicKey }.
const unwrap = (o: any) => (o && typeof o === "object" && o.publicKey && !o.challenge ? o.publicKey : o);

export const askPasskey = (options: unknown) => startAuthentication({ optionsJSON: unwrap(options) });
export const makePasskey = (options: unknown) => startRegistration({ optionsJSON: unwrap(options) });

/** A readable sentence for a failed browser ceremony. `cancelled` means the person simply dismissed it. */
export function passkeyProblem(e: unknown, doing: "sign in" | "register"): { cancelled: boolean; message: string } {
  const err = e as { name?: string; code?: string; message?: string };
  const code = err?.code;
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED")
    return { cancelled: false, message: "This device or security key already has a passkey for Fledge." };
  if (code === "ERROR_INVALID_RP_ID" || code === "ERROR_INVALID_DOMAIN")
    return { cancelled: false, message: "Passkeys don’t work on this address. Open the panel through the domain name it is set up with, over https." };
  if (err?.name === "NotAllowedError" || code === "ERROR_CEREMONY_ABORTED" || err?.name === "AbortError")
    return {
      cancelled: true,
      message: doing === "sign in" ? "Passkey sign-in was cancelled or timed out. Try again." : "Passkey setup was cancelled or timed out.",
    };
  if (err?.name === "NotSupportedError")
    return { cancelled: false, message: "This device can’t create that kind of passkey." };
  return { cancelled: false, message: err?.message || `Could not ${doing === "sign in" ? "sign in" : "register"} with a passkey.` };
}
