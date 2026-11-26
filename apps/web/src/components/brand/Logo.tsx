import Image from "next/image";
import { APP_NAME } from "@/lib/config";
import { cx } from "@/components/ui";

// Vector logo files live in public/brand. Both carry their own dark artwork,
// so they read on night and daylight backgrounds alike.

/** Square badge (engine, turbo and circuit traces). */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/brand/rootcause-badge.svg"
      alt=""
      width={size}
      height={size}
      unoptimized
      priority
      className={cx("shrink-0", className)}
    />
  );
}

/** Badge beside the product name, for the app shell. */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cx("flex items-center gap-2", className)}>
      <BrandMark size={32} />
      <span className="text-sm font-extrabold leading-tight tracking-tight">{APP_NAME}</span>
    </span>
  );
}

/** Full wordmark, for sign-in and other standalone pages. Aspect ratio 960:440. */
export function Wordmark({ width = 320, className }: { width?: number; className?: string }) {
  return (
    <Image
      src="/brand/rootcause-wordmark.svg"
      alt={APP_NAME}
      width={width}
      height={Math.round((width * 440) / 960)}
      unoptimized
      priority
      className={cx("h-auto max-w-full", className)}
    />
  );
}
