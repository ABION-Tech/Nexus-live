// The NEXUS logo, exactly as on the app icon (public/icon-192.png):
// "NEX" in the text colour, "US" in --accent2, Syne ExtraBold, with the
// ringed icon as the mark. One component so the sidebar, the phone top
// bar and the sign-in page can never drift apart again.
export function Logo({ size = 20, mark = false }: { size?: number; mark?: boolean }) {
  return (
    <span className="nx-logo" style={{ fontSize: size }} aria-label="NEXUS">
      {mark && <img className="nx-logo__mark" src="/icon-192.png" alt="" width={size * 1.5} height={size * 1.5} />}
      <span aria-hidden="true">
        NEX<span className="nx-logo__us">US</span>
      </span>
    </span>
  );
}
