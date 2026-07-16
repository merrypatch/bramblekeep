import type en from "./locales/en.json";

// Typed translation keys: `t()` autocompletes and rejects unknown keys, using the
// English resource as the source of truth. Other languages must mirror its shape.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
