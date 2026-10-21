import { useEffect, useState } from "react";

/** True only after `active` has stayed true for `delay` ms. Avoids a skeleton flash. */
export function useDelayed(active: boolean, delay = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);
  return shown;
}
