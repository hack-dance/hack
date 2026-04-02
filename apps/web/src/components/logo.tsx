export function Logo({
  className,
  decorative = false,
}: {
  readonly className?: string;
  readonly decorative?: boolean;
}) {
  return (
    <svg
      aria-hidden={decorative}
      aria-label={decorative ? undefined : "Hack"}
      className={className}
      role={decorative ? "presentation" : "img"}
      viewBox="0 0 47.62 47.62"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className="currentColor"
        d="M9.46,43.13l10.84-10.84v15.33s7.03,0,7.03,0v-15.33s10.84,10.84,10.84,10.84l4.97-4.97-10.84-10.84h15.33s0-7.03,0-7.03h-14.32s-6.23,6.23-6.23,6.23c-.33.33-.69.59-1.08.8-.37.2-.76.34-1.16.43-.67.15-1.37.15-2.05,0-.4-.09-.79-.23-1.16-.43-.39-.21-.75-.47-1.08-.8l-6.23-6.23H0v7.03h15.33l-10.84,10.84,4.97,4.97Z"
      />
      <path
        className="currentColor"
        d="M26.06,15.58l1.26-1.26V0h-7.03s0,14.32,0,14.32l1.26,1.26c1.24,1.24,3.27,1.24,4.51,0Z"
      />
      <path
        className="currentColor"
        d="M23.81,26.44h0c.69,0,1.39-.23,1.96-.68.1-.08.2-.16.29-.26l16.05-16.05-3.96-3.96-11.09,11.09c-.64.64-1.42,1.05-2.24,1.23-.67.15-1.37.15-2.05,0-.82-.19-1.6-.59-2.24-1.23L9.46,5.5l-3.96,3.96,16.05,16.05c.09.09.19.18.29.26.57.45,1.27.68,1.96.68Z"
      />
    </svg>
  );
}
