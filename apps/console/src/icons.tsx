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
        {...props}
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    );
  };
}

export const HomeIcon = icon(`<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9"/>`);
export const BotIcon = icon(
  `<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>`,
);
export const BellIcon = icon(
  `<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/>`,
);
export const HashIcon = icon(
  `<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>`,
);
export const GlobeIcon = icon(
  `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`,
);
export const ChevronDownIcon = icon(`<path d="M6 9l6 6 6-6"/>`);
export const PauseIcon = icon(`<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>`);
export const PlayIcon = icon(`<path d="M7 4.5v15l13-7.5-13-7.5Z"/>`);
export const SkullIcon = icon(
  `<path d="M12 4a7 7 0 0 0-7 7c0 2.5 1.2 4 2.2 5.2.5.6.8 1 .8 1.6V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1.2c0-.6.3-1 .8-1.6C17.8 15 19 13.5 19 11a7 7 0 0 0-7-7Z"/><circle cx="9.5" cy="11" r="1.2"/><circle cx="14.5" cy="11" r="1.2"/><path d="M10 20v1M14 20v1"/>`,
);
export const XIcon = icon(`<path d="M6 6l12 12M18 6 6 18"/>`);
export const PlusIcon = icon(`<path d="M12 5v14M5 12h14"/>`);
export const SearchIcon = icon(`<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`);
export const CopyIcon = icon(
  `<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"/>`,
);
export const CheckIcon = icon(`<path d="M5 12.5l4.5 4.5L19 7"/>`);
export const InboxIcon = icon(
  `<path d="M4 12h4l2 3h4l2-3h4"/><path d="M5.5 5h13l2.5 7v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7l2.5-7Z"/>`,
);
export const DocsIcon = icon(
  `<path d="M7 3.5A1.5 1.5 0 0 1 8.5 5v14a1.5 1.5 0 0 1-1.5 1.5"/><path d="M8.5 5H15a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8.5"/><path d="M10 8h5M10 12h5M10 16h4"/>`,
);
