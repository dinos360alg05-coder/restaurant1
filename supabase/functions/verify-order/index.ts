import { errorResponse, json, preflight, requireUser, serviceClient } from "../_shared/http.ts";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromBytea(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/.{2}/g)!.map((pair) => parseInt(pair, 16)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(key: CryptoKey, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

const bytea = (hex: string) => `\\x${hex}`;

Deno.serve(async (request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const user = await requireUser(request);
    if ((user as typeof user & { is_anonymous?: boolean }).is_anonymous !== true) {
      return json({ error: "customer_session_required" }, 401);
    }

    const body = await request.json();
    const orderText = typeof body?.order_number === "string" ? body.order_number.trim() : String(body?.order_number ?? "");
    const code = typeof body?.access_code === "string" ? body.access_code.trim() : "";
    if (!/^\d{1,3}$/.test(orderText) || Number(orderText) < 1 || Number(orderText) > 999 || !/^\d{6}$/.test(code)) {
      return json({ error: "verification_failed" });
    }

    const pepper = Deno.env.get("TRACKING_CODE_PEPPER");
    if (!pepper || pepper.length < 32) throw new Error("server_configuration_missing");
    const pepperKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const admin = serviceClient();
    const orderNumber = Number(orderText);
    const { data: materialData, error: materialError } = await admin.rpc("get_order_verification_material", {
      p_order_number: orderNumber,
    });
    if (materialError) throw materialError;
    const material = Array.isArray(materialData) ? materialData[0] : materialData;
    const salt = fromBytea(material?.code_salt) || crypto.getRandomValues(new Uint8Array(16));
    const storedDigest = fromBytea(material?.code_digest) || crypto.getRandomValues(new Uint8Array(32));
    const candidateDigest = await hmac(pepperKey, `${bytesToHex(salt)}:${code}`);
    const candidateValid = !!material && constantTimeEqual(candidateDigest, storedDigest);

    const sourceIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("cf-connecting-ip")
      || request.headers.get("x-real-ip")
      || `unavailable:${user.id}`;
    const ipHash = await hmac(pepperKey, `tracking-ip:${sourceIp}`);
    const rawToken = crypto.getRandomValues(new Uint8Array(32));
    const token = toBase64Url(rawToken);
    const tokenHash = await digestHex(rawToken);

    const { data: attemptData, error: attemptError } = await admin.rpc("record_tracking_verification", {
      p_order_number: orderNumber,
      p_expected_order_id: material?.order_id ?? null,
      p_auth_user_id: user.id,
      p_ip_hash: bytea(bytesToHex(ipHash)),
      p_candidate_valid: candidateValid,
      p_code_version: material?.code_version ?? null,
      p_token_hash: bytea(tokenHash),
    });
    if (attemptError) throw attemptError;
    const result = Array.isArray(attemptData) ? attemptData[0] : attemptData;
    if (!result?.verified) return json({ error: "verification_failed" });

    return json({ tracking_token: token });
  } catch (error) {
    return errorResponse(error);
  }
});
