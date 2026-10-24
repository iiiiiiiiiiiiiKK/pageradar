import type { SVGProps } from 'react';

const s = (p: SVGProps<SVGSVGElement>) => ({
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
  ...p,
});

export const IconRadar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 12l5.5-5.5" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M20 11a8 8 0 10-2.6 6.4" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M4 7h16" />
    <path d="M9.5 7V5.2c0-.7.6-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7" />
    <path d="M6.5 7l.8 11.3c.05.9.8 1.7 1.8 1.7h5.8c1 0 1.75-.8 1.8-1.7L17.5 7" />
  </svg>
);

export const IconPause = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M9 5v14M15 5v14" />
  </svg>
);

export const IconPlay = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M8 5.5l11 6.5-11 6.5z" />
  </svg>
);

export const IconEdit = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M4 20h4l10-10a2.1 2.1 0 00-3-3L5 17z" />
    <path d="M13.5 6.5l3 3" />
  </svg>
);

export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false" {...p}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

export const IconGithub = (p: SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false" {...p}>
    <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.51 2.87 8.34 6.84 9.7.5.09.68-.22.68-.49 0-.24-.01-1.04-.01-1.89-2.78.62-3.37-1.22-3.37-1.22-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.72 0 0 .84-.28 2.75 1.05a9.3 9.3 0 015 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.14 10.14 0 0022 12.23C22 6.58 17.52 2 12 2z" />
  </svg>
);

export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M12 4.5l8.2 14.2H3.8z" />
    <path d="M12 10v4M12 16.6v.1" />
  </svg>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M4.5 12.5l4.5 4.5 10-10" />
  </svg>
);

export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconSun = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </svg>
);

export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M20 14.5A8.2 8.2 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
  </svg>
);

export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}>
    <path d="M9.5 14.5l5-5" />
    <path d="M13 6.5l1.6-1.6a3.6 3.6 0 015 5L18 11.5" />
    <path d="M11 17.5L9.4 19.1a3.6 3.6 0 01-5-5L6 12.5" />
  </svg>
);
