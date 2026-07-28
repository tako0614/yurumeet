const YURUMEET_PERMISSIONS_POLICY =
  "camera=(self), microphone=(), geolocation=()";

export function allowHttpsMedia(csp: string): string {
  const directives = csp
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean);
  const mediaIndex = directives.findIndex(
    (directive) =>
      directive === "media-src" || directive.startsWith("media-src "),
  );
  if (mediaIndex < 0) return csp;

  const tokens = directives[mediaIndex].split(/\s+/);
  if (!tokens.includes("https:")) tokens.push("https:");
  directives[mediaIndex] = tokens.join(" ");
  return directives.join("; ");
}

export function withYurumeetDocumentPolicy(response: Response): Response {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Permissions-Policy", YURUMEET_PERMISSIONS_POLICY);
  const csp = headers.get("Content-Security-Policy");
  if (csp) headers.set("Content-Security-Policy", allowHttpsMedia(csp));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
