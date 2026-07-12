export function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M4 6h8" />
        <path d="M4 12h16" />
        <path d="M12 18h8" />
      </g>
      <circle
        cx="16"
        cy="6"
        r="2.25"
        fill="var(--paper)"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle
        cx="9"
        cy="12"
        r="2.25"
        fill="var(--paper)"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle
        cx="8"
        cy="18"
        r="2.25"
        fill="var(--paper)"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="9" y="9" width="10" height="10" rx="1.8" />
        <path d="M15 9V7.4c0-.9-.7-1.6-1.6-1.6H7.4c-.9 0-1.6.7-1.6 1.6v6c0 .9.7 1.6 1.6 1.6H9" />
      </g>
    </svg>
  );
}
