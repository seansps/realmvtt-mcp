/** Errors raised by the Realm VTT REST layer, shaped so tool handlers can turn a
 *  failure into something the model can act on rather than a dead end. */

/** A non-2xx response from the API. */
export class ApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;

  constructor(status: number, message: string, method: string, url: string) {
    super(`API ${status}: ${message} [${method} ${url}]`);
    this.name = "ApiError";
    this.status = status;
    this.method = method;
    this.url = url;
  }
}

/** No usable credential, or the one we had is expired/rejected. The message is
 *  addressed to the MODEL: it names the tool that fixes the situation, so an agent
 *  recovers on its own instead of reporting a broken server to the user. */
export class AuthRequiredError extends Error {
  constructor(reason: string) {
    super(
      `${reason} Call the \`realm_login\` tool — it opens a Realm VTT sign-in page in the ` +
        `user's browser and stores the token. Then retry this call.`,
    );
    this.name = "AuthRequiredError";
  }
}

/** True when a failure means "the credential is no good", not "the request was wrong".
 *  A Feathers service rejects an expired/absent JWT with 401; 403 means authenticated
 *  but not permitted, which re-authenticating would NOT fix. */
export function isAuthFailure(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Add the context that makes a Realm API rejection actionable. The backend's own
 *  messages are terse and a couple of them are actively misleading about the cause. */
export function explainApiError(err: ApiError): string {
  const base = err.message;
  if (err.status === 403 && /Must query by/i.test(base)) {
    return (
      `${base}\n\nThis service requires a campaign scope on every read. Pass a ` +
      `campaign (id or invite code), or call \`realm_use_campaign\` first to set a default.`
    );
  }
  if (err.status === 404) {
    return `${base}\n\nThe id or path does not exist — check the id, and that it belongs to this campaign.`;
  }
  if (err.status === 400) {
    return (
      `${base}\n\nThe payload or query failed schema validation. Realm services accept only ` +
      `whitelisted query fields; unknown properties are rejected outright rather than ignored.`
    );
  }
  return base;
}
