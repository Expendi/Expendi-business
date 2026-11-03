import Image from "next/image";

/** Expendi Expo app mark, with transparent app-icon padding trimmed. */
export function BrandMark() {
  return (
    <Image
      src="/expendi-mark.png"
      alt=""
      width={32}
      height={32}
      className="shrink-0"
    />
  );
}
