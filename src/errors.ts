import { Data } from "effect";

// githog's typed domain errors. IO/subprocess failures are deliberately NOT
// modelled here — like the scripts this generalizes, those are dev-tooling
// defects (Effect.orDie). These tagged errors are the few conditions an
// operator can actually act on: a missing/!malformed config, a service that
// never came up, an unusable database/identifier.

// The project has no githog.config.ts, or it does not call defineConfig.
export class ConfigNotFound extends Data.TaggedError("ConfigNotFound")<{
  readonly searchedFrom: string;
  readonly detail: string;
}> {}

// A config field is present but structurally wrong (e.g. a port base that is
// not a number). Functions are trusted via defineConfig's typing; this covers
// the serializable data we still validate at runtime.
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly path: string;
  readonly reason: string;
}> {}

// A TCP service (e.g. Postgres) was unreachable and could not be started.
export class ServiceUnavailable extends Data.TaggedError("ServiceUnavailable")<{
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly detail: string;
}> {}
