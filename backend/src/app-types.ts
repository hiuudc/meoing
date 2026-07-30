import type { DomainRepository } from "./db/repository";
import type { RequestState } from "./types";

export type AppBindings = {
  Bindings: ApiEnv;
  Variables: {
    repository: DomainRepository;
    requestState: RequestState;
  };
};
