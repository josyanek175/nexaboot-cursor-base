/** Worker bundles must never depend on a browser session or an HTTP request. */
function unavailable(): never {
  throw new Error("http_request_context_unavailable_in_worker");
}
export const getCookie = unavailable;
export const setCookie = unavailable;
export const deleteCookie = unavailable;
