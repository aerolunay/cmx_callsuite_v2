import { useEffect, useState } from "react";
import { api } from "../api";
import packageJson from "../../package.json";

const FRONTEND_VERSION = packageJson.version;

/*
==================================================
useAppVersion
==================================================
Per explicit request — shown on the login page and in the header, as
"<frontend package.json version>-<backend package.json version>".
Frontend's own version is known at build time (bundled directly from
package.json); backend's isn't known until runtime, hence the fetch.

Returns null until the backend version has actually loaded, so
callers can render nothing (or a placeholder) rather than a
half-formed "0.0.0-" string during that brief window.
==================================================
*/
export function useAppVersion() {
  const [backendVersion, setBackendVersion] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getVersion()
      .then((data) => {
        if (!cancelled) setBackendVersion(data.version);
      })
      .catch(() => {
        // Fails open — a missing version string is cosmetic only,
        // never worth surfacing as an error to the user.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!backendVersion) return null;
  return `${FRONTEND_VERSION}-${backendVersion}`;
}
