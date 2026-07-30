import type { components, operations } from "./generated";
import type { ApiClient, ApiSuccess } from "./client";

export type MainProfileRecord = components["schemas"]["Profile"];
export type MainProfileUpdate =
  operations["updateProfile"]["requestBody"]["content"]["application/json"];
export type UsernameChange =
  operations["changeUsername"]["responses"][200]["content"]["application/json"]["data"];

export interface UsernameAvailability {
  username: string;
  available: boolean;
}

export function checkUsernameAvailability(
  api: ApiClient,
  username: string,
): Promise<ApiSuccess<UsernameAvailability>> {
  return api.get(`/v1/me/username-availability?username=${encodeURIComponent(username)}`);
}

export function changeUsername(
  api: ApiClient,
  username: string,
): Promise<ApiSuccess<UsernameChange>> {
  return api.post("/v1/me/username", { username });
}

export function updateMainProfile(
  api: ApiClient,
  input: MainProfileUpdate,
): Promise<ApiSuccess<MainProfileRecord>> {
  return api.patch("/v1/me/profile", input);
}
