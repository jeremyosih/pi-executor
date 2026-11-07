import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

type PersistedOAuthState = {
  clientInformation?: OAuthClientInformationMixed;
  registeredRedirectUrl?: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
};

export type ExecutorOAuthProviderOptions = {
  serverUrl: string;
  storageRoot: string;
  redirectUrl: string | URL;
  state: string;
  redirectToAuthorization: (url: URL) => void | Promise<void>;
};

const readState = async (path: string): Promise<PersistedOAuthState> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PersistedOAuthState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

export const createExecutorOAuthProvider = (options: ExecutorOAuthProviderOptions) => {
  const origin = new URL(options.serverUrl).origin;
  const fileName = `${createHash("sha256").update(origin).digest("hex")}.json`;
  const statePath = join(options.storageRoot, fileName);

  const updateState = async (update: Partial<PersistedOAuthState>): Promise<void> => {
    await mkdir(options.storageRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(options.storageRoot, 0o700);
    }
    const state = { ...(await readState(statePath)), ...update };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(statePath, 0o600);
    }
  };

  const clientMetadata: OAuthClientMetadata = {
    client_name: "Pi Executor",
    redirect_uris: [String(options.redirectUrl)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  return {
    get redirectUrl() {
      return options.redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    state: () => options.state,
    clientInformation: async () => {
      const state = await readState(statePath);
      const clientInformation = state.clientInformation;
      const registeredRedirectUrl =
        state.registeredRedirectUrl ??
        (clientInformation && "redirect_uris" in clientInformation
          ? clientInformation.redirect_uris?.[0]
          : undefined);
      if (registeredRedirectUrl && registeredRedirectUrl !== String(options.redirectUrl)) {
        return undefined;
      }
      return clientInformation;
    },
    saveClientInformation: async (clientInformation: OAuthClientInformationMixed) =>
      updateState({
        clientInformation,
        registeredRedirectUrl: String(options.redirectUrl),
      }),
    tokens: async () => (await readState(statePath)).tokens,
    saveTokens: async (tokens: OAuthTokens) => updateState({ tokens, codeVerifier: undefined }),
    codeVerifier: async () => {
      const verifier = (await readState(statePath)).codeVerifier;
      if (!verifier) {
        throw new Error("OAuth PKCE verifier is missing; restart authentication.");
      }
      return verifier;
    },
    saveCodeVerifier: async (codeVerifier: string) => updateState({ codeVerifier }),
    redirectToAuthorization: options.redirectToAuthorization,
    invalidateCredentials: async (
      scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ) => {
      if (scope === "all") {
        await updateState({
          clientInformation: undefined,
          tokens: undefined,
          codeVerifier: undefined,
        });
      } else if (scope === "client") {
        await updateState({ clientInformation: undefined });
      } else if (scope === "tokens") {
        await updateState({ tokens: undefined });
      } else if (scope === "verifier") {
        await updateState({ codeVerifier: undefined });
      }
    },
  };
};
