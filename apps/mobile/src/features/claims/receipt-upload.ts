import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { FileSystemUploadType, uploadAsync } from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

import type { ReceiptUploadRequest } from "@expendi-business/shared";
import { receiptUploadResponseSchema } from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import { describeApiError } from "~/lib/api";
import { RECEIPT_JPEG_QUALITY, receiptResize, toHex } from "./receipt-image";

export interface ReceiptImage {
  uri: string;
  width: number;
  height: number;
}

export type ReceiptSource = "camera" | "library";

export type PickResult =
  | { status: "picked"; image: ReceiptImage }
  | { status: "cancelled" }
  | { status: "no-camera-access" };

export async function pickReceiptImage(
  source: ReceiptSource,
): Promise<PickResult> {
  let result: ImagePicker.ImagePickerResult;
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { status: "no-camera-access" };
    result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1,
    });
  } else {
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
    });
  }
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return { status: "cancelled" };
  return {
    status: "picked",
    image: { uri: asset.uri, width: asset.width, height: asset.height },
  };
}

async function shrinkToJpeg(image: ReceiptImage): Promise<string> {
  const context = ImageManipulator.manipulate(image.uri);
  const resize = receiptResize(image);
  if (resize) context.resize(resize);
  const rendered = await context.renderAsync();
  try {
    const saved = await rendered.saveAsync({
      compress: RECEIPT_JPEG_QUALITY,
      format: SaveFormat.JPEG,
    });
    return saved.uri;
  } finally {
    rendered.release();
    context.release();
  }
}

export class ReceiptUploadError extends Error {
  override readonly name = "ReceiptUploadError";
}

const notReadable = "Couldn’t read that image. Try another one.";
const notUploaded =
  "The photo didn’t upload. Check your connection and try again.";

async function prepare(
  image: ReceiptImage,
): Promise<{ uri: string; bytes: Uint8Array; sha256: string }> {
  try {
    const uri = await shrinkToJpeg(image);
    const bytes = await new File(uri).bytes();
    const digest = await Crypto.digest(
      Crypto.CryptoDigestAlgorithm.SHA256,
      bytes,
    );
    return { uri, bytes, sha256: toHex(digest) };
  } catch (cause) {
    throw new ReceiptUploadError(notReadable, { cause });
  }
}

async function put(url: string, uri: string, contentType: string) {
  try {
    return await uploadAsync(url, uri, {
      httpMethod: "PUT",
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": contentType },
    });
  } catch (cause) {
    throw new ReceiptUploadError(notUploaded, { cause });
  }
}

export interface UploadedReceipt {
  receiptFileId: string;
  previewUri: string;
}

/**
 * Shrinks the image to a JPEG, hashes it for the duplicate check, then puts
 * it straight into the company's storage through the URL the API signs. The
 * signature pins the type and size, so both must match what was declared.
 */
export async function uploadReceiptImage(
  api: ApiClient,
  organizationId: string,
  image: ReceiptImage,
  source: ReceiptSource,
): Promise<UploadedReceipt> {
  const { uri, bytes, sha256 } = await prepare(image);
  const request: ReceiptUploadRequest = {
    contentType: "image/jpeg",
    byteSize: bytes.byteLength,
    sha256,
    kind: source === "camera" ? "photo" : "screenshot",
  };
  const upload = await api.post(
    `/organizations/${organizationId}/receipts/upload-url`,
    request,
    receiptUploadResponseSchema,
  );
  const result = await put(upload.uploadUrl, uri, request.contentType);
  if (result.status < 200 || result.status >= 300) {
    throw new ReceiptUploadError(notUploaded);
  }
  return { receiptFileId: upload.receiptFileId, previewUri: uri };
}

export function describeReceiptError(error: unknown): string {
  return error instanceof ReceiptUploadError
    ? error.message
    : describeApiError(error);
}
