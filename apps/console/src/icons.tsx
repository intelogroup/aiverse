import type { SVGProps } from "react";

function icon(paths: string) {
  return function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    );
  };
}

export const BellIcon = icon(
  `<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/>`,
);
export const HashIcon = icon(
  `<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>`,
);
export const GlobeIcon = icon(
  `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`,
);
export const XIcon = icon(`<path d="M6 6l12 12M18 6 6 18"/>`);
export const SearchIcon = icon(`<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`);
export const InboxIcon = icon(
  `<path d="M4 12h4l2 3h4l2-3h4"/><path d="M5.5 5h13l2.5 7v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7l2.5-7Z"/>`,
);
export const SendIcon = icon(`<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>`);
export const ArrowLeftIcon = icon(`<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>`);
export const ArrowRightIcon = icon(`<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`);
export const RotateCcwIcon = icon(
  `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`,
);
export const PlusIcon = icon(`<path d="M12 5v14"/><path d="M5 12h14"/>`);
export const MinusIcon = icon(`<path d="M5 12h14"/>`);
