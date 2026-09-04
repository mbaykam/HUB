import type { ReactNode } from "react";

export interface MinkeBrandMarkProps {
  readonly size: number;
  readonly className?: string;
}

/** Exact HUB app mark projected into Harness brand slots. */
export function MinkeBrandMark({
  size,
  className,
}: MinkeBrandMarkProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        width="1024"
        height="1024"
        rx="224"
        fill="#f5f2ea"
      />
      <path
        fill="#0b0e17"
        d="M282 226c-22.1 0-40 17.9-40 40v492c0 22.1 17.9 40 40 40h80c22.1 0 40-17.9 40-40V590h220v168c0 22.1 17.9 40 40 40h80c22.1 0 40-17.9 40-40V266c0-22.1-17.9-40-40-40h-80c-22.1 0-40 17.9-40 40v164H402V266c0-22.1-17.9-40-40-40h-80Z"
      />
    </svg>
  );
}

export function MinkeBrandName(): ReactNode {
  return <span>HUB</span>;
}
