// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen.
//
// Two transports, same action names and payloads:
//  - Muse hosting (default): the SDK client POSTs `{action, args}` to
//    `./actions`, served by the space runtime.
//  - Cloudflare hosting: when the hosting page sets
//    `window.__HAMSTER_API_BASE__` before this module loads (the CF
//    Pages index does: `"/api"` — same-origin prefix preferred, a full
//    Worker origin also works), calls go to `${base}/<actionName>` with
//    the args object as the JSON body, and the Worker answers with the
//    bare result JSON (or `{error}` with a non-2xx status).
//
// `import type { Actions }` is type-only by design: the client bundle
// never pulls in any server runtime. With `verbatimModuleSyntax: true`,
// dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import { createActionClient } from "@hatch/space-sdk/client";

declare global {
  interface Window {
    /** Set by the Cloudflare Pages host page only; absent under Muse. */
    __HAMSTER_API_BASE__?: string;
  }
}

type SdkApi = ReturnType<typeof createActionClient<typeof Actions>>;

function createHttpApi(base: string): SdkApi {
  const trimmed = base.replace(/\/+$/, "");
  const call = async (action: string, args: unknown): Promise<unknown> => {
    const res = await fetch(`${trimmed}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON response — handled by the status check below
    }
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `请求失败 (${res.status})`;
      throw new Error(message);
    }
    if (body && typeof body === "object" && "error" in body && (body as { error: unknown }).error) {
      throw new Error(String((body as { error: unknown }).error));
    }
    return body;
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return (args: unknown) => call(prop, args);
      },
    },
  ) as SdkApi;
}

const cfBase =
  typeof window !== "undefined" && typeof window.__HAMSTER_API_BASE__ === "string"
    ? window.__HAMSTER_API_BASE__.trim()
    : "";

export const api: SdkApi = cfBase ? createHttpApi(cfBase) : createActionClient<typeof Actions>();

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
//
// They are also available directly from "@hatch/space-sdk/client".
export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
