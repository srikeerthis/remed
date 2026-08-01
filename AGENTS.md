# Remed agent instructions

Read `CLAUDE.md` before changing code. It is the product and ownership source of truth for every coding assistant used in this repository.

Medplum's checked-out source and documentation are under `medplum-link/`. Before implementing Medplum or FHIR behavior, read the relevant file in `medplum-link/packages/docs/docs/` and prefer an existing Medplum implementation over generic FHIR knowledge. Medplum uses FHIR R4. Type every FHIR resource with `@medplum/fhirtypes`, use `@medplum/core` helpers, and never invent fields, operations, search parameters, or clinical codes.

Before finishing, run `npm run check`. Re-check security-sensitive changes, PHI handling, access policies, and `ProjectMembership` scopes manually.
