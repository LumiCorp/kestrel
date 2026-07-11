import type { SVGProps } from "react";

export const Logo = (_props: SVGProps<SVGSVGElement>) => (
  <svg
    aria-label="Logo"
    className="h-5 w-5"
    fill="none"
    height="45"
    viewBox="0 0 60 45"
    width="60"
    xmlns="http://www.w3.org/2000/svg"
  >
    <title>Logo</title>
    <path
      className="fill-black dark:fill-white"
      clipRule="evenodd"
      d="M0 0H15V15H30V30H15V45H0V30V15V0ZM45 30V15H30V0H45H60V15V30V45H45H30V30H45Z"
      fillRule="evenodd"
    />
  </svg>
);
