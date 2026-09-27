export const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;

const formats = {
  "image/jpeg": { extension: "jpg", signature: [0xff, 0xd8, 0xff] },
  "image/png": {
    extension: "png",
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  "image/webp": { extension: "webp", signature: [] },
} as const;

export function validatedImageType(
  mime: string,
  bytes: Uint8Array,
): { mime: keyof typeof formats; extension: string } | null {
  if (!(mime in formats)) return null;
  if (mime === "image/webp") {
    if (
      bytes.length < 12 ||
      String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
      String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
    )
      return null;
  } else {
    const signature = formats[mime as "image/jpeg" | "image/png"].signature;
    if (!signature.every((byte, i) => bytes[i] === byte)) return null;
  }
  return {
    mime: mime as keyof typeof formats,
    extension: formats[mime as keyof typeof formats].extension,
  };
}
