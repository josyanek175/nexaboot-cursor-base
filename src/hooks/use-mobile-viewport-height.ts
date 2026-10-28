import { useEffect, useState } from "react";

/** Keep the app inside the visible area when a mobile keyboard opens. */
export function useMobileViewportHeight(desktopBreakpoint = 1024) {
  const [height, setHeight] = useState<number | undefined>();
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      if (window.innerWidth >= desktopBreakpoint) setHeight(undefined);
      else if (!viewport || viewport.scale === 1)
        setHeight(Math.round(viewport?.height ?? window.innerHeight));
    };
    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
    };
  }, [desktopBreakpoint]);
  return height;
}
