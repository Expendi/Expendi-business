import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A WebAuthn authenticator in software: a P-256 key that answers
 * registration and approval challenges exactly as a phone's passkey would.
 * Tests use it, and so does the Checkpoint B payout script, standing in
 * for the test admin's fingerprint. Never ship it in an app.
 */

export interface SoftwarePasskeyState {
  readonly credentialId: string;
  /** PKCS8 DER, base64. */
  readonly privateKey: string;
  readonly counter: number;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

const sha256 = (data: Uint8Array | string): Buffer =>
  createHash("sha256").update(data).digest();

const uint32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

export class SoftwarePasskey {
  private counter: number;

  private constructor(
    readonly credentialId: string,
    private readonly privateKeyDer: Buffer,
    counter: number,
  ) {
    this.counter = counter;
  }

  static create(): SoftwarePasskey {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return new SoftwarePasskey(
      isoBase64URL.fromBuffer(randomBytes(16)),
      privateKey.export({ format: "der", type: "pkcs8" }),
      0,
    );
  }

  static restore(state: SoftwarePasskeyState): SoftwarePasskey {
    return new SoftwarePasskey(
      state.credentialId,
      Buffer.from(state.privateKey, "base64"),
      state.counter,
    );
  }

  toJSON(): SoftwarePasskeyState {
    return {
      credentialId: this.credentialId,
      privateKey: this.privateKeyDer.toString("base64"),
      counter: this.counter,
    };
  }

  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    origin: string,
  ): RegistrationResponseJSON {
    const clientDataJSON = JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    });
    const credentialId = isoBase64URL.toBuffer(this.credentialId);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(credentialId.length);
    const authenticatorData = Buffer.concat([
      sha256(options.rp.id ?? ""),
      Buffer.from([
        FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_CREDENTIAL,
      ]),
      uint32(this.counter),
      Buffer.alloc(16),
      credentialIdLength,
      credentialId,
      this.coseKey(),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ["fmt", "none"],
        ["attStmt", new Map<string, string>()],
        ["authData", new Uint8Array(authenticatorData)],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromUTF8String(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  sign(
    options: PublicKeyCredentialRequestOptionsJSON,
    origin: string,
  ): AuthenticationResponseJSON {
    this.counter += 1;
    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    });
    const authenticatorData = Buffer.concat([
      sha256(options.rpId ?? ""),
      Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED]),
      uint32(this.counter),
    ]);
    const signature = createSign("SHA256")
      .update(Buffer.concat([authenticatorData, sha256(clientDataJSON)]))
      .sign({ key: this.privateKeyDer, format: "der", type: "pkcs8" });
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromUTF8String(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
        signature: isoBase64URL.fromBuffer(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** The public key as a COSE EC2 / ES256 map. */
  private coseKey(): Uint8Array {
    const jwk = createPublicKey(
      createPrivateKey({
        key: this.privateKeyDer,
        format: "der",
        type: "pkcs8",
      }),
    ).export({ format: "jwk" });
    if (!jwk.x || !jwk.y) throw new Error("P-256 key without coordinates");
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x)],
        [-3, isoBase64URL.toBuffer(jwk.y)],
      ]),
    );
  }
}
